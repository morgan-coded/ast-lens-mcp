/**
 * Tool: find_references
 *
 * Finds every reference to an identifier name across the project. This is a
 * name-based search (no full type resolution), classified by syntactic context
 * so the agent can tell a call site from an import from a declaration.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { spanOf } from "../core/parser.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import { snippetOf, traverse } from "../core/traverse.js";
import type { ReferenceInfo } from "../core/types.js";
import { ignoreSchema, responseFormatSchema, symbolNameSchema, targetSchema } from "./shared.js";

const inputSchema = z
  .object({
    name: symbolNameSchema,
    target: targetSchema
      .default("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}")
      .describe(
        "Scope to search, relative to project root. Defaults to the whole project. Narrow it (e.g. \"src\") for speed."
      ),
    includeDeclarations: z
      .boolean()
      .default(true)
      .describe("Include the declaration site(s) of the name, not just usages (default: true)."),
    ignore: ignoreSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(500)
      .describe("Maximum references to return (default: 500)."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerFindReferences(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "find_references",
    {
      title: "Find References",
      description: `Find every reference to an identifier name across the project (or a narrower scope), with file and line:column locations and a source snippet for each.

This is a fast, name-based search classified by syntactic context (call, import, declaration, type, jsx, reference). It does NOT perform full type-aware resolution, so identical names from different scopes/modules are all reported — use the snippet and context to disambiguate.

Args:
  - name (string): Exact identifier to find (case-sensitive). e.g. "createServer".
  - target (string): Scope to search (default: whole project). Narrow for speed, e.g. "src".
  - includeDeclarations (boolean): Include declaration sites (default: true).
  - ignore (string[], optional): Extra ignore globs, e.g. ["**/*.test.ts"].
  - limit (number): Max references returned, 1-2000 (default: 500).
  - response_format ('json' | 'markdown'): Output format (default: 'json').

Returns (JSON):
  {
    "name": string,
    "total": number,            // references found (before limit)
    "count": number,            // references returned
    "truncated": boolean,
    "references": [
      {
        "file": string,         // relative to root
        "span": { "start": {...}, "end": {...} },
        "context": "call"|"import"|"declaration"|"type"|"jsx"|"reference",
        "snippet": string       // trimmed source line
      }
    ],
    "byContext": { "call": n, "import": n, ... },
    "parseErrors": [...]
  }

Examples:
  - "Where is fetchUser called?" -> name="fetchUser" (filter references by context="call")
  - "Find all uses of the Logger symbol in src" -> name="Logger", target="src"

Notes:
  - Property accesses like obj.name match too; check the snippet to confirm relevance.
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
        const all: ReferenceInfo[] = [];

        for (const parsed of batch.parsed) {
          const displayFile = ctx.display(parsed.file);
          collectReferences(parsed.ast, parsed.code, input.name, displayFile, input.includeDeclarations, all);
        }

        const total = all.length;
        const references = all.slice(0, input.limit);
        const byContext: Record<string, number> = {};
        for (const r of all) byContext[r.context] = (byContext[r.context] ?? 0) + 1;

        const structured = {
          name: input.name,
          total,
          count: references.length,
          truncated: total > references.length,
          references,
          byContext,
          parseErrors: batch.parseErrors,
          ...(batch.truncated ? { discoveryTruncated: true } : {})
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured),
          narrowHint: "Lower 'limit', narrow 'target', or set includeDeclarations=false."
        });
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : String(err),
          "Check that target is inside the project root and name is a valid identifier."
        );
      }
    }
  );
}

/** Classify how an identifier reference is being used, from its parent context. */
function classify(path: NodePath<t.Identifier | t.JSXIdentifier>): ReferenceInfo["context"] {
  const parent = path.parent;

  // Declaration sites.
  if (
    (t.isFunctionDeclaration(parent) || t.isClassDeclaration(parent)) &&
    parent.id === path.node
  ) {
    return "declaration";
  }
  if (
    (t.isTSInterfaceDeclaration(parent) ||
      t.isTSTypeAliasDeclaration(parent) ||
      t.isTSEnumDeclaration(parent)) &&
    (parent as { id?: t.Node }).id === path.node
  ) {
    return "declaration";
  }
  if (t.isVariableDeclarator(parent) && parent.id === path.node) return "declaration";

  // Imports.
  if (
    t.isImportSpecifier(parent) ||
    t.isImportDefaultSpecifier(parent) ||
    t.isImportNamespaceSpecifier(parent)
  ) {
    return "import";
  }

  // JSX usage.
  if (t.isJSXIdentifier(path.node) || t.isJSXOpeningElement(parent) || t.isJSXClosingElement(parent)) {
    return "jsx";
  }

  // Type position (best-effort): TS type reference nodes.
  if (
    t.isTSTypeReference(parent) ||
    t.isTSTypeQuery(parent) ||
    t.isTSExpressionWithTypeArguments(parent) ||
    t.isTSQualifiedName(parent)
  ) {
    return "type";
  }

  // Call site: identifier is the callee of a call/new expression.
  if (
    (t.isCallExpression(parent) || t.isNewExpression(parent) || t.isOptionalCallExpression(parent)) &&
    parent.callee === path.node
  ) {
    return "call";
  }

  return "reference";
}

/** Collect references to `name` within one AST. */
function collectReferences(
  ast: t.File,
  code: string,
  name: string,
  file: string,
  includeDeclarations: boolean,
  out: ReferenceInfo[]
): void {
  // Dedupe by source position: a non-aliased `import { X }` has `imported` and
  // `local` pointing at the same identifier node, which the visitor can reach
  // twice. Keying on the span collapses those into one reference.
  const seen = new Set<string>();
  const push = (node: t.Identifier | t.JSXIdentifier, path: NodePath<t.Identifier | t.JSXIdentifier>): void => {
    if (node.name !== name) return;
    const context = classify(path);
    if (!includeDeclarations && context === "declaration") return;
    const span = spanOf(node);
    const key = `${span.start.line}:${span.start.column}:${span.end.line}:${span.end.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, span, snippet: snippetOf(code, node), context });
  };

  traverse(ast, {
    Identifier(path) {
      push(path.node, path);
    },
    JSXIdentifier(path) {
      push(path.node, path as unknown as NodePath<t.Identifier | t.JSXIdentifier>);
    }
  });
}

function renderMarkdown(data: {
  name: string;
  total: number;
  count: number;
  references: ReferenceInfo[];
  byContext: Record<string, number>;
}): string {
  const lines: string[] = [
    `# References to \`${data.name}\` (${data.total} found, showing ${data.count})`,
    "",
    `By context: ${Object.entries(data.byContext).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
    ""
  ];
  let currentFile = "";
  for (const r of data.references) {
    if (r.file !== currentFile) {
      currentFile = r.file;
      lines.push(`## ${currentFile}`);
    }
    lines.push(`- L${r.span.start.line}:${r.span.start.column} _(${r.context})_ — \`${r.snippet}\``);
  }
  return lines.join("\n");
}
