/**
 * Tool: detect_circular_deps
 *
 * Builds the import graph among the target's modules (resolving relative
 * specifiers, index files, omitted extensions, and best-effort tsconfig `paths`
 * aliases; external/node_modules specifiers are leaves) and reports the cycles
 * in that graph — each as the ordered module path forming the loop. Reuses
 * summarize_module's import extraction (via core/moduleGraph) and the
 * relative/index/extension resolution style from core/entryPoints.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import {
  buildModuleGraph,
  emptyAliasConfig,
  findCycles,
  loadPathAliases,
  type Cycle,
  type ModuleEdge
} from "../core/moduleGraph.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

const inputSchema = z
  .object({
    target: targetSchema
      .default("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}")
      .describe(
        "Scope to analyze, relative to project root. Defaults to the whole project. Only modules INSIDE this scope are graph nodes; imports of files outside it are treated as leaves (no edge)."
      ),
    includeDynamic: z
      .boolean()
      .default(true)
      .describe(
        "Treat dynamic import() and require() specifiers as dependency edges (default: true). Set false to consider only static import / export-from edges."
      ),
    includeTypeOnly: z
      .boolean()
      .default(true)
      .describe(
        "Treat type-only imports/exports (`import type ...`) as edges (default: true). A type-only cycle is harmless at runtime but still a design signal; set false to ignore them."
      ),
    useTsconfigPaths: z
      .boolean()
      .default(true)
      .describe(
        "Resolve tsconfig `paths` aliases (baseUrl + paths) when mapping specifiers to files (default: true). Best-effort, single tsconfig.json at the project root; `extends` is not followed."
      ),
    ignore: ignoreSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(1000)
      .describe("Maximum cycles to enumerate/return (default: 1000). Dense graphs can have very many elementary cycles."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerDetectCircularDeps(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "detect_circular_deps",
    {
      title: "Detect Circular Dependencies",
      description: `Find circular import dependencies (cycles in the module graph) among the files in a scope. Each cycle is returned as the ordered list of modules forming the loop (edges connect consecutive modules, and the last back to the first).

How the graph is built (path-based, no type info):
  - A module's outgoing edges come from its static imports, \`export ... from\` re-exports, and (by default) dynamic import()/require() specifiers — reusing the same import extraction as summarize_module.
  - Specifiers are resolved like a bundler/TS would, against the files IN SCOPE: relative paths (\`./x\`, \`../y\`), omitted extensions (.ts/.tsx/.js/...), and directory \`index.*\` files. tsconfig \`paths\` aliases (baseUrl + paths) are resolved best-effort when useTsconfigPaths is true.
  - Bare/external specifiers (node_modules packages, \`node:\` builtins) and imports of files OUTSIDE the scope are treated as leaves — they create no edge.

Cycle detection:
  - Strongly-connected components are found first; each non-trivial SCC's ELEMENTARY circuits are enumerated (Johnson's algorithm) so each distinct loop is reported once, not once per rotation. A module importing itself is reported as a single-element self-import cycle. Multiple independent cycles are all reported.

Args:
  - target (string): scope to analyze (default: whole project). Only in-scope modules are nodes.
  - includeDynamic (boolean): count dynamic import()/require() as edges (default true).
  - includeTypeOnly (boolean): count type-only imports/exports as edges (default true).
  - useTsconfigPaths (boolean): resolve tsconfig path aliases (default true).
  - ignore (string[], optional): extra ignore globs, e.g. ["**/*.test.ts"].
  - limit (number): max cycles enumerated, 1-5000 (default 1000).
  - response_format ('json' | 'markdown'): output format (default 'json').

Returns (JSON):
  {
    "scanned": number,            // modules analyzed (graph nodes)
    "edgeCount": number,          // resolved in-scope import edges
    "cycleCount": number,         // cycles found (before limit)
    "count": number,              // cycles returned
    "truncated": boolean,         // cycle enumeration hit 'limit'
    "hasCycles": boolean,
    "cycles": [
      { "length": number, "selfImport": boolean, "modules": [string, ...] }  // ordered loop; modules are root-relative
    ],
    "unresolvedLocal": [ { "from": string, "specifier": string } ],  // local/aliased specifiers that did not resolve in scope (caveat)
    "parseErrors": [...]
  }

Examples:
  - "Are there any circular imports in src?" -> target="src"
  - "Find runtime-only import cycles (ignore type-only)" -> target="src", includeTypeOnly=false

Notes:
  - A cycle's modules are listed in loop order, rotated to start at the lexicographically smallest member so the same loop has one canonical representation.
  - Edges only connect modules inside 'target'; widen the scope (e.g. the whole package) to catch cycles that cross it.
  - Dynamic import() often breaks a runtime cycle deliberately; set includeDynamic=false to see only static cycles. Specifiers that look local but resolve outside scope / cannot be mapped are reported under unresolvedLocal.
  - Files that fail to parse are reported under parseErrors and contribute no edges.`,
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

        const aliases = input.useTsconfigPaths
          ? await loadPathAliases(ctx.root)
          : emptyAliasConfig(ctx.root);

        const modules = batch.parsed.map((p) => ({ ast: p.ast, display: ctx.display(p.file) }));
        const graph = buildModuleGraph({
          modules,
          aliases,
          includeDynamic: input.includeDynamic,
          includeTypeOnly: input.includeTypeOnly
        });

        const { cycles, truncated } = findCycles(graph, input.limit);

        const structured = {
          scanned: graph.nodes.length,
          edgeCount: graph.edges.length,
          cycleCount: cycles.length,
          count: cycles.length,
          truncated,
          hasCycles: cycles.length > 0,
          cycles: cycles.map((c) => ({
            length: c.modules.length,
            selfImport: c.selfImport,
            modules: c.modules
          })),
          unresolvedLocal: graph.unresolvedLocal,
          parseErrors: batch.parseErrors,
          ...(batch.truncated ? { discoveryTruncated: true } : {})
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured),
          narrowHint: "Lower 'limit' or narrow 'target'."
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
  scanned: number;
  edgeCount: number;
  cycleCount: number;
  count: number;
  cycles: Array<{ length: number; selfImport: boolean; modules: string[] }>;
  unresolvedLocal: Array<{ from: string; specifier: string }>;
}): string {
  const lines: string[] = [
    `# Circular dependencies (${data.cycleCount} found, showing ${data.count})`,
    "",
    `Scanned ${data.scanned} modules, ${data.edgeCount} in-scope import edges.`,
    ""
  ];
  if (data.cycles.length === 0) {
    lines.push("No circular dependencies detected.");
  } else {
    for (const c of data.cycles) {
      if (c.selfImport) {
        lines.push(`- self-import: \`${c.modules[0]}\``);
      } else {
        lines.push(`- (${c.length}) ${c.modules.map((m) => `\`${m}\``).join(" → ")} → \`${c.modules[0]}\``);
      }
    }
  }
  if (data.unresolvedLocal.length > 0) {
    lines.push("", `## Unresolved local specifiers (${data.unresolvedLocal.length})`);
    for (const u of data.unresolvedLocal) {
      lines.push(`- \`${u.from}\` → \`${u.specifier}\` (out of scope or unmappable)`);
    }
  }
  return lines.join("\n");
}

// Re-export the edge type for any downstream consumer/tests that want it.
export type { Cycle, ModuleEdge };
