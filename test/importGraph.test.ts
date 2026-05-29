import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseCode } from "../src/core/parser.js";
import {
  aliasConfigFromTsconfig,
  buildImportGraph,
  extractModuleReferences,
  readTsconfigAliases,
  resolveSpecifier,
  type AliasConfig,
  type GraphFileInput
} from "../src/core/importGraph.js";
import {
  connectClient,
  IMPORT_GRAPH_FIXTURE_ROOT,
  structured,
  type ConnectedClient
} from "./helpers.js";

interface Edge {
  from: string;
  specifier: string;
  to: string | null;
  kind: "import" | "reexport" | "dynamic";
  resolution: "internal" | "external" | "unresolved";
  symbols: string[];
  typeOnly: boolean;
  span: { start: { line: number } };
}
interface Node {
  id: string;
  entry?: true;
}
interface GraphData {
  nodeCount: number;
  edgeCount: number;
  internalEdges: number;
  externalCount: number;
  unresolvedEdges: number;
  truncated: boolean;
  nodes: Node[];
  edges: Edge[];
  packageEntryPoints: string[];
  parseErrors: { file: string }[];
}

// ----------------------------------------------------------------------------
// Core engine: pure extraction + resolution (no MCP, no filesystem scan).
// ----------------------------------------------------------------------------

describe("import_graph core — module reference extraction", () => {
  function refsOf(code: string) {
    const r = parseCode(code, "m.ts");
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("parse failed");
    return extractModuleReferences(r.value.ast);
  }

  it("extracts static imports with their imported symbol names", () => {
    const refs = refsOf(
      [
        'import def, { a, b as c } from "./x";',
        'import * as ns from "./y";',
        'import "./side-effect";',
        'import type { OnlyType } from "./types";'
      ].join("\n")
    );
    const bySpec = new Map(refs.map((r) => [r.specifier, r]));
    expect(bySpec.get("./x")?.symbols.sort()).toEqual(["a", "b", "default"].sort());
    expect(bySpec.get("./y")?.symbols).toEqual(["*"]);
    expect(bySpec.get("./side-effect")?.symbols).toEqual([]); // side-effect import
    expect(bySpec.get("./types")?.typeOnly).toBe(true);
    expect(refs.every((r) => r.kind === "import")).toBe(true);
  });

  it("extracts re-exports (named, star, namespace) with origin-side names", () => {
    const refs = refsOf(
      [
        'export { a, b as c } from "./x";', // origin names a, b
        'export * from "./y";', // bare star -> "*"
        'export * as ns from "./z";' // namespace star -> "*"
      ].join("\n")
    );
    expect(refs.every((r) => r.kind === "reexport")).toBe(true);
    const bySpec = new Map(refs.map((r) => [r.specifier, r]));
    expect(bySpec.get("./x")?.symbols.sort()).toEqual(["a", "b"]);
    expect(bySpec.get("./y")?.symbols).toEqual(["*"]);
    expect(bySpec.get("./z")?.symbols).toEqual(["*"]);
  });

  it("extracts dynamic import() and require() with literal specifiers, skips non-literal", () => {
    const refs = refsOf(
      [
        'async function f(){ return import("./dyn"); }',
        'const r = require("./cjs");',
        "async function g(name){ return import(`./tmpl-${name}`); }" // non-literal: skipped
      ].join("\n")
    );
    const dyn = refs.filter((r) => r.kind === "dynamic");
    expect(dyn.map((r) => r.specifier).sort()).toEqual(["./cjs", "./dyn"]);
  });
});

