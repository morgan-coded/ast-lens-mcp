/**
 * Tool: search_ast
 *
 * Runs structural queries over the AST. Ships a set of curated named queries
 * (the kind of thing a reviewer or refactoring agent asks for) plus a generic
 * node-type filter for everything else.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as t from "@babel/types";
import type { NodePath } from "@babel/traverse";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { spanOf, type ParsedFile } from "../core/parser.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import { snippetOf, traverse } from "../core/traverse.js";
import type { MatchInfo } from "../core/types.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

const NAMED_QUERIES = [
  "calls_to",
  "any_usage",
  "await_in_loop",
  "empty_catch",
  "todo_fixme",
  "console_usage",
  "non_null_assertion",
  "ts_ignore",
  "node_type"
] as const;

type NamedQuery = (typeof NAMED_QUERIES)[number];

const inputSchema = z
  .object({
    query: z
      .enum(NAMED_QUERIES)
      .describe(
        "Which structural query to run: " +
          "'calls_to' (calls to a given callee — set 'callee'), " +
          "'any_usage' (TypeScript 'any' type annotations), " +
          "'await_in_loop' (await expressions inside loops — a common perf smell), " +
          "'empty_catch' (catch blocks with empty bodies), " +
          "'todo_fixme' (TODO/FIXME/HACK/XXX comments), " +
          "'console_usage' (console.* calls), " +
          "'non_null_assertion' (TypeScript '!' non-null assertions), " +
          "'ts_ignore' (@ts-ignore / @ts-expect-error comments), " +
          "'node_type' (generic: match any Babel node type — set 'nodeType')."
      ),
    target: targetSchema,
    callee: z
      .string()
      .optional()
      .describe(
        "For query='calls_to': the callee to match. Supports a bare name (\"fetch\") or a member expression (\"console.log\", \"axios.get\")."
      ),
    nodeType: z
      .string()
      .optional()
      .describe(
        "For query='node_type': the Babel node type to match, e.g. \"TryStatement\", \"AwaitExpression\", \"TSAnyKeyword\"."
      ),
    ignore: ignoreSchema,
    limit: z.number().int().min(1).max(2000).default(500).describe("Maximum matches to return (default: 500)."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerSearchAst(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "search_ast",
    {
      title: "Search AST",
      description: `Run structural queries across the AST of a file/directory/glob. Far more precise than text search because it understands code structure.

Named queries:
  - calls_to: find calls to a specific function or method. Set 'callee' to a name ("fetch") or member path ("console.log").
  - any_usage: every TypeScript 'any' type annotation (explicit type-safety holes).
  - await_in_loop: 'await' expressions inside for/while loops (often a sequential-await performance smell).
  - empty_catch: catch clauses with an empty body (swallowed errors).
  - todo_fixme: TODO/FIXME/HACK/XXX markers in comments.
  - console_usage: any console.* call (e.g. left-over debugging).
  - non_null_assertion: TypeScript non-null '!' assertions.
  - ts_ignore: @ts-ignore / @ts-expect-error suppression comments.
  - node_type: generic escape hatch — match any Babel AST node type via 'nodeType'.

Args:
  - query (enum): one of the queries above (required).
  - target (string): file, directory, or glob to search (relative to project root).
  - callee (string, optional): required when query='calls_to'.
  - nodeType (string, optional): required when query='node_type' (e.g. "AwaitExpression", "TSAnyKeyword").
  - ignore (string[], optional): extra ignore globs.
  - limit (number): max matches, 1-2000 (default 500).
  - response_format ('json' | 'markdown'): output format (default 'json').

Returns (JSON):
  {
    "query": string,
    "total": number, "count": number, "truncated": boolean,
    "matches": [
      { "file": string, "nodeType": string, "span": {...}, "snippet": string, "detail"?: string }
    ],
    "parseErrors": [...]
  }

Examples:
  - "Find every console.log left in src" -> query="console_usage", target="src" (or calls_to with callee="console.log")
  - "Where do we use 'any'?" -> query="any_usage", target="src/**/*.ts"
  - "Find awaits inside loops" -> query="await_in_loop", target="src"
  - "Find all try/catch statements" -> query="node_type", nodeType="TryStatement", target="src"

