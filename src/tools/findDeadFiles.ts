/**
 * Tool: find_dead_files
 *
 * Lists source files that are neither imported by any other in-scope file nor
 * reachable (transitively) from a project entry point — candidate DEAD FILES
 * (orphan modules). Built on a self-contained import-graph + reachability pass
 * (see deadFilesGraph.ts) and the same package.json entry-point resolution that
 * find_unused_exports (v0.3) uses as reachability roots.
 *
 * This is a structural, dependency-light heuristic, not a bundler. Module
 * specifiers are resolved purely against the files already in scope, with
 * relative-path, `/index.*`, extension, and tsconfig `paths`/`baseUrl` alias
 * resolution. A file is reported when nothing in scope reaches it from an entry;
 * see the CAVEATS in the tool description for the false-positive sources
 * (dynamic/computed imports, glob imports, config/test entry files, assets).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerContext } from "../core/context.js";
import { resolvePackageEntryPoints } from "../core/entryPoints.js";
import { errorResult, ResponseFormat, toolResult } from "../core/response.js";
import { buildImportGraph, loadTsAliasConfig, reachableFrom } from "./deadFilesGraph.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

/** Default globs treated as entry points (reachability roots) whose files —
 * and everything they import — are never reported dead. `index.*` is the
 * conventional package/barrel entry; declaration barrels are included for
 * `.d.ts`-only packages, matching find_unused_exports' default. */
const DEFAULT_ENTRY_POINTS = [
  "**/index.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
  "**/index.d.{ts,mts,cts}"
];

/** Why a file is considered a candidate dead file. */
type DeadReason = "no-importers" | "unreachable-cluster";

interface DeadFile {
  /** Display path of the dead file (root-relative). */
  file: string;
  /** Machine-readable reason code. */
  reason: DeadReason;
  /** Human-readable explanation. */
  detail: string;
  /** In-scope files that import this one (always other dead files when present). */
  importedBy: string[];
  /** True when at least one importer reaches it only via a dynamic import()/require. */
  dynamicOnlyImporters: boolean;
}

