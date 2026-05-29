/**
 * Tool: list_symbols
 *
 * Lists every top-level / exported symbol across a file, directory, or glob.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { listSymbols } from "../core/extract.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import type { SymbolInfo } from "../core/types.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

const SYMBOL_KINDS = [
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "const",
  "let",
  "var"
] as const;

const inputSchema = z
  .object({
    target: targetSchema,
    kinds: z
      .array(z.enum(SYMBOL_KINDS))
      .optional()
      .describe('Filter to specific symbol kinds, e.g. ["function","class"]. Omit for all kinds.'),
    exportedOnly: z
      .boolean()
      .default(false)
      .describe("When true, return only symbols that are exported from their module."),
    ignore: ignoreSchema,
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface FileSymbols {
  file: string;
  symbols: SymbolInfo[];
}

export function registerListSymbols(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_symbols",
    {
      title: "List Symbols",
      description: `List all top-level and exported symbols (functions, classes, interfaces, type aliases, enums, and module-level variables) in a TypeScript/JavaScript file, directory, or glob.

Use this to get a fast structural inventory of code without reading whole files. Each symbol includes its kind, name, whether it is exported, and a 1-based line:column span.

Args:
  - target (string): File, directory, or glob to analyze (relative to project root). e.g. "src/index.ts", "src", "src/**/*.ts".
  - kinds (string[], optional): Restrict to certain kinds: function, class, interface, type, enum, const, let, var.
  - exportedOnly (boolean): Only return exported symbols (default: false).
  - ignore (string[], optional): Extra ignore globs.
  - response_format ('json' | 'markdown'): Output format (default: 'json').

Returns (JSON):
  {
    "root": string,                 // project root
    "totalSymbols": number,
    "fileCount": number,
    "files": [
      {
        "file": string,             // path relative to root
        "symbols": [
          {
            "name": string,
            "kind": "function"|"class"|"interface"|"type"|"enum"|"const"|"let"|"var"|...,
            "exported": boolean,
            "exportKind": "named"|"default"|"none",
            "async"?: boolean, "generator"?: boolean,
            "span": { "start": {"line":n,"column":n}, "end": {"line":n,"column":n} }
          }
        ]
      }
    ],
    "parseErrors": [ { "file": string, "message": string, "position"?: {...} } ]
  }

Examples:
  - "What functions are exported from the auth module?" -> target="src/auth", kinds=["function"], exportedOnly=true
  - "List every class in the project" -> target="src/**/*.ts", kinds=["class"]

Notes:
  - Files that fail to parse are reported under parseErrors; the tool never throws.
  - Class/interface members are NOT listed here — use get_file_outline for member-level detail.`,
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
        const kindSet = input.kinds ? new Set<string>(input.kinds) : undefined;

        const files: FileSymbols[] = [];
        let totalSymbols = 0;

        for (const parsed of batch.parsed) {
          let symbols = listSymbols(parsed.ast);
          if (kindSet) symbols = symbols.filter((s) => kindSet.has(s.kind));
          if (input.exportedOnly) symbols = symbols.filter((s) => s.exported);
          if (symbols.length === 0) continue;
          files.push({ file: ctx.display(parsed.file), symbols });
          totalSymbols += symbols.length;
        }

        const structured = {
          root: ctx.root,
          totalSymbols,
          fileCount: files.length,
          files,
          parseErrors: batch.parseErrors,
          ...(batch.truncated ? { discoveryTruncated: true } : {})
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured)
        });
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : String(err),
          "Check that target is inside the project root and is a valid path or glob."
        );
      }
    }
  );
}

function renderMarkdown(data: {
  totalSymbols: number;
  fileCount: number;
  files: FileSymbols[];
  parseErrors: { file: string; message: string }[];
}): string {
  const lines: string[] = [`# Symbols (${data.totalSymbols} across ${data.fileCount} files)`, ""];
  for (const f of data.files) {
    lines.push(`## ${f.file}`);
    for (const s of f.symbols) {
      const flags = [s.exported ? `export${s.exportKind === "default" ? " default" : ""}` : "", s.async ? "async" : ""]
        .filter(Boolean)
        .join(", ");
      const suffix = flags ? ` _(${flags})_` : "";
      lines.push(`- \`${s.kind}\` **${s.name}** — L${s.span.start.line}:${s.span.start.column}${suffix}`);
    }
    lines.push("");
  }
  if (data.parseErrors.length > 0) {
    lines.push("## Parse errors");
    for (const e of data.parseErrors) lines.push(`- ${e.file}: ${e.message}`);
  }
  return lines.join("\n");
}
