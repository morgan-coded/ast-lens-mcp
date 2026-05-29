import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseCode } from "../src/core/parser.js";
import {
  buildImportGraph,
  collectFileSpecifiers,
  loadTsAliasConfig,
  reachableFrom,
  resolveSpecifier,
  type GraphFile
} from "../src/tools/deadFilesGraph.js";
import {
  connectClient,
  DEAD_FILES_FIXTURE_ROOT,
  PKG_FIXTURE_ROOT,
  structured,
  type ConnectedClient
} from "./helpers.js";

interface DeadFile {
  file: string;
  reason: "no-importers" | "unreachable-cluster";
  detail: string;
  importedBy: string[];
  dynamicOnlyImporters: boolean;
}
interface DeadFilesResult {
  scanned: number;
  entryFileCount: number;
  reachableCount: number;
  total: number;
  count: number;
  truncated: boolean;
  deadFiles: DeadFile[];
  entryPoints: string[];
  packageEntryPoints: string[];
  parseErrors: { file: string }[];
}

describe("find_dead_files — registration", () => {
  let conn: ConnectedClient;
  beforeAll(async () => {
    conn = await connectClient(DEAD_FILES_FIXTURE_ROOT);
  });
  afterAll(async () => {
    await conn.close();
  });

  it("is registered with a read-only annotation and a substantial description", async () => {
    const { tools } = await conn.client.listTools();
    const tool = tools.find((t) => t.name === "find_dead_files");
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect(tool!.annotations?.destructiveHint).toBe(false);
    expect((tool!.description ?? "").length).toBeGreaterThan(50);
    expect(tool!.inputSchema).toBeTruthy();
  });
});

