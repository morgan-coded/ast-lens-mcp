#!/usr/bin/env node
/**
 * ast-lens-mcp entry point.
 *
 * Starts the MCP server over stdio. The project root that tools analyze is
 * taken from (in priority order): a positional CLI arg or --root flag, the
 * AST_LENS_PROJECT_ROOT env var, or the current working directory.
 *
 * IMPORTANT: stdio transport uses stdout for protocol traffic, so all logging
 * goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, resolveProjectRoot, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stderr.write(
      `${SERVER_NAME} v${SERVER_VERSION}\n\n` +
        "An MCP server that gives AI agents structural understanding of a\n" +
        "TypeScript/JavaScript codebase via AST analysis.\n\n" +
        "Usage:\n" +
        "  ast-lens-mcp [projectRoot]\n" +
        "  ast-lens-mcp --root <projectRoot>\n\n" +
        "Environment:\n" +
        "  AST_LENS_PROJECT_ROOT   Project root to analyze (default: cwd)\n\n" +
        "Transport: stdio (for use by an MCP client such as Claude Desktop).\n" +
        "Tools: list_symbols, get_file_outline, find_references, search_ast,\n" +
        "       analyze_complexity, summarize_module, find_unused_exports,\n" +
        "       call_graph\n"
    );
    return;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    process.stderr.write(`${SERVER_VERSION}\n`);
    return;
  }

  const root = resolveProjectRoot(argv);
  const server = createServer({ root });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`${SERVER_NAME} v${SERVER_VERSION} running on stdio (project root: ${root})\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