describe("import_graph core — specifier resolution", () => {
  const known = new Set([
    "src/entry.ts",
    "src/helpers.ts",
    "src/util/index.ts",
    "src/lib/math.ts",
    "src/config/index.ts"
  ]);
  const alias: AliasConfig = {
    baseUrl: ".",
    entries: [
      { prefix: "@lib/", suffix: "", wildcard: true, targets: ["src/lib/*"] },
      { prefix: "@config", suffix: "", wildcard: false, targets: ["src/config/index.ts"] }
    ]
  };

  it("resolves a relative sibling with extension inference (internal)", () => {
    expect(resolveSpecifier("src/entry.ts", "./helpers", known, alias)).toEqual({
      to: "src/helpers.ts",
      resolution: "internal"
    });
  });

  it("resolves a `.js` specifier to its `.ts` source (ESM/NodeNext convention)", () => {
    // The dominant modern-TS ESM pattern: specifier carries ".js", file is ".ts".
    expect(resolveSpecifier("src/entry.ts", "./helpers.js", known, alias)).toEqual({
      to: "src/helpers.ts",
      resolution: "internal"
    });
    // A `.js` specifier targeting a directory index also resolves.
    expect(resolveSpecifier("src/entry.ts", "./util/index.js", known, alias)).toEqual({
      to: "src/util/index.ts",
      resolution: "internal"
    });
  });

  it("resolves an exact-extension specifier that matches a real file", () => {
    expect(resolveSpecifier("src/lazy.ts", "./config/index.ts", known, alias)).toEqual({
      to: "src/config/index.ts",
      resolution: "internal"
    });
  });

  it("resolves a directory import to its index file (internal)", () => {
    expect(resolveSpecifier("src/entry.ts", "./util", known, alias)).toEqual({
      to: "src/util/index.ts",
      resolution: "internal"
    });
  });

  it("resolves a wildcard tsconfig path alias (internal)", () => {
    expect(resolveSpecifier("src/entry.ts", "@lib/math", known, alias)).toEqual({
      to: "src/lib/math.ts",
      resolution: "internal"
    });
  });

  it("resolves an exact-key tsconfig path alias to its explicit file (internal)", () => {
    expect(resolveSpecifier("src/lazy.ts", "@config", known, alias)).toEqual({
      to: "src/config/index.ts",
      resolution: "internal"
    });
  });

  it("classifies a bare package specifier as external (not traversed)", () => {
    expect(resolveSpecifier("src/entry.ts", "react", known, alias)).toEqual({
      to: null,
      resolution: "external"
    });
    expect(resolveSpecifier("src/entry.ts", "node:fs/promises", known, alias)).toEqual({
      to: null,
      resolution: "external"
    });
  });

  it("classifies a relative specifier with no in-scope target as unresolved", () => {
    expect(resolveSpecifier("src/entry.ts", "./does-not-exist", known, alias)).toEqual({
      to: null,
      resolution: "unresolved"
    });
  });
});

describe("import_graph core — tsconfig alias parsing", () => {
  it("reads baseUrl-relative paths and builds wildcard + exact entries", () => {
    const cfg = aliasConfigFromTsconfig(
      {
        compilerOptions: {
          baseUrl: "./src",
          paths: { "@lib/*": ["lib/*"], "@config": ["config/index.ts"] }
        }
      },
      "/root"
    );
    const wild = cfg.entries.find((e) => e.prefix === "@lib/");
    expect(wild?.wildcard).toBe(true);
    expect(wild?.targets).toEqual(["src/lib/*"]); // joined onto baseUrl=src
    const exact = cfg.entries.find((e) => e.prefix === "@config");
    expect(exact?.wildcard).toBe(false);
    expect(exact?.targets).toEqual(["src/config/index.ts"]);
  });

  it("yields an empty alias set when there are no paths", () => {
    const cfg = aliasConfigFromTsconfig({ compilerOptions: { target: "ES2022" } }, "/root");
    expect(cfg.entries).toEqual([]);
  });

  it("tolerates JSONC (comments + trailing commas) when reading from disk", async () => {
    // The fixture tsconfig is plain JSON, but readTsconfigAliases must parse it.
    const cfg = await readTsconfigAliases(IMPORT_GRAPH_FIXTURE_ROOT);
    expect(cfg.entries.some((e) => e.prefix === "@lib/" && e.wildcard)).toBe(true);
    expect(cfg.entries.some((e) => e.prefix === "@config" && !e.wildcard)).toBe(true);
  });

  it("returns an empty alias set for a root with no tsconfig", async () => {
    const cfg = await readTsconfigAliases("/definitely/not/a/real/path/here");
    expect(cfg).toEqual({ baseUrl: ".", entries: [] });
  });
});

