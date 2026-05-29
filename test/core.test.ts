import { describe, expect, it } from "vitest";
import path from "node:path";
import { parseCode, ParserCache, isSupportedFile } from "../src/core/parser.js";
import {
  discoverFiles,
  isInside,
  PathEscapeError,
  resolveInsideRoot,
  toDisplayPath
} from "../src/core/files.js";
import { analyzeAllFunctions } from "../src/core/traverse.js";
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
});