Errors:
  - query='calls_to' without 'callee', or query='node_type' without 'nodeType', returns an actionable error.`,
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
        if (input.query === "calls_to" && !input.callee) {
          return errorResult("query='calls_to' requires a 'callee'.", 'e.g. callee="console.log" or callee="fetch".');
        }
        if (input.query === "node_type" && !input.nodeType) {
          return errorResult(
            "query='node_type' requires a 'nodeType'.",
            'e.g. nodeType="TryStatement" or nodeType="AwaitExpression".'
          );
        }

        const batch = await ctx.loadBatch(input.target, input.ignore ? { ignore: input.ignore } : undefined);
        const all: MatchInfo[] = [];

        for (const parsed of batch.parsed) {
          runQuery(input.query, input, parsed, ctx.display(parsed.file), all);
        }

        const total = all.length;
        const matches = all.slice(0, input.limit);

        const structured = {
          query: input.query,
          ...(input.callee ? { callee: input.callee } : {}),
          ...(input.nodeType ? { nodeType: input.nodeType } : {}),
          total,
          count: matches.length,
          truncated: total > matches.length,
          matches,
          parseErrors: batch.parseErrors,
          ...(batch.truncated ? { discoveryTruncated: true } : {})
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured),
          narrowHint: "Lower 'limit' or narrow 'target'."
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err), "Check the query inputs and target path.");
      }
    }
  );
}

/** Build a dotted name for a callee expression (best-effort).
 *
 * Handles both regular member access (`a.b`) and optional chaining
 * (`a?.b`, `a?.b()`): an optional call's callee is an OptionalMemberExpression,
 * so without this a `logger?.log()` call would be missed entirely. */
function calleeName(node: t.Expression | t.V8IntrinsicIdentifier | t.PrivateName): string | undefined {
  if (t.isIdentifier(node)) return node.name;
  if ((t.isMemberExpression(node) || t.isOptionalMemberExpression(node)) && !node.computed) {
    const obj = calleeName(node.object as t.Expression);
    const prop = t.isIdentifier(node.property) ? node.property.name : undefined;
    if (obj && prop) return `${obj}.${prop}`;
    if (prop) return prop;
  }
  return undefined;
}

const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/;
const TS_SUPPRESS_RE = /@ts-(ignore|expect-error|nocheck)/;

function runQuery(query: NamedQuery, input: Input, parsed: ParsedFile, file: string, out: MatchInfo[]): void {
  const { ast, code } = parsed;
  const add = (node: t.Node, detail?: string): void => {
    out.push({
      file,
      nodeType: node.type,
      span: spanOf(node),
      snippet: snippetOf(code, node),
      ...(detail ? { detail } : {})
    });
  };

  switch (query) {
    case "calls_to": {
      const wanted = input.callee!;
      traverse(ast, {
        "CallExpression|OptionalCallExpression|NewExpression"(path) {
          const node = path.node as t.CallExpression | t.OptionalCallExpression | t.NewExpression;
          const name = calleeName(node.callee as t.Expression);
          if (name === wanted || (!wanted.includes(".") && name?.split(".").pop() === wanted)) {
            add(node, name);
          }
        }
      });
      break;
    }

    case "console_usage": {
      traverse(ast, {
        "CallExpression|OptionalCallExpression"(path) {
          const node = path.node as t.CallExpression | t.OptionalCallExpression;
          const name = calleeName(node.callee as t.Expression);
          if (name && (name === "console" || name.startsWith("console."))) add(node, name);
        }
      });
      break;
    }

    case "any_usage": {
      traverse(ast, {
        TSAnyKeyword(path) {
          add(path.node, "any");
        }
      });
      break;
    }

    case "non_null_assertion": {
      traverse(ast, {
        TSNonNullExpression(path) {
          add(path.node);
        }
      });
      break;
    }

    case "await_in_loop": {
      traverse(ast, {
        AwaitExpression(path) {
          if (isInsideLoopWithinSameFunction(path)) add(path.node);
        }
      });
      break;
    }

    case "empty_catch": {
      traverse(ast, {
        CatchClause(path) {
          if (path.node.body.body.length === 0) add(path.node);
        }
      });
      break;
    }

    case "todo_fixme": {
      for (const comment of ast.comments ?? []) {
        const m = TODO_RE.exec(comment.value);
        if (m) {
          out.push({
            file,
            nodeType: comment.type,
            span: spanOf(comment),
            snippet: comment.value.trim().split(/\r?\n/)[0]!.slice(0, 200),
            detail: m[1]
          });
        }
      }
      break;
    }

    case "ts_ignore": {
      for (const comment of ast.comments ?? []) {
        const m = TS_SUPPRESS_RE.exec(comment.value);
        if (m) {
          out.push({
            file,
            nodeType: comment.type,
            span: spanOf(comment),
            snippet: comment.value.trim().slice(0, 200),
            detail: `@ts-${m[1]}`
          });
        }
      }
      break;
    }

    case "node_type": {
      const wanted = input.nodeType!;
      traverse(ast, {
        enter(path) {
          if (path.node.type === wanted) add(path.node);
        }
      });
      break;
    }
  }
}

/**
 * True when an await sits inside a loop, but not separated from it by a nested
 * function boundary (an await in a nested function is a different scope).
 */
function isInsideLoopWithinSameFunction(path: NodePath<t.AwaitExpression>): boolean {
  let current: NodePath | null = path.parentPath;
  while (current) {
    const node = current.node;
    if (
      t.isForStatement(node) ||
      t.isForInStatement(node) ||
      t.isForOfStatement(node) ||
      t.isWhileStatement(node) ||
      t.isDoWhileStatement(node)
    ) {
      return true;
    }
    if (t.isFunction(node)) return false; // crossed a function boundary first
    current = current.parentPath;
  }
  return false;
}

function renderMarkdown(data: { query: string; total: number; count: number; matches: MatchInfo[] }): string {
  const lines: string[] = [`# search_ast: ${data.query} (${data.total} matches, showing ${data.count})`, ""];
  let currentFile = "";
  for (const m of data.matches) {
    if (m.file !== currentFile) {
      currentFile = m.file;
      lines.push(`## ${currentFile}`);
    }
    const detail = m.detail ? ` _(${m.detail})_` : "";
    lines.push(`- L${m.span.start.line}:${m.span.start.column} \`${m.nodeType}\`${detail} — \`${m.snippet}\``);
  }
  return lines.join("\n");
}