describe("find_dead_files — dead-files fixture", () => {
  let conn: ConnectedClient;
  beforeAll(async () => {
    conn = await connectClient(DEAD_FILES_FIXTURE_ROOT);
  });
  afterAll(async () => {
    await conn.close();
  });
  const run = (args: Record<string, unknown> = {}) =>
    conn.client.callTool({ name: "find_dead_files", arguments: { target: "src/**/*.ts", ...args } }) as Promise<CallToolResult>;

  it("flags an unimported orphan and not the imported / entry / transitive files", async () => {
    const data = structured<DeadFilesResult>(await run());
    const dead = new Set(data.deadFiles.map((d) => d.file));

    // Unimported orphan -> flagged, reason no-importers.
    expect(dead.has("src/orphan.ts")).toBe(true);
    const orphan = data.deadFiles.find((d) => d.file === "src/orphan.ts");
    expect(orphan?.reason).toBe("no-importers");
    expect(orphan?.importedBy).toEqual([]);

    // Statically imported by the entry -> not flagged.
    expect(dead.has("src/imported.ts")).toBe(false);
    // Transitively imported (imported.ts -> transitive.ts) -> not flagged.
    expect(dead.has("src/transitive.ts")).toBe(false);
    // The index entry point itself -> never flagged.
    expect(dead.has("src/index.ts")).toBe(false);
  });

  it("does not flag the index entry point (matched by the default **/index.* glob)", async () => {
    const data = structured<DeadFilesResult>(await run());
    expect(data.deadFiles.some((d) => d.file === "src/index.ts")).toBe(false);
    expect(data.entryFileCount).toBeGreaterThanOrEqual(1);
  });

  it("does not flag a non-index package.json bin entry (cli.ts), and surfaces declared entries", async () => {
    const data = structured<DeadFilesResult>(await run());
    // cli.ts is reachable only because package.json bin -> dist/cli.js maps to it.
    expect(data.deadFiles.some((d) => d.file === "src/cli.ts")).toBe(false);
    // Declared entries are normalized to root-relative (leading "./" stripped).
    expect(data.packageEntryPoints).toEqual(expect.arrayContaining(["dist/index.js", "dist/cli.js"]));
  });

  it("treats a string-literal dynamic import as a real edge (lazy.ts not flagged)", async () => {
    const data = structured<DeadFilesResult>(await run());
    // index.ts: `await import("./lazy")` keeps lazy.ts reachable.
    expect(data.deadFiles.some((d) => d.file === "src/lazy.ts")).toBe(false);
  });

  it("resolves a tsconfig path alias so the aliased target counts as imported", async () => {
    const data = structured<DeadFilesResult>(await run());
    // index.ts imports "@util/aliasedUsed" (alias @util/* -> src/util/*).
    expect(data.deadFiles.some((d) => d.file === "src/util/aliasedUsed.ts")).toBe(false);
  });

  it("flags a module reachable only via a COMPUTED dynamic import (documented false positive)", async () => {
    const data = structured<DeadFilesResult>(await run());
    const dead = new Set(data.deadFiles.map((d) => d.file));
    // consumer-computed.ts does `import(`./computed-${k}`)` — non-literal, no
    // edge — so computed-only.ts looks dead, and consumer-computed.ts (which
    // nothing imports) is dead too.
    expect(dead.has("src/computed-only.ts")).toBe(true);
    expect(dead.has("src/consumer-computed.ts")).toBe(true);
  });

  it("reports a mutually-importing unreachable cluster with reason unreachable-cluster", async () => {
    const data = structured<DeadFilesResult>(await run());
    const a = data.deadFiles.find((d) => d.file === "src/clusterA.ts");
    const b = data.deadFiles.find((d) => d.file === "src/clusterB.ts");
    expect(a?.reason).toBe("unreachable-cluster");
    expect(b?.reason).toBe("unreachable-cluster");
    // Each is imported by the other (so importedBy is non-empty).
    expect(a?.importedBy).toContain("src/clusterB.ts");
    expect(b?.importedBy).toContain("src/clusterA.ts");
  });

  it("with entryPoints=[] and no package entries, even index.ts looks dead", async () => {
    const data = structured<DeadFilesResult>(await run({ entryPoints: [], usePackageEntryPoints: false }));
    const dead = new Set(data.deadFiles.map((d) => d.file));
    expect(data.entryFileCount).toBe(0);
    // No roots: index.ts is imported by no one in scope, so it is now flagged.
    expect(dead.has("src/index.ts")).toBe(true);
    expect(dead.has("src/cli.ts")).toBe(true);
    // imported.ts is still imported by index.ts, so reason is unreachable-cluster.
    const imported = data.deadFiles.find((d) => d.file === "src/imported.ts");
    expect(imported?.reason).toBe("unreachable-cluster");
  });

  it("without package entry points, the non-index cli entry is flagged", async () => {
    const data = structured<DeadFilesResult>(await run({ usePackageEntryPoints: false }));
    const dead = new Set(data.deadFiles.map((d) => d.file));
    expect(data.packageEntryPoints).toEqual([]);
    // index.ts is still a root (matches **/index.* glob), so it and its imports stay alive.
    expect(dead.has("src/index.ts")).toBe(false);
    expect(dead.has("src/imported.ts")).toBe(false);
    // cli.ts is no longer recognized as an entry -> flagged.
    expect(dead.has("src/cli.ts")).toBe(true);
  });

  it("honors a custom entryPoints glob to keep an otherwise-orphan file alive", async () => {
    const data = structured<DeadFilesResult>(
      await run({ entryPoints: ["**/index.*", "**/orphan.ts"] })
    );
    // orphan.ts is now an entry point -> not flagged.
    expect(data.deadFiles.some((d) => d.file === "src/orphan.ts")).toBe(false);
  });

  it("respects the limit and reports truncation", async () => {
    const data = structured<DeadFilesResult>(await run({ limit: 1 }));
    expect(data.count).toBe(1);
    expect(data.total).toBeGreaterThan(1);
    expect(data.truncated).toBe(true);
  });

  it("renders markdown on request", async () => {
    const res = (await conn.client.callTool({
      name: "find_dead_files",
      arguments: { target: "src/**/*.ts", response_format: "markdown" }
    })) as CallToolResult;
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^# Dead files/);
    expect(text).toContain("src/orphan.ts");
    expect(text).toMatch(/Heuristic/i);
  });
});

