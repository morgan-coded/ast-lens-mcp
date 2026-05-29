/**
 * Server assembly: creates the McpServer, builds the shared ServerContext, and
 * registers every tool. Kept transport-agnostic so it can be unit-tested with
 * an in-memory transport (see test/server.test.ts).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { ServerContext } from "./core/context.js";
import { registerAnalyzeComplexity } from "./tools/analyzeComplexity.js";
import { registerFindReferences } from "./tools/findReferences.js";
import { registerGetFileOutline } from "./tools/getFileOutline.js";
import { registerListSymbols } from "./tools/listSymbols.js";
import { registerSearchAst } from "./tools/searchAst.js";
import { registerSummarizeModule } from "./tools/summarizeModule.js";

export const SERVER_NAME = "ast-lens-mcp-server";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  /** Absolute project root that all tools are confined to. */
  root: string;
}

/** Resolve the project root from CLI args / env / cwd, normalized to absolute. */
export function resolveProjectRoot(argv: string[] = process.argv.slice(2), env = process.env): string {
  // Support: `ast-lens-mcp /path/to/project` or `--root /path/to/project`.
  let candidate: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--root" || arg === "-r") {
      candidate = argv[i + 1];
      break;
    }
    if (arg.startsWith("--root=")) {
      candidate = arg.slice("--root=".length);
      break;
    }
    if (!arg.startsWith("-") && candidate === undefined) {
      candidate = arg;
    }
  }
  candidate = candidate ?? env.AST_LENS_PROJECT_ROOT ?? process.cwd();
  return path.resolve(candidate);
}

/** Create and fully configure the MCP server (all tools registered). */
export function createServer(opts: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "ast-lens-mcp provides structural code intelligence for a TypeScript/JavaScript project via AST analysis. " +
        "Prefer these tools over reading whole files when you need to understand structure: list_symbols and " +
        "get_file_outline for shape, find_references for usages, search_ast for structural patterns and code smells, " +
        "analyze_complexity for refactor targets, and summarize_module for a file's imports/exports/dependencies. " +
        "All paths are relative to the configured project root; node_modules and build output are ignored automatically."
    }
  );

  const ctx = new ServerContext(opts.root);

  registerListSymbols(server, ctx);
  registerGetFileOutline(server, ctx);
  registerFindReferences(server, ctx);
  registerSearchAst(server, ctx);
  registerAnalyzeComplexity(server, ctx);
  registerSummarizeModule(server, ctx);

  return server;
}
