/**
 * Tool: get_file_outline
 *
 * Produces a hierarchical outline of a single file: module-level symbols with
 * class methods/properties, interface members, and enum members nested beneath.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { fileOutline } from "../core/extract.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import type { OutlineNode } from "../core/types.js";
import { responseFormatSchema, targetSchema } from "./shared.js";

const inputSchema = z
  .object({
    file: targetSchema.describe(
      "Path to a single source file to outline, relative to the project root (or absolute inside it). e.g. \"src/server.ts\"."
    ),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerGetFileOutline(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_file_outline",
    {
      title: "Get File Outline",
      description: `Produce a hierarchical outline of a single TypeScript/JavaScript file: top-level symbols with their nested members (class -> methods & properties, interface -> members, enum -> members).

Use this to understand the shape of one file (its classes and their methods, etc.) without reading the whole thing.

Args:
  - file (string): Path to ONE source file, relative to project root. e.g. "src/server.ts".
  - response_format ('json' | 'markdown'): Output format (default: 'json').

Returns (JSON):
  {
    "file": string,                 // path relative to root
    "outline": [
      {
        "name": string,
        "kind": "class"|"function"|"interface"|"enum"|"type"|"const"|...,
        "exported": boolean,
        "exportKind": "named"|"default"|"none",
        "span": { "start": {...}, "end": {...} },
        "children"?: [ { "name", "kind": "method"|"property"|"getter"|"setter", "static"?, "async"?, "span" } ]
      }
    ]
  }

Examples:
  - "Outline the UserService class file" -> file="src/services/user.ts"
  - "What methods does this controller have?" -> file="src/controllers/auth.ts" (read the class node's children)

Errors:
  - Returns an error if 'file' resolves to a directory, multiple files, or no file. Pass exactly one file path.
  - Files that fail to parse return an error result with the parse message and position.`,
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
        const batch = await ctx.loadBatch(input.file);

        if (batch.discovered === 0) {
          return errorResult(
            `No source file found at "${input.file}".`,
            "Pass a path to a single existing .ts/.tsx/.js/.jsx file inside the project root."
          );
        }
        if (batch.discovered > 1) {
          return errorResult(
            `"${input.file}" matched ${batch.discovered} files.`,
            "get_file_outline expects a single file. Use list_symbols for directories or globs."
          );
        }
        if (batch.parsed.length === 0) {
          const e = batch.parseErrors[0]!;
          const where = e.position ? ` at ${e.position.line}:${e.position.column}` : "";
          return errorResult(`Could not parse "${e.file}"${where}: ${e.message}`);
        }

        const parsed = batch.parsed[0]!;
        const outline = fileOutline(parsed.ast);
        const structured = {
          file: ctx.display(parsed.file),
          symbolCount: outline.length,
          outline
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured.file, outline)
        });
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : String(err),
          "Check that 'file' is a single valid path inside the project root."
        );
      }
    }
  );
}

function renderMarkdown(file: string, outline: OutlineNode[]): string {
  const lines: string[] = [`# Outline: ${file}`, ""];
  for (const node of outline) {
    const exp = node.exported ? (node.exportKind === "default" ? " (export default)" : " (export)") : "";
    lines.push(`- \`${node.kind}\` **${node.name}**${exp} — L${node.span.start.line}`);
    if (node.children) {
      for (const child of node.children) {
        const mods = [child.static ? "static" : "", child.async ? "async" : ""].filter(Boolean).join(" ");
        const modStr = mods ? `${mods} ` : "";
        lines.push(`    - ${modStr}\`${child.kind}\` ${child.name} — L${child.span.start.line}`);
      }
    }
  }
  return lines.join("\n");
}