// Cross-cutting real-world checks against the shared pkg-project fixture
// (read-only; not modified). Exercises a non-index package.json entry, an
// `export *` re-export edge, a tsconfig alias, and circular deps.
describe("find_dead_files — pkg-project (package entry points + edges)", () => {
  let conn: ConnectedClient;
  beforeAll(async () => {
    conn = await connectClient(PKG_FIXTURE_ROOT);
  });
  afterAll(async () => {
    await conn.close();
  });
  const run = (args: Record<string, unknown> = {}) =>
    conn.client.callTool({ name: "find_dead_files", arguments: { target: "**/*.ts", ...args } }) as Promise<CallToolResult>;

  it("keeps the real (non-index) entry and everything it imports/re-exports alive", async () => {
    const data = structured<DeadFilesResult>(await run());
    const dead = new Set(data.deadFiles.map((d) => d.file));
    // src/main.ts is the entry (dist/main.js); reachable via re-exports/imports:
    expect(dead.has("src/main.ts")).toBe(false); // entry
    expect(dead.has("src/api.ts")).toBe(false); // `export { ... } from "./api"`
    expect(dead.has("src/dynamic.ts")).toBe(false); // `export * from "./dynamic"`
    expect(dead.has("src/lib/aliased.ts")).toBe(false); // imported via @lib alias
    // packages/sub/index.ts is an index entry; its internal import stays alive.
    expect(dead.has("packages/sub/index.ts")).toBe(false);
    expect(dead.has("packages/sub/internal.ts")).toBe(false);
  });

  it("flags genuinely orphaned files in pkg-project", async () => {
    const data = structured<DeadFilesResult>(await run());
    const dead = new Set(data.deadFiles.map((d) => d.file));
    // deadweight.ts: imported by nobody, not an entry.
    expect(dead.has("src/deadweight.ts")).toBe(true);
    // consumer-of-types.ts: imports typesonly.ts but nothing imports it -> dead.
    expect(dead.has("src/consumer-of-types.ts")).toBe(true);
    // circular-a/-b import each other but no entry reaches them
    // (dynamic.ts reaches them only via a COMPUTED import) -> unreachable cluster.
    const ca = data.deadFiles.find((d) => d.file === "src/circular-a.ts");
    expect(ca?.reason).toBe("unreachable-cluster");
  });

  it("terminates on circular dependencies (no hang) and returns a coherent result", async () => {
    const data = structured<DeadFilesResult>(await run({ target: "src/**/*.ts" }));
    expect(Array.isArray(data.deadFiles)).toBe(true);
    expect(data.scanned).toBeGreaterThan(0);
  });
});

