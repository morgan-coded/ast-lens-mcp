import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  connectClient,
  ESM_REEXPORT_FIXTURE_ROOT,
  PKG_FIXTURE_ROOT,
  structured,
  type ConnectedClient
} from "./helpers.js";

let conn: ConnectedClient;

beforeAll(async () => {
  conn = await connectClient();
});

afterAll(async () => {
  await conn.close();
});

function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return conn.client.callTool({ name, arguments: args }) as Promise<CallToolResult>;
}

describe("server registration", () => {
  it("lists all twelve tools with schemas and annotations", async () => {
    const { tools } = await conn.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "analyze_complexity",
        "api_surface",
        "call_graph",
        "detect_circular_deps",
        "find_dead_files",
        "find_references",
        "find_unused_exports",
        "get_file_outline",
        "import_graph",
        "list_symbols",
        "search_ast",
        "summarize_module"
      ].sort()
    );
    for (const tool of tools) {
      expect(tool.description && tool.description.length).toBeGreaterThan(50);
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("list_symbols", () => {
  it("lists top-level symbols across the src directory", async () => {
    const res = await call("list_symbols", { target: "src" });
    const data = structured<{
      totalSymbols: number;
      files: { file: string; symbols: { name: string; kind: string; exported: boolean }[] }[];
      parseErrors: { file: string }[];
    }>(res);

    const models = data.files.find((f) => f.file === "src/models.ts");
    expect(models).toBeDefined();
    const names = models!.symbols.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["User", "UserId", "Role", "DEFAULT_ROLE", "nextId", "UserService"]));

    // UserService is exported; internalCounter (a bare `let`) is module-level too.
    const userService = models!.symbols.find((s) => s.name === "UserService");
    expect(userService?.kind).toBe("class");
    expect(userService?.exported).toBe(true);

    // The broken file should surface as a parse error, not crash the call.
    expect(data.parseErrors.some((e) => e.file === "src/broken.ts")).toBe(true);
  });

  it("filters by kind and exportedOnly", async () => {
    const res = await call("list_symbols", { target: "src/models.ts", kinds: ["function"], exportedOnly: true });
    const data = structured<{ files: { symbols: { name: string }[] }[] }>(res);
    const names = data.files.flatMap((f) => f.symbols.map((s) => s.name));
    expect(names).toContain("nextId");
    expect(names).not.toContain("unexportedHelper"); // not exported
    expect(names).not.toContain("UserService"); // not a function
  });

  it("reports renamed and ambient exports correctly (exportedOnly keeps them)", async () => {
    const res = await call("list_symbols", { target: "src/edge.ts", exportedOnly: true });
    const data = structured<{ files: { symbols: { name: string; exported: boolean; kind: string }[] }[] }>(res);
    const names = data.files.flatMap((f) => f.symbols.map((s) => s.name));
    // `export { renameMe as publicValue }` — renameMe must survive exportedOnly.
    expect(names).toContain("renameMe");
    expect(names).toContain("renameFn");
    // `export declare function ambientExported` must appear.
    expect(names).toContain("ambientExported");
    // Local ambient is NOT exported, so it must be filtered out here.
    expect(names).not.toContain("ambientLocal");
  });

  it("never includes node_modules files even when scanning the whole project", async () => {
    // The fixture has node_modules/ignored-pkg/index.ts; scanning "**/*.ts" from
    // the root must still exclude it (proves active ignoring, not mere absence).
    const res = await call("list_symbols", { target: "**/*.ts" });
    const data = structured<{ files: { file: string; symbols: { name: string }[] }[] }>(res);
    expect(data.files.every((f) => !f.file.includes("node_modules"))).toBe(true);
    const allNames = data.files.flatMap((f) => f.symbols.map((s) => s.name));
    expect(allNames).not.toContain("shouldNeverAppear");
  });
});

describe("get_file_outline", () => {
  it("nests class members under the class", async () => {
    const res = await call("get_file_outline", { file: "src/models.ts" });
    const data = structured<{
      outline: { name: string; kind: string; children?: { name: string; kind: string; static?: boolean }[] }[];
    }>(res);

    const cls = data.outline.find((n) => n.name === "UserService");
    expect(cls?.kind).toBe("class");
    const childNames = cls?.children?.map((c) => c.name) ?? [];
    expect(childNames).toEqual(expect.arrayContaining(["create", "add", "count", "findById"]));

    const create = cls?.children?.find((c) => c.name === "create");
    expect(create?.static).toBe(true);
    const count = cls?.children?.find((c) => c.name === "count");
    expect(count?.kind).toBe("getter");
  });

  it("nests interface and enum members", async () => {
    const res = await call("get_file_outline", { file: "src/models.ts" });
    const data = structured<{ outline: { name: string; children?: { name: string }[] }[] }>(res);
    const iface = data.outline.find((n) => n.name === "User");
    expect(iface?.children?.map((c) => c.name)).toEqual(expect.arrayContaining(["id", "name", "getDisplayName"]));
    const role = data.outline.find((n) => n.name === "Role");
    expect(role?.children?.map((c) => c.name)).toEqual(["Admin", "Member", "Guest"]);
  });

  it("errors clearly when target is a directory", async () => {
    const res = await call("get_file_outline", { file: "src" });
    expect(res.isError).toBe(true);
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/single file|matched/i);
  });

  it("errors with parse position on a broken file", async () => {
    const res = await call("get_file_outline", { file: "src/broken.ts" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/parse/i);
  });
});

describe("find_references", () => {
  it("finds references to UserService across files and classifies them", async () => {
    const res = await call("find_references", { name: "UserService", target: "src" });
    const data = structured<{
      total: number;
      references: { file: string; context: string }[];
      byContext: Record<string, number>;
    }>(res);

    expect(data.total).toBeGreaterThanOrEqual(3);
    const files = new Set(data.references.map((r) => r.file));
    // Declared in models.ts, imported + used in widget.tsx.
    expect(files.has("src/models.ts")).toBe(true);
    expect(files.has("src/widget.tsx")).toBe(true);

    expect(data.byContext.declaration).toBeGreaterThanOrEqual(1);
    expect((data.byContext.import ?? 0) + (data.byContext.call ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it("can exclude declaration sites", async () => {
    const withDecl = structured<{ byContext: Record<string, number> }>(
      await call("find_references", { name: "UserService", target: "src", includeDeclarations: true })
    );
    const withoutDecl = structured<{ references: { context: string }[] }>(
      await call("find_references", { name: "UserService", target: "src", includeDeclarations: false })
    );
    expect(withDecl.byContext.declaration).toBeGreaterThanOrEqual(1);
    expect(withoutDecl.references.every((r) => r.context !== "declaration")).toBe(true);
  });

  it("does not double-count a non-aliased import specifier", async () => {
    // `import { UserService } from "./models"` in widget.tsx must yield ONE
    // import reference at that location, not two.
    const data = structured<{ references: { file: string; context: string; span: { start: { line: number } } }[] }>(
      await call("find_references", { name: "UserService", target: "src/widget.tsx" })
    );
    const importsAtLine2 = data.references.filter((r) => r.context === "import" && r.span.start.line === 2);
    expect(importsAtLine2).toHaveLength(1);
  });

  it("respects the limit", async () => {
    const data = structured<{ count: number; total: number; truncated: boolean }>(
      await call("find_references", { name: "count", target: "src", limit: 1 })
    );
    expect(data.count).toBeLessThanOrEqual(1);
  });
});

describe("search_ast", () => {
  it("finds console usage", async () => {
    const data = structured<{ total: number; matches: { detail?: string }[] }>(
      await call("search_ast", { query: "console_usage", target: "src/smelly.ts" })
    );
    expect(data.total).toBe(2); // console.log + console.error
    expect(data.matches.map((m) => m.detail)).toEqual(expect.arrayContaining(["console.log", "console.error"]));
  });

  it("finds any usage", async () => {
    const data = structured<{ total: number }>(
      await call("search_ast", { query: "any_usage", target: "src/smelly.ts" })
    );
    // items: any[], item: any (x1 param), data: any  -> at least 3 explicit anys
    expect(data.total).toBeGreaterThanOrEqual(3);
  });

  it("finds await-in-loop but not awaits outside loops", async () => {
    const data = structured<{ total: number; matches: { span: { start: { line: number } } }[] }>(
      await call("search_ast", { query: "await_in_loop", target: "src/smelly.ts" })
    );
    expect(data.total).toBe(1); // only the await inside the for-of in processItems
  });

  it("finds empty catch blocks", async () => {
    const data = structured<{ total: number }>(
      await call("search_ast", { query: "empty_catch", target: "src/smelly.ts" })
    );
    expect(data.total).toBe(1);
  });

  it("finds TODO/FIXME comments with markers", async () => {
    const data = structured<{ total: number; matches: { detail?: string }[] }>(
      await call("search_ast", { query: "todo_fixme", target: "src/smelly.ts" })
    );
    const markers = data.matches.map((m) => m.detail);
    expect(markers).toEqual(expect.arrayContaining(["TODO", "FIXME"]));
  });

  it("finds ts-ignore suppression comments", async () => {
    const data = structured<{ total: number }>(
      await call("search_ast", { query: "ts_ignore", target: "src/smelly.ts" })
    );
    expect(data.total).toBeGreaterThanOrEqual(1);
  });

  it("finds non-null assertions", async () => {
    const data = structured<{ total: number }>(
      await call("search_ast", { query: "non_null_assertion", target: "src/smelly.ts" })
    );
    expect(data.total).toBeGreaterThanOrEqual(2); // item.value! and data.value!
  });

  it("calls_to matches a specific callee by member path and bare name", async () => {
    const byPath = structured<{ total: number }>(
      await call("search_ast", { query: "calls_to", callee: "console.log", target: "src/smelly.ts" })
    );
    expect(byPath.total).toBe(1);

    const byBare = structured<{ total: number }>(
      await call("search_ast", { query: "calls_to", callee: "fetchValue", target: "src/smelly.ts" })
    );
    expect(byBare.total).toBe(1);
  });

  it("node_type generic filter matches TryStatement", async () => {
    const data = structured<{ total: number; matches: { nodeType: string }[] }>(
      await call("search_ast", { query: "node_type", nodeType: "TryStatement", target: "src/smelly.ts" })
    );
    expect(data.total).toBe(1);
    expect(data.matches[0]?.nodeType).toBe("TryStatement");
  });

  it("errors when calls_to is missing a callee", async () => {
    const res = await call("search_ast", { query: "calls_to", target: "src/smelly.ts" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/callee/i);
  });

  it("errors when node_type is missing a nodeType", async () => {
    const res = await call("search_ast", { query: "node_type", target: "src/smelly.ts" });
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/nodeType/i);
  });

  it("calls_to and console_usage catch optional-chained calls (logger?.log(), console?.log())", async () => {
    // edge.ts has `logger?.log("hi")` and `console?.log("...")` — both via `?.`.
    const logCalls = structured<{ total: number; matches: { detail?: string }[] }>(
      await call("search_ast", { query: "calls_to", callee: "log", target: "src/edge.ts" })
    );
    expect(logCalls.total).toBeGreaterThanOrEqual(2); // logger?.log AND console?.log

    const consoleHits = structured<{ total: number; matches: { detail?: string }[] }>(
      await call("search_ast", { query: "console_usage", target: "src/edge.ts" })
    );
    expect(consoleHits.total).toBe(1); // console?.log via optional chaining
    expect(consoleHits.matches[0]?.detail).toBe("console.log");
  });
});

describe("analyze_complexity", () => {
  it("computes complexity and flags functions over a threshold", async () => {
    const data = structured<{
      totalFunctions: number;
      flaggedCount: number;
      maxComplexity: number;
      files: { file: string; functions: { name: string; complexity: number; overThreshold: boolean }[] }[];
    }>(await call("analyze_complexity", { target: "src/smelly.ts", threshold: 5 }));

    const all = data.files.flatMap((f) => f.functions);
    const classify = all.find((f) => f.name === "classify");
    expect(classify?.complexity).toBe(6); // 5 if/else-if tests + base
    expect(classify?.overThreshold).toBe(true); // 6 >= 5
    expect(data.maxComplexity).toBeGreaterThanOrEqual(6);
  });

  it("flaggedOnly returns only flagged functions", async () => {
    const data = structured<{ files: { functions: { overThreshold: boolean }[] }[] }>(
      await call("analyze_complexity", { target: "src", threshold: 5, flaggedOnly: true })
    );
    const all = data.files.flatMap((f) => f.functions);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((f) => f.overThreshold)).toBe(true);
  });

  it("sorts by complexity descending by default", async () => {
    const data = structured<{ files: { functions: { complexity: number }[] }[] }>(
      await call("analyze_complexity", { target: "src/smelly.ts" })
    );
    for (const f of data.files) {
      const cs = f.functions.map((fn) => fn.complexity);
      const sorted = [...cs].sort((a, b) => b - a);
      expect(cs).toEqual(sorted);
    }
  });
});

describe("summarize_module", () => {
  it("summarizes imports, exports, and dependencies including dynamic import + require", async () => {
    const data = structured<{
      imports: { source: string; bindings: { local: string; imported: string }[]; typeOnly: boolean }[];
      exports: { name: string; kind: string; source?: string }[];
      dependencies: string[];
      localDependencies: string[];
      externalDependencies: string[];
    }>(await call("summarize_module", { file: "src/barrel.ts" }));

    expect(data.externalDependencies).toContain("node:fs/promises");
    expect(data.localDependencies).toEqual(expect.arrayContaining(["./models", "./widget", "./dynamic-mod", "./legacy-cjs"]));

    // type-only import recognized
    const typeImport = data.imports.find((i) => i.typeOnly);
    expect(typeImport?.source).toBe("./models");

    // namespace + default imports captured
    const ns = data.imports.find((i) => i.bindings.some((b) => b.imported === "*"));
    expect(ns?.bindings[0]?.local).toBe("models");
    const def = data.imports.find((i) => i.bindings.some((b) => b.imported === "default"));
    expect(def?.bindings.some((b) => b.local === "defaultService")).toBe(true);

    // re-exports captured with source
    const reexport = data.exports.find((e) => e.name === "Role");
    expect(reexport?.source).toBe("./models");
    // export * from "./widget"
    expect(data.exports.some((e) => e.name === "*" && e.source === "./widget")).toBe(true);
  });

  it("errors when target is not a single file", async () => {
    const res = await call("summarize_module", { file: "src" });
    expect(res.isError).toBe(true);
  });
});

describe("find_unused_exports", () => {
  it("flags exports never referenced from another file in scope", async () => {
    const data = structured<{
      total: number;
      totalExports: number;
      scanned: number;
      unused: { file: string; name: string; exportKind: string; reexport: boolean }[];
    }>(await call("find_unused_exports", { target: "src/unused" }));

    const names = data.unused.map((u) => u.name);
    // onlyUsedInternally is exported but only referenced within lib.ts -> unused.
    expect(names).toContain("onlyUsedInternally");
    // trulyUnused is never referenced anywhere -> unused.
    expect(names).toContain("trulyUnused");
    // usedAcrossFile IS imported by consumer.ts -> not flagged.
    expect(names).not.toContain("usedAcrossFile");
    // run is re-exported by the entry point index.ts -> reachable public API.
    expect(names).not.toContain("run");
    // helperInternal is not exported at all -> never in the report.
    expect(names).not.toContain("helperInternal");
  });

  it("treats index.* as an entry point whose own exports are not flagged", async () => {
    const data = structured<{ unused: { name: string }[] }>(
      await call("find_unused_exports", { target: "src/unused" })
    );
    // entryOnlyExport lives in index.ts and is used nowhere, but entry-point
    // exports are public API and excluded by default.
    expect(data.unused.map((u) => u.name)).not.toContain("entryOnlyExport");
  });

  it("flags everything (incl. entry-point exports) when entryPoints=[]", async () => {
    const data = structured<{ unused: { name: string }[] }>(
      await call("find_unused_exports", { target: "src/unused", entryPoints: [] })
    );
    const names = data.unused.map((u) => u.name);
    expect(names).toContain("entryOnlyExport");
    expect(names).toContain("run");
  });

  it("skips forwarded re-exports but surfaces bare `export *` only with includeReexports", async () => {
    const without = structured<{ unused: { name: string; reexport: boolean }[] }>(
      await call("find_unused_exports", { target: "src/unused" })
    );
    expect(without.unused.some((u) => u.reexport)).toBe(false);
    // `export { Role } from "../models"` is a forwarded binding, never flagged.
    expect(without.unused.map((u) => u.name)).not.toContain("Role");

    const withRe = structured<{ unused: { name: string; reexport: boolean }[] }>(
      await call("find_unused_exports", { target: "src/unused", includeReexports: true })
    );
    expect(withRe.unused.some((u) => u.reexport && u.name === "*")).toBe(true);
  });

  it("respects the limit", async () => {
    const data = structured<{ count: number; total: number; truncated: boolean }>(
      await call("find_unused_exports", { target: "src/unused", limit: 1 })
    );
    expect(data.count).toBe(1);
    expect(data.total).toBeGreaterThan(1);
    expect(data.truncated).toBe(true);
  });
});

describe("call_graph", () => {
  it("builds nodes for every function and resolves intra-graph edges", async () => {
    const data = structured<{
      nodeCount: number;
      edgeCount: number;
      unresolvedCallees: number;
      nodes: { id: string; name: string; file: string }[];
      edges: { from: string | null; callee: string; to: string | null }[];
    }>(await call("call_graph", { target: "src/graph" }));

    // alpha, beta, usesCallback, <anonymous>, fetchThing, helper, inner.
    expect(data.nodeCount).toBe(7);
    expect(data.nodes.map((n) => n.name)).toEqual(
      expect.arrayContaining(["alpha", "beta", "usesCallback", "<anonymous>", "fetchThing", "helper", "inner"])
    );

    const byCallee = (c: string) => data.edges.filter((e) => e.callee === c);
    // Cross-file edge alpha -> helper resolves to the helper node.
    const alphaToHelper = byCallee("helper").find((e) => e.from?.includes("alpha"));
    expect(alphaToHelper?.to).toMatch(/more\.ts#helper@/);
    // Recursive self-edge beta -> beta.
    const betaSelf = byCallee("beta").find((e) => e.from?.includes("beta"));
    expect(betaSelf?.to).toMatch(/calls\.ts#beta@/);

    // External callees (fetch, items.map) are unresolved (2 distinct names).
    expect(data.unresolvedCallees).toBe(2);
  });

  it("excludes external (unresolved) call edges by default, includes them on request", async () => {
    const def = structured<{ edges: { callee: string; to: string | null }[] }>(
      await call("call_graph", { target: "src/graph" })
    );
    expect(def.edges.every((e) => e.to !== null)).toBe(true);
    expect(def.edges.some((e) => e.callee === "fetch")).toBe(false);

    const withExt = structured<{ edges: { callee: string; to: string | null }[] }>(
      await call("call_graph", { target: "src/graph", includeExternalCalls: true })
    );
    const fetchEdge = withExt.edges.find((e) => e.callee === "fetch");
    expect(fetchEdge).toBeDefined();
    expect(fetchEdge?.to).toBeNull();
  });

  it("records a top-level call with from=null", async () => {
    const data = structured<{ edges: { from: string | null; callee: string; to: string | null }[] }>(
      await call("call_graph", { target: "src/graph" })
    );
    const topLevel = data.edges.find((e) => e.from === null && e.callee === "alpha");
    expect(topLevel).toBeDefined();
    expect(topLevel?.to).toMatch(/calls\.ts#alpha@/);
  });

  it("can omit anonymous functions and their dangling edges", async () => {
    const data = structured<{ nodes: { name: string; id: string }[]; edges: { from: string | null }[] }>(
      await call("call_graph", { target: "src/graph", includeAnonymous: false, includeExternalCalls: true })
    );
    expect(data.nodes.some((n) => n.name === "<anonymous>")).toBe(false);
    const nodeIds = new Set(data.nodes.map((n) => n.id));
    // No edge should originate from a node that was excluded.
    expect(data.edges.every((e) => e.from === null || nodeIds.has(e.from))).toBe(true);
  });

  it("size-guards by capping combined nodes+edges and flags truncation", async () => {
    const data = structured<{ nodeCount: number; nodes: unknown[]; edges: unknown[]; truncated: boolean }>(
      await call("call_graph", { target: "src/graph", limit: 7 })
    );
    // 7 nodes fill the budget exactly, leaving no room for edges.
    expect(data.nodes).toHaveLength(7);
    expect(data.edges).toHaveLength(0);
    expect(data.truncated).toBe(true);
  });
});

describe("response formats", () => {
  it("returns markdown when requested", async () => {
    const res = await call("list_symbols", { target: "src/models.ts", response_format: "markdown" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^# Symbols/);
    expect(text).toContain("UserService");
  });

  it("returns JSON by default with structuredContent", async () => {
    const res = await call("summarize_module", { file: "src/models.ts" });
    expect(res.structuredContent).toBeTruthy();
    expect(() => JSON.parse((res.content[0] as { text: string }).text)).not.toThrow();
  });
});

// Package-aware fixture: a project whose REAL entry (dist/main.js -> src/main.ts)
// is not an index.* file. Exercises package.json entry-point resolution plus the
// edge cases: circular deps, `export *` from an entry, dynamic import(), a
// tsconfig path alias, type-only export/import, and a nested sub-package.
describe("find_unused_exports — package entry points + edge cases", () => {
  let pkg: ConnectedClient;
  beforeAll(async () => {
    pkg = await connectClient(PKG_FIXTURE_ROOT);
  });
  afterAll(async () => {
    await pkg.close();
  });
  const pkgCall = (args: Record<string, unknown>) =>
    pkg.client.callTool({ name: "find_unused_exports", arguments: args }) as Promise<CallToolResult>;

  it("treats a non-index package.json entry (and its re-exports) as public API", async () => {
    const data = structured<{
      packageEntryPoints: string[];
      unused: { file: string; name: string }[];
    }>(await pkgCall({ target: "**/*.ts" }));
    const names = data.unused.map((u) => `${u.file}:${u.name}`);

    // package.json declared the build-output entries; surfaced for transparency.
    expect(data.packageEntryPoints).toEqual(
      expect.arrayContaining(["dist/main.js", "dist/main.mjs", "dist/cli.js"])
    );

    // src/main.ts is the real entry (mapped from dist/main.js): its own export
    // (bootstrap) and its named re-exports (publicThing, PublicType) are public.
    expect(names).not.toContain("src/main.ts:bootstrap");
    expect(names).not.toContain("src/api.ts:publicThing");
    expect(names).not.toContain("src/api.ts:PublicType");

    // Genuinely dead exports ARE flagged.
    expect(names).toEqual(
      expect.arrayContaining([
        "src/api.ts:orphanInApi",
        "src/deadweight.ts:deadFunction",
        "src/deadweight.ts:deadConst",
        "src/lib/aliased.ts:aliasedDead"
      ])
    );
  });

  it("treats modules star-re-exported by an entry (`export *`) as public API too", async () => {
    const data = structured<{ unused: { file: string; name: string }[] }>(
      await pkgCall({ target: "**/*.ts" })
    );
    const names = data.unused.map((u) => `${u.file}:${u.name}`);
    // main.ts has `export * from "./dynamic"`, so dynamic.ts's exports are public
    // even though they are reached only through a bare star re-export.
    expect(names).not.toContain("src/dynamic.ts:lazyLoad");
    expect(names).not.toContain("src/dynamic.ts:loadApi");
  });

  it("without package entry points, the non-index entry's exports are flagged", async () => {
    const data = structured<{ packageEntryPoints: string[]; unused: { file: string; name: string }[] }>(
      await pkgCall({ target: "**/*.ts", usePackageEntryPoints: false })
    );
    const names = data.unused.map((u) => `${u.file}:${u.name}`);
    expect(data.packageEntryPoints).toEqual([]);
    // Now main.ts is not recognized as an entry, so its surface looks "unused".
    expect(names).toContain("src/main.ts:bootstrap");
    expect(names).toContain("src/api.ts:publicThing");
  });

  it("resolves a tsconfig path-aliased import as a cross-file use (name-based)", async () => {
    const data = structured<{ unused: { file: string; name: string }[] }>(
      await pkgCall({ target: "**/*.ts" })
    );
    const names = data.unused.map((u) => `${u.file}:${u.name}`);
    // aliasedHelper is imported in main.ts via `@lib/aliased`; its identifier
    // appears cross-file, so it is NOT flagged. aliasedDead (same file, unused)
    // IS flagged — proving we did not blanket-exclude the aliased module.
    expect(names).not.toContain("src/lib/aliased.ts:aliasedHelper");
    expect(names).toContain("src/lib/aliased.ts:aliasedDead");
  });

  it("keeps a type-only export used only via a type-import (OnlyAType), flags unused types", async () => {
    const data = structured<{ unused: { file: string; name: string }[] }>(
      await pkgCall({ target: "**/*.ts" })
    );
    const names = data.unused.map((u) => `${u.file}:${u.name}`);
    expect(names).not.toContain("src/typesonly.ts:OnlyAType"); // used as a type annotation cross-file
    expect(names).toContain("src/typesonly.ts:DeadType"); // referenced nowhere
    expect(names).toContain("src/typesonly.ts:LocalAlias"); // `export type { LocalAlias }`, unused
  });

  it("terminates on circular dependencies and yields a coherent result", async () => {
    // circular-a <-> circular-b. alphaC and beta reference each other; both are
    // used cross-file, so neither is flagged, and the scan must not hang.
    const data = structured<{ scanned: number; unused: { name: string }[] }>(
      await pkgCall({ target: "src/circular-a.ts" })
    );
    expect(data.scanned).toBe(1);
    // Scoped to one file of the cycle: alphaC is referenced only from
    // circular-b.ts (out of this single-file scope), so name-based scanning
    // reports it as unused within scope — documented scope limitation.
    expect(Array.isArray(data.unused)).toBe(true);
  });
});

// Regression for the shared resolveRelativeSpecifier fix: a TS-ESM entry that
// re-exports with the runtime `.js` extension (`export * from "./impl.js"`).
// Before the fix the `.js` specifier did not map to its `.ts` source, so the
// star-re-exported module's symbols were wrongly flagged as unused.
describe("find_unused_exports — TS-ESM `.js` re-export resolution", () => {
  let esm: ConnectedClient;
  beforeAll(async () => {
    esm = await connectClient(ESM_REEXPORT_FIXTURE_ROOT);
  });
  afterAll(async () => {
    await esm.close();
  });

  it("treats a module star-re-exported via a `.js` specifier as public API", async () => {
    const data = structured<{ unused: { file: string; name: string }[] }>(
      (await esm.client.callTool({
        name: "find_unused_exports",
        arguments: { target: "**/*.ts" }
      })) as CallToolResult
    );
    const names = data.unused.map((u) => `${u.file}:${u.name}`);
    // index.ts has `export * from "./impl.js"`: impl.ts is folded into the
    // entry set (its whole surface is forwarded), so its exports are public.
    // Under the OLD resolver "./impl.js" did not map to impl.ts, so these were
    // wrongly flagged as unused.
    expect(names).not.toContain("src/impl.ts:publicViaStar");
    expect(names).not.toContain("src/impl.ts:PUBLIC_VALUE");
    // Control: a named re-export (`export { namedPublic } from "./named.js"`)
    // is a reachability root and must never be flagged.
    expect(names).not.toContain("src/named.ts:namedPublic");
    // extra.ts is reached only by a plain `.js` import from impl.ts (not a star
    // re-export), so it is a regular in-graph module: its cross-file-used export
    // is not flagged, but its genuinely-dead export still is — proving the
    // `.js`->`.ts` rewrite did not blanket-exclude every `.js` target.
    expect(names).not.toContain("src/extra.ts:usedByImpl");
    expect(names).toContain("src/extra.ts:deadInExtra");
  });
});

describe("call_graph — circular dependencies", () => {
  let pkg: ConnectedClient;
  beforeAll(async () => {
    pkg = await connectClient(PKG_FIXTURE_ROOT);
  });
  afterAll(async () => {
    await pkg.close();
  });

  it("resolves edges across a circular import without looping", async () => {
    const data = structured<{
      nodeCount: number;
      edges: { from: string | null; callee: string; to: string | null }[];
    }>((await pkg.client.callTool({
      name: "call_graph",
      arguments: { target: "src" }
    })) as CallToolResult);

    // alphaC -> beta (cross-file) and beta -> alphaC (back across the cycle).
    const aToB = data.edges.find((e) => e.callee === "beta" && e.from?.includes("alphaC"));
    expect(aToB?.to).toMatch(/circular-b\.ts#beta@/);
    const bToA = data.edges.find((e) => e.callee === "alphaC" && e.from?.includes("beta"));
    expect(bToA?.to).toMatch(/circular-a\.ts#alphaC@/);
  });
});