describe("import_graph core — graph assembly", () => {
  function fileInput(display: string, code: string): GraphFileInput {
    const r = parseCode(code, display);
    if (!r.ok) throw new Error(`parse failed for ${display}`);
    return { display, ast: r.value.ast };
  }

  it("emits internal edges, tallies external, and reports unresolved", () => {
    const files: GraphFileInput[] = [
      fileInput("src/a.ts", ['import { x } from "./b";', 'import "react";', 'import { z } from "./missing";'].join("\n")),
      fileInput("src/b.ts", "export const x = 1;")
    ];
    const alias: AliasConfig = { baseUrl: ".", entries: [] };

    const g = buildImportGraph(files, alias, { includeExternal: false });
    expect(g.internalCount).toBe(1);
    expect(g.externalCount).toBe(1);
    expect(g.unresolvedCount).toBe(1);
    // external suppressed by default => only internal + unresolved edges emitted.
    expect(g.edges).toHaveLength(2);
    const internal = g.edges.find((e) => e.resolution === "internal");
    expect(internal?.to).toBe("src/b.ts");
    expect(internal?.symbols).toEqual(["x"]);
    expect(g.edges.some((e) => e.resolution === "external")).toBe(false);

    const withExt = buildImportGraph(files, alias, { includeExternal: true });
    expect(withExt.edges).toHaveLength(3);
    const ext = withExt.edges.find((e) => e.resolution === "external");
    expect(ext?.specifier).toBe("react");
    expect(ext?.to).toBeNull();
  });
});

// ----------------------------------------------------------------------------
// End-to-end via the MCP server against the import-graph fixture project.
// ----------------------------------------------------------------------------