// Direct unit tests of the self-contained helper.
describe("deadFilesGraph helper", () => {
  it("parses tsconfig JSONC (comments + trailing commas) and exposes baseUrl + paths", async () => {
    const config = await loadTsAliasConfig(DEAD_FILES_FIXTURE_ROOT);
    expect(config.baseUrl).toBe(""); // baseUrl "." normalizes to root ("")
    expect(config.rules.length).toBeGreaterThanOrEqual(1);
    const known = new Set(["src/util/aliasedUsed.ts"]);
    expect(resolveSpecifier("src/index.ts", "@util/aliasedUsed", known, config)).toBe("src/util/aliasedUsed.ts");
    // A bare specifier with no matching alias does not resolve.
    expect(resolveSpecifier("src/index.ts", "react", known, config)).toBeUndefined();
  });

  it("resolves relative, index, and extensionless specifiers against in-scope files", async () => {
    const config = { rules: [] };
    const known = new Set(["a/b.ts", "a/c/index.ts"]);
    expect(resolveSpecifier("a/x.ts", "./b", known, config)).toBe("a/b.ts");
    expect(resolveSpecifier("a/x.ts", "./c", known, config)).toBe("a/c/index.ts"); // /index.* resolution
    expect(resolveSpecifier("a/x.ts", "./missing", known, config)).toBeUndefined();
  });

  it("rewrites a TS-ESM .js import specifier to its .ts/.tsx/.mts source", () => {
    const config = { rules: [] };
    const known = new Set(["src/server.ts", "src/widget.tsx", "src/m.mts", "src/c/index.ts"]);
    // `import "./server.js"` in TS ESM resolves to server.ts.
    expect(resolveSpecifier("src/index.ts", "./server.js", known, config)).toBe("src/server.ts");
    expect(resolveSpecifier("src/index.ts", "./widget.js", known, config)).toBe("src/widget.tsx");
    expect(resolveSpecifier("src/index.ts", "./m.mjs", known, config)).toBe("src/m.mts");
    expect(resolveSpecifier("src/index.ts", "./c/index.js", known, config)).toBe("src/c/index.ts");
  });

  it("collects static vs. literal-dynamic specifiers and ignores computed dynamic imports", () => {
    const code = [
      'import { x } from "./static";',
      'export { y } from "./reexport";',
      'export * from "./star";',
      'const a = await import("./dynlit");',
      "const b = await import(`./dyn-${k}`);",
      'const c = require("./req");'
    ].join("\n");
    const parsed = parseCode(code, "f.ts");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const specs = collectFileSpecifiers(parsed.value.ast);
    const statics = specs.filter((s) => !s.dynamic).map((s) => s.spec).sort();
    const dynamics = specs.filter((s) => s.dynamic).map((s) => s.spec).sort();
    expect(statics).toEqual(["./reexport", "./star", "./static"]);
    // literal import() + require() captured; template-literal import() omitted.
    expect(dynamics).toEqual(["./dynlit", "./req"]);
  });

  it("builds in/out edges and tags static vs. dynamic importers", () => {
    const mk = (display: string, code: string): GraphFile => {
      const r = parseCode(code, display);
      if (!r.ok) throw new Error(`parse failed: ${display}`);
      return { display, ast: r.value.ast };
    };
    const files: GraphFile[] = [
      mk("entry.ts", 'import "./used"; const m = import("./lazy");'),
      mk("used.ts", "export const u = 1;"),
      mk("lazy.ts", "export const l = 2;"),
      mk("orphan.ts", "export const o = 3;")
    ];
    const graph = buildImportGraph(files, { rules: [] });
    expect([...graph.importedBy.get("used.ts")!]).toEqual(["entry.ts"]);
    expect([...graph.importedBy.get("lazy.ts")!]).toEqual(["entry.ts"]);
    expect([...graph.importedBy.get("orphan.ts")!]).toEqual([]);
    expect(graph.staticallyImported.has("used.ts")).toBe(true);
    expect(graph.dynamicallyImported.has("lazy.ts")).toBe(true);
    expect(graph.staticallyImported.has("lazy.ts")).toBe(false);
  });

  it("reachableFrom follows edges transitively and terminates on cycles", () => {
    const mk = (display: string, code: string): GraphFile => {
      const r = parseCode(code, display);
      if (!r.ok) throw new Error("parse failed");
      return { display, ast: r.value.ast };
    };
    const files: GraphFile[] = [
      mk("root.ts", 'import "./a";'),
      mk("a.ts", 'import "./b";'),
      mk("b.ts", 'import "./a";'), // a <-> b cycle
      mk("island.ts", "export const i = 1;")
    ];
    const graph = buildImportGraph(files, { rules: [] });
    const reached = reachableFrom(graph, ["root.ts"]);
    expect(reached.has("root.ts")).toBe(true);
    expect(reached.has("a.ts")).toBe(true);
    expect(reached.has("b.ts")).toBe(true);
    expect(reached.has("island.ts")).toBe(false);
  });
});
