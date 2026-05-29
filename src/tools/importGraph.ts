/**
 * Tool: import_graph
 *
 * Builds a real module import/export resolution graph for a file/dir/glob: every
 * scanned file is a node, and every import, re-export, and dynamic import() is a
 * resolved edge from the importing module to the imported one, carrying the
 * symbol names that cross it. Relative paths, extension/index inference, tsconfig
 * `paths` aliases, re-exports (named, star, namespace), and dynamic import()/
 * require() are all resolved; external (node_modules) and unresolved imports are
 * flagged separately and external targets are never traversed.
 *
 * This is the resolution infrastructure that makes downstream unused-export,
 * dead-file, and circular-dependency analysis accurate (vs. the name-based
 * approximation find_unused_exports uses today).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { resolvePackageEntryPoints } from "../core/entryPoints.js";
import {
  buildImportGraph,
  readTsconfigAliases,
  type GraphFileInput,
  type ImportGraphEdge,
  type ImportGraphNode
} from "../core/importGraph.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

const inputSchema = z
  .object({
    target: targetSchema
      .default("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}")
      .describe(
        "Scope to build the graph over, relative to project root. Defaults to the whole project. " +
          "Only files INSIDE this scope become nodes; specifiers pointing outside it resolve as 'unresolved'. " +
          "Prefer the whole project (or a self-contained package) so internal edges resolve."
      ),
    includeExternal: z
      .boolean()
      .default(false)
      .describe(
        "Emit edges to external (node_modules) packages. They are tallied either way (externalCount) but NEVER traversed — node_modules is not parsed. Their 'to' is null. Default: false."
      ),
    usePackageEntryPoints: z
      .boolean()
      .default(true)
      .describe(
        "Surface the project's package.json entry points (main/module/bin/exports, mapped from build output back to likely source files) under 'packageEntryPoints', and flag matching nodes with entry=true. This identifies graph roots without changing edges. Consistent with find_unused_exports. Default: true."
      ),
    ignore: ignoreSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .default(4000)
      .describe("Maximum combined nodes+edges to return (default: 4000)."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerImportGraph(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "import_graph",
    {
      title: "Import Graph",
      description: `Build a module import/export resolution graph for a file, directory, or glob: every scanned file is a NODE (module) and every import / re-export / dynamic import is a resolved EDGE from the importing module to the imported one, with the symbol names that cross the edge.

Unlike the name-based reachability in find_unused_exports, this RESOLVES specifiers to concrete files:
  - Relative imports ("./x", "../y") with extension and directory-index inference ("./util" -> util/index.ts).
  - tsconfig \`paths\` aliases (baseUrl + paths, exact keys and single-wildcard "@lib/*"); read from the project root's tsconfig.json/jsconfig.json (\`extends\` is NOT followed).
  - Re-exports: \`export { a } from "x"\`, \`export * from "x"\`, \`export * as ns from "x"\` (origin-side names; "*" for a bare star).
  - Dynamic \`import("x")\` and \`require("x")\` with a string-literal specifier.

Each edge is classified by how its specifier resolved:
  - "internal": resolved to a file IN SCOPE — 'to' is that module's path.
  - "external": a bare package specifier (e.g. "react", "node:fs"). Tallied in externalCount and emitted only with includeExternal=true; node_modules is NEVER parsed or traversed; 'to' is null.
  - "unresolved": a relative/aliased specifier that matched no in-scope file (a typo, a missing file, or a target outside 'target'); 'to' is null.

Resolution is path-based and dependency-free, so it works against the files actually in scope: a real import whose target is OUTSIDE 'target' shows as unresolved. Scope to the whole project (or a self-contained package) for a complete graph. Non-literal dynamic specifiers (template strings, variables) cannot be resolved and are skipped.

Args:
  - target (string): file, directory, or glob (default: whole project).
  - includeExternal (boolean): emit external package edges (default false; always counted).
  - usePackageEntryPoints (boolean): mark package.json entry-point modules with entry=true and list them (default true).
  - ignore (string[], optional): extra ignore globs.
  - limit (number): max combined nodes+edges, 1-10000 (default 4000).
  - response_format ('json' | 'markdown'): output format (default 'json').

Returns (JSON):
  {
    "nodeCount": number, "edgeCount": number,
    "internalEdges": number, "externalCount": number, "unresolvedEdges": number,
    "truncated": boolean,
    "nodes": [ { "id": string, "entry"?: true } ],
    "edges": [ { "from": string, "specifier": string, "to": string|null,
                 "kind": "import"|"reexport"|"dynamic",
                 "resolution": "internal"|"external"|"unresolved",
                 "symbols": string[], "typeOnly": boolean, "span": {...} } ],
    "packageEntryPoints": string[],
    "parseErrors": [...]
  }

Examples:
  - "Map the import graph of src" -> target="src"
  - "What does this package import from node_modules?" -> target="src", includeExternal=true
  - "Find broken/dead-end imports" -> scan the whole project; inspect edges where resolution="unresolved".

Notes:
  - Symbols on an edge are the imported / re-exported names ("default", "*", or named bindings).
  - Files that fail to parse are reported under parseErrors (never crash the scan).`,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: Input) => {
      try {
        const batch = await ctx.loadBatch(input.target, input.ignore ? { ignore: input.ignore } : undefined);

        // tsconfig paths aliases are read from the project root (best-effort).
        const alias = await readTsconfigAliases(ctx.root);

        const files: GraphFileInput[] = batch.parsed.map((p) => ({
          display: ctx.display(p.file),
          ast: p.ast
        }));

        const graph = buildImportGraph(files, alias, { includeExternal: input.includeExternal });

        // Mark graph roots from package.json entry points (does not change edges;
        // mirrors find_unused_exports' entry-point seeding so the two tools agree
        // on what the package's public roots are).
        let packageEntryPoints: string[] = [];
        const entryNodeIds = new Set<string>();
        if (input.usePackageEntryPoints) {
          const resolution = await resolvePackageEntryPoints(ctx.root);
          packageEntryPoints = resolution.declared;
          const candidates = new Set(resolution.sourceCandidates);
          for (const node of graph.nodes) {
            if (candidates.has(node.id)) entryNodeIds.add(node.id);
          }
        }

        const nodes: Array<ImportGraphNode & { entry?: true }> = graph.nodes
          .map((n) => (entryNodeIds.has(n.id) ? { ...n, entry: true as const } : n))
          .sort((a, b) => a.id.localeCompare(b.id));

        // Size guard: cap the combined node+edge payload, keeping all nodes first
        // (the skeleton) then as many edges as fit. Same strategy as call_graph.
        const limit = input.limit;
        let outNodes = nodes;
        let outEdges = graph.edges;
        let truncated = false;
        if (nodes.length + graph.edges.length > limit) {
          truncated = true;
          if (nodes.length >= limit) {
            outNodes = nodes.slice(0, limit);
            outEdges = [];
          } else {
            outEdges = graph.edges.slice(0, limit - nodes.length);
          }
        }

        const structured = {
          nodeCount: nodes.length,
          edgeCount: graph.edges.length,
          internalEdges: graph.internalCount,
          externalCount: graph.externalCount,
          unresolvedEdges: graph.unresolvedCount,
          truncated,
          nodes: outNodes,
          edges: outEdges,
          packageEntryPoints,
          parseErrors: batch.parseErrors,
          ...(batch.truncated ? { discoveryTruncated: true } : {})
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured),
          narrowHint: "Narrow 'target', set includeExternal=false, or lower 'limit'."
        });
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : String(err),
          "Check that target is inside the project root."
        );
      }
    }
  );
}

function renderMarkdown(data: {
  nodeCount: number;
  edgeCount: number;
  internalEdges: number;
  externalCount: number;
  unresolvedEdges: number;
  nodes: Array<ImportGraphNode & { entry?: true }>;
  edges: ImportGraphEdge[];
}): string {
  const lines: string[] = [
    `# Import graph (${data.nodeCount} modules, ${data.edgeCount} edges)`,
    "",
    `Internal: ${data.internalEdges} · external packages: ${data.externalCount} · unresolved: ${data.unresolvedEdges}`,
    ""
  ];

  // Group edges by importing module for readability.
  const byFrom = new Map<string, ImportGraphEdge[]>();
  for (const e of data.edges) {
    (byFrom.get(e.from) ?? byFrom.set(e.from, []).get(e.from)!).push(e);
  }
  const entryIds = new Set(data.nodes.filter((n) => n.entry).map((n) => n.id));

  for (const [from, edges] of byFrom) {
    const tag = entryIds.has(from) ? " _(entry)_" : "";
    lines.push(`## ${from}${tag}`);
    for (const e of edges) {
      const target =
        e.resolution === "internal"
          ? `→ ${e.to}`
          : e.resolution === "external"
            ? `→ ${e.specifier} _(external)_`
            : `→ ${e.specifier} _(unresolved)_`;
      const sym = e.symbols.length ? ` { ${e.symbols.join(", ")} }` : "";
      const kindTag = e.kind === "import" ? "" : ` _[${e.kind}]_`;
      lines.push(`- ${target}${sym}${kindTag} — L${e.span.start.line}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
