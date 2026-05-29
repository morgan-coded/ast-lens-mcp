/**
 * Tool: analyze_complexity
 *
 * Computes per-function cyclomatic complexity and LOC, flags functions over a
 * threshold, and summarizes the worst offenders.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import { analyzeAllFunctions } from "../core/traverse.js";
import type { ComplexityInfo } from "../core/types.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

const inputSchema = z
  .object({
    target: targetSchema,
    threshold: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Cyclomatic-complexity threshold; functions at or above this are flagged (default: 10)."),
    flaggedOnly: z
      .boolean()
      .default(false)
      .describe("When true, return only functions at or above the threshold."),
    sortBy: z
      .enum(["complexity", "loc", "location"])
      .default("complexity")
      .describe("Sort order: by complexity (desc), loc (desc), or source location (asc)."),
    ignore: ignoreSchema,
    limit: z.number().int().min(1).max(2000).default(500).describe("Maximum functions to return (default: 500)."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

interface FileComplexity {
  file: string;
  functions: ComplexityInfo[];
}

export function registerAnalyzeComplexity(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "analyze_complexity",
    {
      title: "Analyze Complexity",
      description: `Compute cyclomatic complexity and lines-of-code for every function/method in a file, directory, or glob, and flag functions that meet or exceed a threshold.

Cyclomatic complexity here is the classic McCabe count: 1 + the number of decision points (if, for/while/do, each non-default case, catch, ternary, &&/||/??, and optional-chaining ?. / ?.()). Nested functions are measured independently.

Use this to find refactoring targets and assess where test coverage matters most.

Args:
  - target (string): file, directory, or glob (relative to project root).
  - threshold (number): complexity at/above which a function is flagged, 1-100 (default 10).
  - flaggedOnly (boolean): only return flagged functions (default false).
  - sortBy ('complexity'|'loc'|'location'): ordering (default 'complexity', descending).
  - ignore (string[], optional): extra ignore globs.
  - limit (number): max functions returned, 1-2000 (default 500).
  - response_format ('json'|'markdown'): output format (default 'json').

Returns (JSON):
  {
    "threshold": number,
    "totalFunctions": number,
    "flaggedCount": number,
    "maxComplexity": number,
    "averageComplexity": number,
    "files": [
      { "file": string, "functions": [
        { "name": string, "kind": string, "complexity": number, "loc": number, "params": number,
          "overThreshold": boolean, "span": {...} }
      ] }
    ],
    "parseErrors": [...]
  }

Examples:
  - "Which functions are too complex?" -> target="src", threshold=10, flaggedOnly=true
  - "Rank functions in this file by complexity" -> target="src/router.ts", sortBy="complexity"

Notes:
  - Anonymous callbacks are reported as "<anonymous>" unless bound to a name.
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

        const files: FileComplexity[] = [];
        let totalFunctions = 0;
        let flaggedCount = 0;
        let maxComplexity = 0;
        let complexitySum = 0;

        for (const parsed of batch.parsed) {
          let functions = analyzeAllFunctions(parsed.ast, input.threshold);
          totalFunctions += functions.length;
          for (const fn of functions) {
            complexitySum += fn.complexity;
            if (fn.complexity > maxComplexity) maxComplexity = fn.complexity;
            if (fn.overThreshold) flaggedCount++;
          }
          if (input.flaggedOnly) functions = functions.filter((f) => f.overThreshold);
          sortFunctions(functions, input.sortBy);
          if (functions.length === 0) continue;
          files.push({ file: ctx.display(parsed.file), functions });
        }

        // Apply a global limit across files (keep highest-signal first when sorting by complexity).
        applyGlobalLimit(files, input.limit);

        const structured = {
          threshold: input.threshold,
          totalFunctions,
          flaggedCount,
          maxComplexity,
          averageComplexity: totalFunctions === 0 ? 0 : Number((complexitySum / totalFunctions).toFixed(2)),
          fileCount: files.length,
          files,
          parseErrors: batch.parseErrors,
          ...(batch.truncated ? { discoveryTruncated: true } : {})
        };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured),
          narrowHint: "Set flaggedOnly=true, raise 'threshold', lower 'limit', or narrow 'target'."
        });
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err), "Check that target is inside the project root.");
      }
    }
  );
}

function sortFunctions(functions: ComplexityInfo[], sortBy: Input["sortBy"]): void {
  if (sortBy === "complexity") {
    functions.sort((a, b) => b.complexity - a.complexity || b.loc - a.loc);
  } else if (sortBy === "loc") {
    functions.sort((a, b) => b.loc - a.loc || b.complexity - a.complexity);
  } else {
    functions.sort((a, b) => a.span.start.line - b.span.start.line);
  }
}

/** Trim the per-file results so the total number of functions does not exceed limit. */
function applyGlobalLimit(files: FileComplexity[], limit: number): void {
  let remaining = limit;
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (remaining <= 0) {
      files.length = i;
      break;
    }
    if (f.functions.length > remaining) {
      f.functions = f.functions.slice(0, remaining);
    }
    remaining -= f.functions.length;
  }
}

function renderMarkdown(data: {
  threshold: number;
  totalFunctions: number;
  flaggedCount: number;
  maxComplexity: number;
  averageComplexity: number;
  files: FileComplexity[];
}): string {
  const lines: string[] = [
    `# Complexity (threshold ${data.threshold})`,
    "",
    `- Functions: ${data.totalFunctions}`,
    `- Flagged (>= ${data.threshold}): ${data.flaggedCount}`,
    `- Max: ${data.maxComplexity}, Average: ${data.averageComplexity}`,
    ""
  ];
  for (const f of data.files) {
    lines.push(`## ${f.file}`);
    for (const fn of f.functions) {
      const flag = fn.overThreshold ? " ⚠️" : "";
      lines.push(`- **${fn.name}** (${fn.kind}) — complexity ${fn.complexity}, ${fn.loc} LOC, L${fn.span.start.line}${flag}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
