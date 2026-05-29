/**
 * Tool: summarize_module
 *
 * Summarizes one file's imports, exports, and dependency specifiers (split into
 * local vs external).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { summarizeModule } from "../core/extract.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import type { ModuleSummary } from "../core/types.js";
import { responseFormatSchema, targetSchema } from "./shared.js";

const inputSchema = z
  .object({
    file: targetSchema.describe(
      "Path to a single source file to summarize, relative to the project root (or absolute inside it). e.g. \"src/server.ts\"."
    ),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerSummarizeModule(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "summarize_module",
    {
      title: "Summarize Module",
      description: `Summarize a single TypeScript/JavaScript module's imports, exports, and dependencies — including static imports, re-exports, dynamic import() calls, and require() calls.

Use this to understand a file's external surface and what it depends on, without reading it.

Args:
  - file (string): Path to ONE source file, relative to project root. e.g. "src/server.ts".
  - response_format ('json' | 'markdown'): Output format (default: 'json').

Returns (JSON):
  {
    "file": string,
    "imports": [ { "source": string, "typeOnly": boolean,
                   "bindings": [ { "local": string, "imported": string } ], "span": {...} } ],
    "exports": [ { "name": string, "kind": "named"|"default", "source"?: string, "typeOnly": boolean, "span": {...} } ],
    "dependencies": string[],          // all distinct module specifiers
    "localDependencies": string[],     // relative/absolute path imports
    "externalDependencies": string[],  // bare package specifiers
    "counts": { "imports": n, "exports": n, "dependencies": n }
  }

Examples:
  - "What does src/server.ts import and export?" -> file="src/server.ts"
  - "Which external packages does this file pull in?" -> file="src/client.ts" (read externalDependencies)

Notes:
  - 'imported' is "default" for default imports and "*" for namespace imports.
  - Errors if 'file' resolves to a directory, multiple files, or no file. Pass exactly one file.`,
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
            "summarize_module expects a single file. Use a specific file path."
          );
        }
        if (batch.parsed.length === 0) {
          const e = batch.parseErrors[0]!;
          const where = e.position ? ` at ${e.position.line}:${e.position.column}` : "";
          return errorResult(`Could not parse "${e.file}"${where}: ${e.message}`);
        }

        const parsed = batch.parsed[0]!;
        const summary = summarizeModule(parsed.ast, ctx.display(parsed.file));
        const structured = {
          ...summary,
          counts: {
            imports: summary.imports.length,
            exports: summary.exports.length,
            dependencies: summary.dependencies.length
          }
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(summary)
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

function renderMarkdown(s: ModuleSummary): string {
  const lines: string[] = [`# Module: ${s.file}`, ""];

  lines.push(`## Imports (${s.imports.length})`);
  for (const imp of s.imports) {
    const binds = imp.bindings.map((b) => (b.local === b.imported ? b.local : `${b.imported} as ${b.local}`)).join(", ");
    const typ = imp.typeOnly ? " _(type)_" : "";
    lines.push(`- \`${imp.source}\`${typ}: ${binds || "(side-effect only)"}`);
  }
  lines.push("");

  lines.push(`## Exports (${s.exports.length})`);
  for (const exp of s.exports) {
    const src = exp.source ? ` from \`${exp.source}\`` : "";
    const typ = exp.typeOnly ? " _(type)_" : "";
    lines.push(`- ${exp.kind} **${exp.name}**${src}${typ}`);
  }
  lines.push("");

  lines.push(`## Dependencies (${s.dependencies.length})`);
  lines.push(`- External: ${s.externalDependencies.join(", ") || "none"}`);
  lines.push(`- Local: ${s.localDependencies.join(", ") || "none"}`);

  return lines.join("\n");
}