const inputSchema = z
  .object({
    target: targetSchema
      .default("**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}")
      .describe(
        "Scope to analyze, relative to project root. Defaults to the whole project. " +
          "Import edges are only seen WITHIN this scope, so prefer the whole project (or a self-contained package); " +
          "a file imported only from OUTSIDE the scanned scope will look dead."
      ),
    entryPoints: z
      .array(z.string())
      .optional()
      .describe(
        'Globs whose files are reachability roots: those files, and everything they (transitively) import, are never reported dead. Defaults to ["**/index.*"]. Pass [] to rely only on package.json entries (or report every non-imported file when usePackageEntryPoints=false).'
      ),
    usePackageEntryPoints: z
      .boolean()
      .default(true)
      .describe(
        "Also seed reachability roots from the project's package.json (main/module/bin/exports/types). Declared entries that point at build output (e.g. dist/index.js) are mapped back to likely source files (src/index.ts, .d.ts, ...). Set false to rely only on the 'entryPoints' globs. Default: true."
      ),
    ignore: ignoreSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(2000)
      .default(500)
      .describe("Maximum dead files to return (default: 500)."),
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export function registerFindDeadFiles(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "find_dead_files",
    {
      title: "Find Dead Files",
      description: `List source files that are NOT imported by any other file in scope AND NOT reachable from a project entry point — candidate dead/orphan modules.

This is a structural reachability check (not a bundler, not type-aware). It builds an import graph over the scanned files — edges from static \`import\`/\`export ... from\`, \`require(...)\`, and string-literal dynamic \`import("...")\` — resolving each specifier against the in-scope files (relative paths, \`/index.*\`, file extensions, and tsconfig \`compilerOptions.paths\`/\`baseUrl\` aliases). It then marks every file reachable from an entry point and reports the rest.

Entry points (reachability roots) come from BOTH the 'entryPoints' globs (default "**/index.*") AND the project's package.json (main/module/bin/exports/types), since the real public surface is what the manifest exposes. Declared entries pointing at build output (e.g. "dist/index.js") are mapped back to likely source files ("src/index.ts", ".d.ts", same-name variants). Disable the manifest source with usePackageEntryPoints=false; override the globs with 'entryPoints'.

Each reported file carries a reason:
  - "no-importers": no in-scope file imports it and it is not an entry point.
  - "unreachable-cluster": other files import it, but the whole group is unreachable from any entry point (e.g. a clump of mutually-importing orphan modules).

IMPORTANT — this is a HEURISTIC; expect FALSE POSITIVES. A flagged file is a *candidate*, not proof. Common reasons a live file is wrongly flagged:
  - Dynamic/computed imports: \`import(\`./routes/\${name}\`)\`, \`require(variable)\`, glob/\`import.meta.glob\` style loading, or a registry that imports by string — the target cannot be resolved statically, so it appears unimported.
  - Entry-like files that nothing imports but a runtime/tool loads directly: CLI scripts, test files, config (vite/jest/eslint/tailwind configs), migrations, serverless/route handlers, Next.js/SvelteKit pages, Storybook stories. Add these via 'entryPoints' (or scope around them) so they and their imports are kept.
  - Out-of-scope importers: code in tests/another package that is not inside 'target' — widen 'target'.
  - Side-effect-only modules imported via a path this resolver can't map (e.g. a bare alias not in tsconfig, a webpack alias, or a non-literal specifier).
  - Assets / non-JS entries (\`.css\`, \`.svg\`, \`.json\`, \`.wasm\`) are not analyzed by this server, so a file imported ONLY by such a non-source file looks dead.
False NEGATIVES also occur: a file kept alive solely by a dynamic import with a non-literal specifier elsewhere may be missed in the other direction. Treat output as a starting list to verify, not a delete list.

Args:
  - target (string): scope to analyze (default: whole project).
  - entryPoints (string[], optional): globs whose files (and their imports) are never flagged (default ["**/index.*"]). Pass [] to disable the glob roots.
  - usePackageEntryPoints (boolean): also use package.json entries as roots (default true).
  - ignore (string[], optional): extra ignore globs.
  - limit (number): max results, 1-2000 (default 500).
  - response_format ('json' | 'markdown'): output format (default 'json').

Returns (JSON):
  {
    "scanned": number,            // files analyzed
    "entryFileCount": number,     // files matched as entry points (roots)
    "reachableCount": number,     // files reachable from an entry (incl. roots)
    "total": number,              // dead-file candidates found (before limit)
    "count": number,              // returned
    "truncated": boolean,
    "deadFiles": [
      { "file": string, "reason": "no-importers"|"unreachable-cluster", "detail": string,
        "importedBy": string[], "dynamicOnlyImporters": boolean }
    ],
    "entryPoints": string[],          // globs treated as roots
    "packageEntryPoints": string[],   // entries discovered in package.json (root-relative)
    "parseErrors": [...]
  }

Examples:
  - "Which files are dead in this project?" -> (no args; whole project, package.json + index.* as roots)
  - "Find orphan modules under src, treating the CLI as an entry" -> target="src", entryPoints=["src/index.ts","src/cli.ts"]`,
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
        const entryGlobs = input.entryPoints ?? DEFAULT_ENTRY_POINTS;

        // Reachability roots from package.json (main/module/bin/exports/types),
        // mapped from declared build output back to likely source files. Reuses
        // the exact v0.3 entry-point logic so dead-file roots and unused-export
        // roots agree on what the manifest exposes.
        let pkgEntryCandidates: string[] = [];
        let pkgDeclared: string[] = [];
        if (input.usePackageEntryPoints) {
          const resolution = await resolvePackageEntryPoints(ctx.root);
          pkgEntryCandidates = resolution.sourceCandidates;
          pkgDeclared = resolution.declared;
        }

        // Build the in-scope file list (display paths) + asts.
        const graphFiles = batch.parsed.map((p) => ({ display: ctx.display(p.file), ast: p.ast }));

        // Resolve tsconfig path aliases once for the whole graph.
        const aliasConfig = await loadTsAliasConfig(ctx.root);
        const graph = buildImportGraph(graphFiles, aliasConfig);

        // Entry FILES: in-scope files matched by an entry glob OR a package.json
        // source candidate. These are the reachability roots.
        const entryMatchers = [
          ...entryGlobs.map(globToRegExp),
          ...pkgEntryCandidates.map(globToRegExp)
        ];
        const entryFiles = new Set<string>();
        for (const display of graph.files) {
          if (entryMatchers.some((re) => re.test(display))) entryFiles.add(display);
        }

        const reachable = reachableFrom(graph, entryFiles);

        // A candidate dead file is any in-scope file NOT reachable from a root.
        // (Entry files are always reachable — they seed the traversal — so they
        // are never reported.) Classify by whether anything imports it at all.
        const deadFiles: DeadFile[] = [];
        for (const display of graph.files) {
          if (reachable.has(display)) continue;
          const importers = [...(graph.importedBy.get(display) ?? [])].sort();
          const dynamicOnly =
            importers.length > 0 &&
            !graph.staticallyImported.has(display) &&
            graph.dynamicallyImported.has(display);
          let reason: DeadReason;
          let detail: string;
          if (importers.length === 0) {
            reason = "no-importers";
            detail =
              "No in-scope file imports this file, and it is not an entry point or reachable from one.";
          } else {
            reason = "unreachable-cluster";
            detail = `Imported only by other unreachable files (${importers.join(", ")}); the group is not reachable from any entry point.`;
          }
          deadFiles.push({
            file: display,
            reason,
            detail,
            importedBy: importers,
            dynamicOnlyImporters: dynamicOnly
          });
        }

        deadFiles.sort((a, b) => a.file.localeCompare(b.file));
        const total = deadFiles.length;
        const returned = deadFiles.slice(0, input.limit);

        const structured = {
          scanned: batch.parsed.length,
          entryFileCount: entryFiles.size,
          reachableCount: reachable.size,
          total,
          count: returned.length,
          truncated: total > returned.length,
          deadFiles: returned,
          entryPoints: entryGlobs,
          // package.json entries (main/module/bin/exports/types), root-relative;
          // empty when none/disabled. Their source files seed reachability.
          packageEntryPoints: pkgDeclared,
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

/** Translate a simple glob (supporting ** , * , ? and brace alternation) into an
 * anchored RegExp matched against display paths (forward slashes). Mirrors the
 * resolver in find_unused_exports; kept local so this tool does not modify any
 * existing file (the helper there is not exported). */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        re += "(?:.*?)";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
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
  entryFileCount: number;
  reachableCount: number;
  total: number;
  count: number;
  deadFiles: DeadFile[];
}): string {
  const lines: string[] = [
    `# Dead files (${data.total} candidate${data.total === 1 ? "" : "s"}, showing ${data.count})`,
    "",
    `Scanned ${data.scanned} files — ${data.reachableCount} reachable from ${data.entryFileCount} entry point(s).`,
    ""
  ];
  if (data.deadFiles.length === 0) {
    lines.push("_No candidate dead files found._");
    return lines.join("\n");
  }
  for (const d of data.deadFiles) {
    const tag = d.reason === "no-importers" ? "no importers" : "unreachable cluster";
    lines.push(`- **${d.file}** _(${tag})_ — ${d.detail}`);
  }
  lines.push("", "_Heuristic: verify before deleting (dynamic imports, config/test/entry files, and asset-only imports can cause false positives)._");
  return lines.join("\n");
}
