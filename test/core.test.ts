import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { parseCode, ParserCache, isSupportedFile } from "../src/core/parser.js";
import {
  assertRealPathInside,
  discoverFiles,
  isInside,
  PathEscapeError,
  resolveInsideRoot,
  toDisplayPath
} from "../src/core/files.js";
import { analyzeAllFunctions } from "../src/core/traverse.js";
import {
  buildFileCallGraph,
  countNameUsages,
  exportedSymbols,
  fileOutline,
  listSymbols,
  reexportedOriginNames,
  starReexportSources
} from "../src/core/extract.js";
import { ServerContext } from "../src/core/context.js";
import { CHARACTER_LIMIT, ResponseFormat, toolResult } from "../src/core/response.js";
import {
  expandEntryToSourceCandidates,
  resolvePackageEntryPoints,
  resolveRelativeSpecifier
} from "../src/core/entryPoints.js";
import { FIXTURE_ROOT, fixturePath } from "./helpers.js";

describe("parser", () => {
  it("parses valid TypeScript into an AST", () => {
    const result = parseCode("export const x: number = 1;", "x.ts");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ast.program.body).toHaveLength(1);
    }
  });

  it("parses TSX with JSX", () => {
    const result = parseCode("const el = <div>hi</div>;", "x.tsx");
    expect(result.ok).toBe(true);
  });

  it("returns a structured error (never throws) on invalid syntax, with position", () => {
    const result = parseCode("export function broken( { const x = }", "x.ts");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error.message).toBeTruthy();
      expect(result.error.error.position?.line).toBe(1);
    }
  });

  it("recognizes supported extensions", () => {
    expect(isSupportedFile("a.ts")).toBe(true);
    expect(isSupportedFile("a.tsx")).toBe(true);
    expect(isSupportedFile("a.js")).toBe(true);
    expect(isSupportedFile("a.jsx")).toBe(true);
    expect(isSupportedFile("a.json")).toBe(false);
    expect(isSupportedFile("a.css")).toBe(false);
  });
});

describe("ParserCache", () => {
  it("caches a parsed file and re-serves it without re-reading", async () => {
    const cache = new ParserCache();
    const file = fixturePath("src", "models.ts");
    const a = await cache.load(file);
    const b = await cache.load(file);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // Identical AST object reference proves the cache served the second call.
      expect(a.value.ast).toBe(b.value.ast);
    }
    expect(cache.size).toBe(1);
  });

  it("returns a structured error for a missing file", async () => {
    const cache = new ParserCache();
    const result = await cache.load(fixturePath("src", "does-not-exist.ts"));
    expect(result.ok).toBe(false);
  });
});

describe("file discovery + path safety", () => {
  it("treats the project root as inside itself", () => {
    expect(isInside(FIXTURE_ROOT, FIXTURE_ROOT)).toBe(true);
  });

  it("rejects paths that escape the root", () => {
    expect(isInside(FIXTURE_ROOT, path.resolve(FIXTURE_ROOT, ".."))).toBe(false);
    expect(() => resolveInsideRoot(FIXTURE_ROOT, "../../etc/passwd")).toThrow(PathEscapeError);
  });

  it("resolves a relative path inside the root", () => {
    const abs = resolveInsideRoot(FIXTURE_ROOT, "src/models.ts");
    expect(abs).toBe(fixturePath("src", "models.ts"));
  });

  it("discovers supported files in a directory and ignores node_modules", async () => {
    const { files } = await discoverFiles({ root: FIXTURE_ROOT, target: "src" });
    const rels = files.map((f) => toDisplayPath(FIXTURE_ROOT, f));
    expect(rels).toContain("src/models.ts");
    expect(rels).toContain("src/util.js");
    expect(rels).toContain("src/widget.tsx");
    expect(rels.some((r) => r.includes("node_modules"))).toBe(false);
  });

  it("resolves a single file target to just that file", async () => {
    const { files } = await discoverFiles({ root: FIXTURE_ROOT, target: "src/models.ts" });
    expect(files).toHaveLength(1);
    expect(toDisplayPath(FIXTURE_ROOT, files[0]!)).toBe("src/models.ts");
  });

  it("supports glob targets", async () => {
    const { files } = await discoverFiles({ root: FIXTURE_ROOT, target: "src/**/*.tsx" });
    const rels = files.map((f) => toDisplayPath(FIXTURE_ROOT, f));
    expect(rels).toEqual(["src/widget.tsx"]);
  });

  it("returns empty (not error) for a non-existent literal path", async () => {
    const { files } = await discoverFiles({ root: FIXTURE_ROOT, target: "src/nope.ts" });
    expect(files).toEqual([]);
  });
});