describe("import_graph tool (fixture project)", () => {
  let conn: ConnectedClient;
  beforeAll(async () => {
    conn = await connectClient(IMPORT_GRAPH_FIXTURE_ROOT);
  });
  afterAll(async () => {
    await conn.close();
  });
  const call = (args: Record<string, unknown>) =>
    conn.client.callTool({ name: "import_graph", arguments: args }) as Promise<CallToolResult>;

  const edge = (d: GraphData, from: string, specifier: string) =>
    d.edges.find((e) => e.from === from && e.specifier === specifier);

  it("builds a node per module and resolves relative + index + alias + dynamic edges", async () => {
    const d = structured<GraphData>(await call({ target: "src" }));

    // 9 source modules become nodes.
    expect(d.nodeCount).toBe(9);
    expect(d.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining([
        "src/entry.ts",
        "src/helpers.ts",
        "src/util/index.ts",
        "src/util/strings.ts",
        "src/util/numbers.ts",
        "src/lib/math.ts",
        "src/config/index.ts",
        "src/lazy.ts",
        "src/broken-import.ts"
      ])
    );

    // Relative import written with the ".js" ESM/NodeNext extension, resolved to
    // the ".ts" source file on disk.
    expect(edge(d, "src/entry.ts", "./helpers.js")).toMatchObject({
      to: "src/helpers.ts",
      resolution: "internal",
      kind: "import",
      symbols: ["add"]
    });
    // Directory-index resolution.
    expect(edge(d, "src/entry.ts", "./util")).toMatchObject({
      to: "src/util/index.ts",
      resolution: "internal",
      symbols: ["formatLabel"]
    });
    // tsconfig wildcard path alias.
    expect(edge(d, "src/entry.ts", "@lib/math")).toMatchObject({
      to: "src/lib/math.ts",
      resolution: "internal",
      symbols: ["square"]
    });
    // Dynamic import() resolved.
    expect(edge(d, "src/entry.ts", "./lazy")).toMatchObject({
      to: "src/lazy.ts",
      resolution: "internal",
      kind: "dynamic"
    });
    // Exact-key alias from a dynamically-imported module's own import.
    expect(edge(d, "src/lazy.ts", "@config")).toMatchObject({
      to: "src/config/index.ts",
      resolution: "internal",
      symbols: ["config"]
    });
  });

  it("resolves a re-export chain (`export *` and named re-export)", async () => {
    const d = structured<GraphData>(await call({ target: "src" }));
    expect(edge(d, "src/util/index.ts", "./strings")).toMatchObject({
      to: "src/util/strings.ts",
      resolution: "internal",
      kind: "reexport",
      symbols: ["*"]
    });
    expect(edge(d, "src/util/index.ts", "./numbers")).toMatchObject({
      to: "src/util/numbers.ts",
      resolution: "internal",
      kind: "reexport",
      symbols: ["clamp"]
    });
  });

  it("flags external (node_modules) imports separately and does not traverse them", async () => {
    const d = structured<GraphData>(await call({ target: "src" }));
    // react + node:fs/promises are the two external specifiers.
    expect(d.externalCount).toBe(2);
    // External edges are suppressed by default (not emitted), and no node was
    // created for an external package.
    expect(d.edges.some((e) => e.resolution === "external")).toBe(false);
    expect(d.nodes.some((n) => n.id === "react" || n.id.includes("node_modules"))).toBe(false);
  });

  it("emits external edges (with null target) when includeExternal=true", async () => {
    const d = structured<GraphData>(await call({ target: "src", includeExternal: true }));
    const react = edge(d, "src/entry.ts", "react");
    expect(react).toMatchObject({ resolution: "external", to: null, kind: "import" });
    expect(react?.symbols).toEqual(["useState"]);
    const node = edge(d, "src/broken-import.ts", "node:fs/promises");
    expect(node).toMatchObject({ resolution: "external", to: null });
  });

  it("reports an unresolved relative import (no in-scope target)", async () => {
    const d = structured<GraphData>(await call({ target: "src" }));
    expect(d.unresolvedEdges).toBe(1);
    expect(edge(d, "src/broken-import.ts", "./does-not-exist")).toMatchObject({
      resolution: "unresolved",
      to: null
    });
  });

  it("produces the expected edge tallies (includeExternal default off)", async () => {
    const d = structured<GraphData>(await call({ target: "src" }));
    // 7 internal: entry(helpers,util,math,lazy)=4 + util(strings,numbers)=2 + lazy(config)=1.
    expect(d.internalEdges).toBe(7);
    expect(d.unresolvedEdges).toBe(1);
    expect(d.externalCount).toBe(2);
    // Emitted edges = internal + unresolved (external suppressed) = 8.
    expect(d.edges).toHaveLength(8);
    expect(d.edgeCount).toBe(8);
  });

  it("respects the limit by capping nodes+edges and flagging truncation", async () => {
    const d = structured<GraphData>(await call({ target: "src", limit: 9 }));
    // 9 nodes fill the budget exactly, leaving no room for edges.
    expect(d.nodes).toHaveLength(9);
    expect(d.edges).toHaveLength(0);
    expect(d.truncated).toBe(true);
  });

  it("renders markdown when requested", async () => {
    const res = await call({ target: "src", response_format: "markdown" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^# Import graph/);
    expect(text).toContain("src/entry.ts");
    expect(text).toContain("→ src/helpers.ts");
  });

  it("has no package entry points for a fixture without package.json", async () => {
    const d = structured<GraphData>(await call({ target: "src" }));
    expect(d.packageEntryPoints).toEqual([]);
    expect(d.nodes.every((n) => n.entry === undefined)).toBe(true);
  });
});
