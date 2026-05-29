/**
 * Tool: call_graph
 *
 * Builds a function -> function call graph for a file/dir/glob: every
 * function-like definition is a node, every call site is an edge from the
 * enclosing function to the callee. Callee resolution is name-based (the same
 * resolver search_ast uses), best-effort across files in scope.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { buildFileCallGraph } from "../core/extract.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import type { CallGraphEdge, CallGraphNode } from "../core/types.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

const inputSchema = z
  .object({
    target: targetSchema,
    includeExternalCalls: z
      .boolean()
      .default(false)
      .describe(
        "Keep edges to callees that do NOT resolve to a function defined in scope (library calls, methods, built-ins). Their 'to' is null. Default: false (only intra-graph edges)."
      ),
    includeAnonymous: z
      .boolean()
      .default(true)
      .describe("Include anonymous functions (callbacks, IIFEs) as nodes (default: true)."),
    ignore: ignoreSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(2000)
      .describe("Maximum combined nodes+edges to return (default: 2000)."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerCallGraph(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "call_graph",
    {
      title: "Call Graph",
      description: `Build a function-to-function call graph for a file, directory, or glob: a list of function NODES and the call EDGES between them.

Each function-like definition (declaration, function/arrow expression, class & object method) is a node with a stable id "<file>#<name>@<line>". Each call site becomes an edge from the enclosing function (\`from\`, or null at module top level) to the callee. Callee resolution is NAME-BASED, using the same resolver as search_ast (bare names like "fetch" and member paths like "service.create", including optional chaining).

Resolution & limits (name-based, no type info):
  - An edge's 'to' is the node id of the called function when the callee name (its final segment for member calls) matches exactly one defined function — preferring a definition in the SAME file, then a unique project-wide match. Ambiguous or undefined callees keep 'to': null.
  - Method/dynamic dispatch is approximate: \`x.run()\` resolves to a method named "run" only if exactly one such method exists in scope; otherwise it is left unresolved.
  - Calls to library/built-in functions resolve to null. Set includeExternalCalls=true to keep them (useful for "what does this call out to"), false to keep only edges inside the graph.

Args:
  - target (string): file, directory, or glob (relative to project root).
  - includeExternalCalls (boolean): keep unresolved (external) call edges (default false).
  - includeAnonymous (boolean): include anonymous functions as nodes (default true).
  - ignore (string[], optional): extra ignore globs.
  - limit (number): max combined nodes+edges, 1-5000 (default 2000).
  - response_format ('json' | 'markdown'): output format (default 'json').

Returns (JSON):
  {
    "nodeCount": number, "edgeCount": number,
    "unresolvedCallees": number,    // distinct callee names with no matching node
    "truncated": boolean,
    "nodes": [ { "id": string, "name": string, "file": string, "kind": string, "span": {...} } ],
    "edges": [ { "from": string|null, "callee": string, "to": string|null, "file": string, "span": {...} } ],
    "parseErrors": [...]
  }

Examples:
  - "Map the call graph of the parser module" -> target="src/core"
  - "What does src/server.ts call out to, including libraries?" -> target="src/server.ts", includeExternalCalls=true

Notes:
  - 'from' is null for calls made at module top level (outside any function).
  - Files that fail to parse are reported under parseErrors.`,
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

        const nodes: CallGraphNode[] = [];
        const rawEdges: CallGraphEdge[] = [];
        for (const parsed of batch.parsed) {
          const { nodes: fnNodes, edges } = buildFileCallGraph(parsed.ast, ctx.display(parsed.file));
          for (const n of fnNodes) {
            if (!input.includeAnonymous && n.name === "<anonymous>") continue;
            nodes.push(n);
          }
          for (const e of edges) rawEdges.push(e);
        }

        // Build name -> node ids index for callee resolution. Index by node name;
        // a member-call callee resolves on its final segment.
        const idsByName = new Map<string, string[]>();
        const fileById = new Map<string, string>();
        for (const n of nodes) {
          (idsByName.get(n.name) ?? idsByName.set(n.name, []).get(n.name)!).push(n.id);
          fileById.set(n.id, n.file);
        }

        const unresolved = new Set<string>();
        const edges: CallGraphEdge[] = [];
        for (const e of rawEdges) {
          const finalSeg = e.callee.includes(".") ? e.callee.split(".").pop()! : e.callee;
          const to = resolveCallee(finalSeg, e.file, idsByName, fileById);
          if (to === null) unresolved.add(e.callee);
          // Drop edges originating from an anonymous node we excluded.
          if (!input.includeAnonymous && e.from !== null && !fileById.has(e.from)) continue;
          if (to === null && !input.includeExternalCalls) continue;
          edges.push({ ...e, to });
        }

        // Size guard: cap the combined node+edge payload, keeping all nodes first
        // (the skeleton) then as many edges as fit.
        const limit = input.limit;
        let outNodes = nodes;
        let outEdges = edges;
        let truncated = false;
        if (nodes.length + edges.length > limit) {
          truncated = true;
          if (nodes.length >= limit) {
            outNodes = nodes.slice(0, limit);
            outEdges = [];
          } else {
            outEdges = edges.slice(0, limit - nodes.length);
          }
        }

        const structured = {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          unresolvedCallees: unresolved.size,
          truncated,
          nodes: outNodes,
          edges: outEdges,
          parseErrors: batch.parseErrors,
          ...(batch.truncated ? { discoveryTruncated: true } : {})
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured),
          narrowHint: "Narrow 'target', set includeExternalCalls=false, or lower 'limit'."
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err), "Check that target is inside the project root.");
      }
    }
  );
}

/**
 * Resolve a callee name to a single node id. Prefers a definition in the same
 * file; otherwise accepts a unique project-wide match. Returns null when the
 * name is unknown or ambiguous across files.
 */
function resolveCallee(
  name: string,
  callerFile: string,
  idsByName: Map<string, string[]>,
  fileById: Map<string, string>
): string | null {
  const ids = idsByName.get(name);
  if (!ids || ids.length === 0) return null;
  if (ids.length === 1) return ids[0]!;
  // Multiple candidates: prefer a unique same-file definition.
  const sameFile = ids.filter((id) => fileById.get(id) === callerFile);
  if (sameFile.length === 1) return sameFile[0]!;
  // Ambiguous across files (and not uniquely local) — leave unresolved.
  return null;
}

function renderMarkdown(data: {
  nodeCount: number;
  edgeCount: number;
  unresolvedCallees: number;
  nodes: CallGraphNode[];
  edges: CallGraphEdge[];
}): string {
  const nameById = new Map(data.nodes.map((n) => [n.id, n.name] as const));
  const lines: string[] = [
    `# Call graph (${data.nodeCount} functions, ${data.edgeCount} edges)`,
    "",
    `Unresolved callee names: ${data.unresolvedCallees}`,
    ""
  ];
  // Group edges by caller for readability.
  const byCaller = new Map<string, CallGraphEdge[]>();
  for (const e of data.edges) {
    const key = e.from ?? "(top-level)";
    (byCaller.get(key) ?? byCaller.set(key, []).get(key)!).push(e);
  }
  for (const [caller, edges] of byCaller) {
    const callerName = caller === "(top-level)" ? `${edges[0]?.file ?? ""} (top-level)` : nameById.get(caller) ?? caller;
    lines.push(`## ${callerName}`);
    for (const e of edges) {
      const target = e.to ? nameById.get(e.to) ?? e.callee : `${e.callee} _(external)_`;
      lines.push(`- → ${target} — L${e.span.start.line}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