describe("cyclomatic complexity", () => {
  it("counts decision points correctly for an if/else-if chain", () => {
    // classify() has 5 `if`/`else if` tests -> complexity 6.
    const result = parseCode(
      `function classify(n){ if(n<0){return 'a'} else if(n===0){return 'b'} else if(n<10){return 'c'} else if(n<100){return 'd'} else if(n<1000){return 'e'} else {return 'f'} }`,
      "c.ts"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fns = analyzeAllFunctions(result.value.ast, 10);
      const classify = fns.find((f) => f.name === "classify");
      expect(classify?.complexity).toBe(6);
    }
  });

  it("counts logical operators, ternaries, loops, and catch", () => {
    const result = parseCode(
      `function f(a,b){ for(const x of a){ if(x && b || x){ } } try{}catch(e){} return a ? 1 : 2; }`,
      "c.ts"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const [fn] = analyzeAllFunctions(result.value.ast, 10);
      // base 1 + for 1 + if 1 + && 1 + || 1 + catch 1 + ternary 1 = 7
      expect(fn?.complexity).toBe(7);
    }
  });

  it("measures nested functions independently", () => {
    const result = parseCode(
      `function outer(){ if(true){} function inner(){ if(true){} if(false){} } }`,
      "c.ts"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const fns = analyzeAllFunctions(result.value.ast, 10);
      const outer = fns.find((f) => f.name === "outer");
      const inner = fns.find((f) => f.name === "inner");
      expect(outer?.complexity).toBe(2); // base + 1 if (NOT inner's ifs)
      expect(inner?.complexity).toBe(3); // base + 2 ifs
    }
  });

  it("flags functions at or above the threshold", () => {
    const result = parseCode(`function big(n){ if(n){} if(n){} if(n){} }`, "c.ts");
    if (result.ok) {
      const fns = analyzeAllFunctions(result.value.ast, 4);
      expect(fns[0]?.overThreshold).toBe(true); // complexity 4 >= 4
      const fns2 = analyzeAllFunctions(result.value.ast, 5);
      expect(fns2[0]?.overThreshold).toBe(false);
    }
  });

  it("counts nullish-coalescing and optional chaining as decision points", () => {
    // base 1 + ?? 1 + a?.b (optional member) 1 = 3
    const a = parseCode(`function f(x:any){ return (x ?? 0) + (x?.y); }`, "c.ts");
    if (a.ok) {
      const [fn] = analyzeAllFunctions(a.value.ast, 10);
      expect(fn?.complexity).toBe(3);
    }
    // switch with 3 non-default cases + default => base 1 + 3 = 4
    const b = parseCode(`function g(n:number){ switch(n){ case 1: case 2: case 3: break; default: break; } }`, "c.ts");
    if (b.ok) {
      const [fn] = analyzeAllFunctions(b.value.ast, 10);
      expect(fn?.complexity).toBe(4);
    }
  });
});

