import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { connectClient, structured, type ConnectedClient } from "./helpers.js";

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
  it("lists all six tools with schemas and annotations", async () => {
    const { tools } = await conn.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "analyze_complexity",
        "find_references",
        "get_file_outline",
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
