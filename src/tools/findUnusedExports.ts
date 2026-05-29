/**
 * Tool: find_unused_exports
 *
 * Lists exported symbols that are never referenced from another file in the
 * scanned scope — likely dead public surface (knip-style, but name-based and
 * dependency-free). Built on summarize_module's export extraction and a
 * find_references-style usage scan.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { countNameUsages, exportedSymbols, reexportedOriginNames } from "../core/extract.js";
import { ResponseFormat, errorResult, toolResult } from "../core/response.js";
import type { UnusedExportInfo } from "../core/types.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

/** Default globs whose exports are treated as intentional public API (not flagged). */
const DEFAULT_ENTRY_POINTS = ["**/index.{ts,tsx,js,jsx,mts,cts,mjs,cjs}"];

const inputSchema = z
  .object({
    target: targetSchema
      .default("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}")
      .describe(
        "Scope to analyze AND search for usages within, relative to project root. Defaults to the whole project. " +
          "Usage detection only sees files inside this scope, so prefer the whole project (or a self-contained package) for accuracy."
      ),
    entryPoints: z
      .array(z.string())
      .optional()
      .describe(
        'Globs whose exports are considered intentional public API and never flagged. Defaults to ["**/index.*"]. Pass [] to flag everything.'
      ),
    includeReexports: z
      .boolean()
      .default(false)
      .describe(
        "Include bare `export * from \"...\"` re-exports in the report (they cannot be name-checked, so they are reported as caveats, not confirmed-unused). Default: false."
      ),
    ignore: ignoreSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(500)
      .describe("Maximum unused exports to return (default: 500)."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerFindUnusedExports(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "find_unused_exports",
    {
      title: "Find Unused Exports",
      description: `List exported symbols that are never referenced from any OTHER file in the scanned scope — candidate dead code / unnecessary public surface.

This is a fast, dependency-free, NAME-BASED reachability check (the same engine as find_references), not a type-aware resolver. An export is reported as unused when its name has no value/type/JSX reference or call from a different file in scope. Same-file-only use still counts as unused (the symbol did not need to be exported).

IMPORTANT assumptions & limits (name-based):
  - Usage is only detected WITHIN 'target'. Symbols consumed by code outside the scanned scope (tests, apps, other packages) will show as unused — scope to a self-contained project/package.
  - Two different symbols that share a name are conflated: any same-named reference anywhere counts as a use, so this errs toward FALSE NEGATIVES (under-reporting). Treat hits as high-confidence, misses as best-effort.
  - Exports from entry-point files (default "**/index.*") are treated as intentional public API and not flagged. Override with 'entryPoints'.
  - Re-exports that forward another module (\`export { x } from "./y"\`) are skipped (not declared here). Bare \`export * from "..."\` cannot be name-checked; include it with includeReexports=true to see it flagged as a caveat.
  - Dynamic access (string-keyed property lookup, \`require\` interop, reflection) is invisible to a syntactic check.

Args:
  - target (string): scope to analyze and search within (default: whole project).
  - entryPoints (string[], optional): globs whose exports are never flagged (default ["**/index.*"]). Pass [] to flag everything.
  - includeReexports (boolean): also report bare \`export *\` re-exports as caveats (default false).
  - ignore (string[], optional): extra ignore globs.
  - limit (number): max results, 1-2000 (default 500).
  - response_format ('json' | 'markdown'): output format (default 'json').

Returns (JSON):
  {
    "scanned": number,            // files analyzed
    "totalExports": number,       // exported symbols considered (excludes entry points & forwarded re-exports)
    "total": number,              // unused exports found (before limit)
    "count": number,              // returned
    "truncated": boolean,
    "unused": [
      { "file": string, "name": string, "exportKind": "named"|"default", "reexport": boolean, "span": {...} }
    ],
    "entryPoints": string[],      // globs treated as public API
    "parseErrors": [...]
  }

Examples:
  - "What exports are dead in src?" -> target="src" (note: misses usage from tests/app outside src)
  - "Audit the whole project for unused exports" -> target="src/**/*.ts", entryPoints=["src/index.ts"]`,
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
        const entryPoints = input.entryPoints ?? DEFAULT_ENTRY_POINTS;
        const entryMatchers = entryPoints.map(globToRegExp);

        // Phase 1: collect every candidate export (skipping entry points) keyed
        // by file, and the union of all exported names to scan usages for.
        interface Candidate {
          file: string;
          name: string;
          exportKind: UnusedExportInfo["exportKind"];
          reexport: boolean;
          span: UnusedExportInfo["span"];
        }
        const candidates: Candidate[] = [];
        const namesToScan = new Set<string>();
        // Names a public entry point re-exports from another module. These are
        // reachability roots: a symbol forwarded by an entry point is public API
        // and must not be flagged, even with no other reference.
        const entryReexportedNames = new Set<string>();
        let totalExports = 0;

        for (const parsed of batch.parsed) {
          const display = ctx.display(parsed.file);
          if (entryMatchers.some((re) => re.test(display))) {
            for (const name of reexportedOriginNames(parsed.ast)) entryReexportedNames.add(name);
            continue;
          }
          for (const exp of exportedSymbols(parsed.ast)) {
            if (exp.reexport) {
              if (input.includeReexports) {
                candidates.push({
                  file: display,
                  name: exp.name,
                  exportKind: exp.kind === "default" ? "default" : "named",
                  reexport: true,
                  span: exp.span
                });
              }
              continue;
            }
            totalExports++;
            candidates.push({
              file: display,
              name: exp.name,
              exportKind: exp.kind === "default" ? "default" : "named",
              reexport: false,
              span: exp.span
            });
            namesToScan.add(exp.name);
          }
        }

        // Phase 2: count usages of each candidate name PER FILE, so we can ask
        // "is it used anywhere other than its own declaring file?".
        const usagesByFile = new Map<string, Map<string, number>>();
        for (const parsed of batch.parsed) {
          const tally = new Map<string, number>();
          countNameUsages(parsed.ast, namesToScan, tally);
          usagesByFile.set(ctx.display(parsed.file), tally);
        }

        // Phase 3: a named export is unused when no OTHER file references its
        // name. Re-export caveats are always reported (cannot be name-checked).
        const unused: UnusedExportInfo[] = [];
        for (const c of candidates) {
          if (c.reexport) {
            unused.push({ file: c.file, name: c.name, exportKind: c.exportKind, reexport: true, span: c.span });
            continue;
          }
          // Forwarded by a public entry point => reachable public API, not dead.
          if (entryReexportedNames.has(c.name)) continue;
          let usedElsewhere = false;
          for (const [file, tally] of usagesByFile) {
            if (file === c.file) continue;
            if ((tally.get(c.name) ?? 0) > 0) {
              usedElsewhere = true;
              break;
            }
          }
          if (!usedElsewhere) {
            unused.push({ file: c.file, name: c.name, exportKind: c.exportKind, reexport: false, span: c.span });
          }
        }

        unused.sort((a, b) => a.file.localeCompare(b.file) || a.span.start.line - b.span.start.line);
        const total = unused.length;
        const returned = unused.slice(0, input.limit);

        const structured = {
          scanned: batch.parsed.length,
          totalExports,
          total,
          count: returned.length,
          truncated: total > returned.length,
          unused: returned,
          entryPoints,
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

/** Translate a simple glob (supporting ** , * and brace alternation) into an
 * anchored RegExp matched against display paths (forward slashes). */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators (and an optional trailing slash).
        re += "(?:.*?)";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*"; // * stays within a path segment
      }
    } else if (ch === "{") {
      const end = glob.indexOf("}", i);
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(",").map(escapeRegExp).join("|");
        re += `(?:${alts})`;
        i = end;
      } else {
        re += escapeRegExp(ch);
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(ch);
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function renderMarkdown(data: {
  scanned: number;
  totalExports: number;
  total: number;
  count: number;
  unused: UnusedExportInfo[];
}): string {
  const lines: string[] = [
    `# Unused exports (${data.total} of ${data.totalExports} exports, showing ${data.count})`,
    "",
    `Scanned ${data.scanned} files.`,
    ""
  ];
  let currentFile = "";
  for (const u of data.unused) {
    if (u.file !== currentFile) {
      currentFile = u.file;
      lines.push(`## ${u.file}`);
    }
    const tag = u.reexport ? " _(re-export — cannot be name-checked)_" : ` _(${u.exportKind})_`;
    lines.push(`- **${u.name}**${tag} — L${u.span.start.line}:${u.span.start.column}`);
  }
  return lines.join("\n");
}