describe("symbol extraction edge cases", () => {
  function symbolsOf(code: string) {
    const r = parseCode(code, "t.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("parse failed");
    return listSymbols(r.value.ast);
  }

  it("reports renamed named exports (`export { a as b }`) as exported", () => {
    const syms = symbolsOf("const a = 1;\nfunction h(){}\nexport { a as publicValue, h as publicFn };");
    const a = syms.find((s) => s.name === "a");
    const h = syms.find((s) => s.name === "h");
    expect(a?.exported).toBe(true);
    expect(a?.exportKind).toBe("named");
    expect(h?.exported).toBe(true);
    expect(h?.exportKind).toBe("named");
  });

  it("does NOT mark a re-export from another module as a local export", () => {
    // `export { x } from "./y"` is not a local declaration; a local `x` here must
    // stay non-exported.
    const syms = symbolsOf('const x = 1;\nexport { y } from "./other";');
    const x = syms.find((s) => s.name === "x");
    expect(x?.exported).toBe(false);
  });

  it("includes ambient `declare function` and `export declare function`", () => {
    const syms = symbolsOf(
      "export declare function ext(x: number): void;\ndeclare function localAmbient(): void;"
    );
    const ext = syms.find((s) => s.name === "ext");
    const local = syms.find((s) => s.name === "localAmbient");
    expect(ext?.kind).toBe("function");
    expect(ext?.exported).toBe(true);
    expect(local?.kind).toBe("function");
    expect(local?.exported).toBe(false);
  });

  it("surfaces an anonymous `export default class {}` as a default symbol with members", () => {
    const r = parseCode("export default class { static make(){} go(){} }", "t.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const syms = listSymbols(r.value.ast);
    const def = syms.find((s) => s.name === "default");
    expect(def?.kind).toBe("class");
    expect(def?.exportKind).toBe("default");

    const outline = fileOutline(r.value.ast);
    const node = outline.find((n) => n.name === "default");
    expect(node?.children?.map((c) => c.name)).toEqual(expect.arrayContaining(["make", "go"]));
  });
});

describe("exported-symbol extraction (find_unused_exports internals)", () => {
  function parse(code: string) {
    const r = parseCode(code, "t.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("parse failed");
    return r.value.ast;
  }

  it("lists named + default exports and skips forwarded re-exports", () => {
    const ast = parse(
      [
        "export function a() {}",
        "export default function d() {}",
        "const b = 1; export { b as renamed };",
        'export { c } from "./other";', // forwarded — skipped
        'export * from "./star";' // star re-export — kept, flagged
      ].join("\n")
    );
    const exps = exportedSymbols(ast);
    const byName = new Map(exps.map((e) => [e.name, e]));
    expect(byName.get("a")?.kind).toBe("named");
    expect(byName.get("d")?.kind).toBe("default");
    expect(byName.get("renamed")?.kind).toBe("named");
    expect(byName.has("c")).toBe(false); // forwarded re-export not declared here
    expect(byName.get("*")?.reexport).toBe(true);
  });

  it("counts value/jsx/call references but not import or export-specifier bindings", () => {
    const ast = parse(
      [
        'import { foo } from "./x";', // binding, not a usage
        "const y = foo();", // usage (call)
        "const z = foo;", // usage (reference)
        "export { foo };", // export specifier, not a usage
        "const obj = { foo: 1 };" // object key, not a usage of the symbol
      ].join("\n")
    );
    const tally = new Map<string, number>();
    countNameUsages(ast, new Set(["foo"]), tally);
    expect(tally.get("foo")).toBe(2); // only the call + the bare reference
  });

  it("does not count a non-computed member-access property name as a usage", () => {
    const ast = parse("const o = { bar() {} }; o.bar();");
    const tally = new Map<string, number>();
    countNameUsages(ast, new Set(["bar"]), tally);
    // `o.bar` property name is not a free reference to a `bar` symbol.
    expect(tally.get("bar") ?? 0).toBe(0);
  });

  it("collects origin-side names of forwarded re-exports (entry-point roots)", () => {
    const ast = parse('export { a, b as c } from "./x";\nexport * from "./y";');
    // a (own name) and b (origin of `b as c`); star export is not enumerable.
    expect(reexportedOriginNames(ast).sort()).toEqual(["a", "b"]);
  });
});

describe("call-graph construction (call_graph internals)", () => {
  function parse(code: string) {
    const r = parseCode(code, "f.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("parse failed");
    return r.value.ast;
  }

  it("creates a node per function and an edge per call to its enclosing function", () => {
    const ast = parse(
      ["function a() { return b(); }", "function b() { return 1; }", "a();"].join("\n")
    );
    const { nodes, edges } = buildFileCallGraph(ast, "f.ts");
    expect(nodes.map((n) => n.name).sort()).toEqual(["a", "b"]);
    // a -> b inside function a.
    const aToB = edges.find((e) => e.callee === "b");
    expect(aToB?.from).toMatch(/f\.ts#a@1/);
    // top-level a() -> from is null.
    const topA = edges.find((e) => e.callee === "a" && e.from === null);
    expect(topA).toBeDefined();
  });

  it("resolves member-call callees to a dotted name and leaves cross-file resolution to the caller", () => {
    const ast = parse("function f() { service.create(); console.log('x'); }");
    const { edges } = buildFileCallGraph(ast, "f.ts");
    const callees = edges.map((e) => e.callee).sort();
    expect(callees).toEqual(["console.log", "service.create"]);
    // buildFileCallGraph never resolves `to` itself.
    expect(edges.every((e) => e.to === null)).toBe(true);
  });

  it("attributes a call inside a nested function to the nearest enclosing function", () => {
    const ast = parse("function outer() { function inner() { helper(); } }");
    const { nodes, edges } = buildFileCallGraph(ast, "f.ts");
    const innerId = nodes.find((n) => n.name === "inner")?.id;
    const edge = edges.find((e) => e.callee === "helper");
    expect(edge?.from).toBe(innerId);
  });
});

describe("symlink sandbox escape", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    const base = await fs.realpath(os.tmpdir());
    root = path.join(base, `ast-lens-test-root-${process.pid}-${Date.now()}`);
    outside = path.join(base, `ast-lens-test-OUTSIDE-${process.pid}-${Date.now()}`);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(root, "src", "ok.ts"), "export const ok = 1;");
    await fs.writeFile(path.join(outside, "secret.ts"), "export const SECRET = 'leak';");
    // A symlink that lives INSIDE root but points OUTSIDE it.
    try {
      await fs.symlink(outside, path.join(root, "src", "link"), "dir");
    } catch {
      // Some environments disallow symlinks; tests below tolerate absence.
    }
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("assertRealPathInside rejects a path whose real target escapes the root", async () => {
    await expect(
      assertRealPathInside(root, path.join(root, "src", "link", "secret.ts"))
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("does not discover files reached through an out-of-root symlink (directory target)", async () => {
    // Pointing at the symlinked directory itself is a deliberate escape: rejected.
    await expect(discoverFiles({ root, target: "src/link" })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("does not discover an out-of-root file addressed through a symlink (file target)", async () => {
    await expect(discoverFiles({ root, target: "src/link/secret.ts" })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("a project-wide glob never follows a symlink out of the root", async () => {
    const { files } = await discoverFiles({ root, target: "**/*.ts" });
    expect(files.some((f) => f.includes("OUTSIDE") || f.endsWith("secret.ts"))).toBe(false);
    expect(files.map((f) => path.basename(f))).toContain("ok.ts");
  });

  it("loadBatch refuses to read a secret through an in-root symlink", async () => {
    const ctx = new ServerContext(root);
    await expect(ctx.loadBatch("src/link/secret.ts")).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe("package entry-point resolution", () => {
  it("maps a dist build-output entry back to likely source candidates", () => {
    const cands = expandEntryToSourceCandidates("dist/index.js");
    // literal kept, source-dir rebased, TS extensions added, .d.ts considered.
    expect(cands).toContain("dist/index.js");
    expect(cands).toContain("src/index.ts");
    expect(cands).toContain("src/index.d.ts");
    expect(cands).toContain("source/index.ts");
    expect(cands).toContain("index.ts"); // build dir stripped, no source dir
  });

  it("maps a nested build path preserving the subpath", () => {
    const cands = expandEntryToSourceCandidates("dist/cli/main.mjs");
    expect(cands).toContain("src/cli/main.ts");
    expect(cands).toContain("src/cli/main.mts");
    expect(cands).toContain("dist/cli/main.mjs");
  });

  it("keeps a source entry (src/api.ts) as-is without inventing build dirs", () => {
    const cands = expandEntryToSourceCandidates("src/api.ts");
    expect(cands).toContain("src/api.ts");
    // It is not under a build dir, so we only keep the body+TS ext, not rebased
    // copies under other source dirs.
    expect(cands).not.toContain("dist/api.ts");
  });

  it("keeps a .d.ts types entry verbatim (type-fest style)", () => {
    const cands = expandEntryToSourceCandidates("index.d.ts");
    expect(cands).toContain("index.d.ts");
  });

  it("returns not-found for a directory with no package.json", async () => {
    const res = await resolvePackageEntryPoints(fixturePath());
    // sample-project fixture has no package.json.
    expect(res.found).toBe(false);
    expect(res.declared).toEqual([]);
    expect(res.sourceCandidates).toEqual([]);
  });

  it("reads main/module/bin/exports from a temp package.json without throwing", async () => {
    const base = await fs.realpath(os.tmpdir());
    const dir = path.join(base, `ast-lens-pkg-${process.pid}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "demo",
          main: "./dist/index.js",
          module: "./dist/index.mjs",
          bin: { demo: "./dist/cli.js" },
          exports: {
            ".": { types: "./dist/index.d.ts", import: "./dist/index.mjs", require: "./dist/index.cjs" },
            "./feature": "./dist/feature.js"
          }
        })
      );
      const res = await resolvePackageEntryPoints(dir);
      expect(res.found).toBe(true);
      // Declared paths normalized (leading ./ stripped). The `types` condition
      // value is collected too — a .d.ts entry is a real public-API root.
      expect(res.declared).toEqual(
        expect.arrayContaining([
          "dist/index.js",
          "dist/index.mjs",
          "dist/cli.js",
          "dist/index.cjs",
          "dist/feature.js",
          "dist/index.d.ts"
        ])
      );
      // Source candidates include mapped-back forms for matching against src.
      expect(res.sourceCandidates).toEqual(
        expect.arrayContaining(["src/index.ts", "src/cli.ts", "src/feature.ts"])
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("does not throw on malformed package.json", async () => {
    const base = await fs.realpath(os.tmpdir());
    const dir = path.join(base, `ast-lens-pkg-bad-${process.pid}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(path.join(dir, "package.json"), "{ not valid json ");
      const res = await resolvePackageEntryPoints(dir);
      expect(res.found).toBe(false);
      expect(res.sourceCandidates).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("relative-specifier resolution + star re-export sources", () => {
  const known = new Set([
    "src/main.ts",
    "src/api.ts",
    "src/dynamic.ts",
    "src/lib/aliased.ts",
    "src/features/index.ts"
  ]);

  it("resolves a sibling relative specifier with extension inference", () => {
    expect(resolveRelativeSpecifier("src/main.ts", "./api", known)).toBe("src/api.ts");
    expect(resolveRelativeSpecifier("src/main.ts", "./dynamic", known)).toBe("src/dynamic.ts");
  });

  it("resolves a nested-path specifier and a directory index", () => {
    expect(resolveRelativeSpecifier("src/main.ts", "./lib/aliased", known)).toBe("src/lib/aliased.ts");
    // `./features` -> features/index.ts
    expect(resolveRelativeSpecifier("src/main.ts", "./features", known)).toBe("src/features/index.ts");
  });

  it("returns undefined for bare package specifiers and out-of-scope targets", () => {
    expect(resolveRelativeSpecifier("src/main.ts", "react", known)).toBeUndefined();
    expect(resolveRelativeSpecifier("src/main.ts", "./nope", known)).toBeUndefined();
    expect(resolveRelativeSpecifier("src/main.ts", "../../escape", known)).toBeUndefined();
  });

  it("extracts only bare `export *` sources (not named re-exports)", () => {
    const r = parseCode(
      [
        'export * from "./a";',
        'export { x } from "./b";', // named — not a star
        'export * as ns from "./c";', // namespace star — not a bare star
        'export * from "./d";'
      ].join("\n"),
      "m.ts"
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(starReexportSources(r.value.ast).sort()).toEqual(["./a", "./d"]);
  });
});

describe("toolResult character-limit handling", () => {
  it("attaches the full structured payload below the limit", () => {
    const res = toolResult({ a: 1, items: [1, 2, 3] }, { format: ResponseFormat.JSON });
    expect(res.structuredContent).toEqual({ a: 1, items: [1, 2, 3] });
    expect((res.structuredContent as { responseTextTruncated?: boolean }).responseTextTruncated).toBeUndefined();
  });

  it("summarizes only the TEXT when over the limit, keeping structuredContent complete", () => {
    // Build a payload whose JSON rendering exceeds CHARACTER_LIMIT but whose
    // structured data is fully retained.
    const big = Array.from({ length: 5000 }, (_, i) => ({ id: `node-${i}`, v: i }));
    const res = toolResult(
      { nodeCount: big.length, truncated: false, nodes: big },
      { format: ResponseFormat.JSON, narrowHint: "Narrow it." }
    );
    const sc = res.structuredContent as {
      truncated: boolean;
      responseTextTruncated: boolean;
      nodes: unknown[];
    };
    // The tool's own data-level flag is preserved (NOT clobbered to true)...
    expect(sc.truncated).toBe(false);
    // ...and the complete node list is still present in structuredContent.
    expect(sc.nodes).toHaveLength(5000);
    // The presentation-only flag marks that the TEXT was summarized.
    expect(sc.responseTextTruncated).toBe(true);
    // The text content is the compact notice, not the full payload.
    const text = (res.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(CHARACTER_LIMIT);
    expect(text).toContain("responseTextTruncated");
    expect(text).toContain("structuredContent");
  });
});

describe("entry-point default covers .d.ts barrels (regression)", () => {
  it("resolves a top-level `types` field as a public-API root", async () => {
    const base = await fs.realpath(os.tmpdir());
    const dir = path.join(base, `ast-lens-dts-${process.pid}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    try {
      // type-fest shape: types-only package, no runtime main.
      await fs.writeFile(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "types-pkg",
          types: "./index.d.ts",
          exports: { ".": { types: "./index.d.ts" }, "./globals": { types: "./source/globals/index.d.ts" } }
        })
      );
      const res = await resolvePackageEntryPoints(dir);
      expect(res.found).toBe(true);
      // The declaration entries are recognized as roots (top-level `types` and
      // the per-subpath `types` condition both collected).
      expect(res.declared).toEqual(
        expect.arrayContaining(["index.d.ts", "source/globals/index.d.ts"])
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
