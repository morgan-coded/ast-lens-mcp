#!/usr/bin/env node
/**
 * End-to-end stdio smoke test.
 *
 * Boots the built server (dist/index.js) as a real subprocess over stdio,
 * connects with the MCP SDK client, lists tools, and calls a couple of them
 * against this project's own src/ tree. Exits non-zero on any failure so it can
 * gate CI / pre-publish.
 *
 * Run: npm run build && npm run smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const entry = path.join(root, "dist", "index.js");

function assert(cond, message) {
  if (!cond) {
    console.error(`  ✗ ${message}`);
    process.exitCode = 1;
    throw new Error(message);
  }
  console.error(`  ✓ ${message}`);
}

async function main() {
  if (!existsSync(entry)) {
    console.error(`Build output not found at ${entry}. Run "npm run build" first.`);
    process.exit(1);
  }

  console.error("Booting ast-lens-mcp over stdio…");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, root] // analyze this very project
  });
  const client = new Client({ name: "smoke-client", version: "0.0.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.error(`Server reported ${tools.length} tools: ${names.join(", ")}`);
    assert(tools.length === 6, "exposes 6 tools");
    for (const expected of [
      "list_symbols",
      "get_file_outline",
      "find_references",
      "search_ast",
      "analyze_complexity",
      "summarize_module"
    ]) {
      assert(names.includes(expected), `tool present: ${expected}`);
    }

    // Call list_symbols against the server's own source.
    const ls = await client.callTool({ name: "list_symbols", arguments: { target: "src", kinds: ["function"] } });
    const lsData = ls.structuredContent;
    assert(lsData && lsData.totalSymbols > 0, `list_symbols found ${lsData?.totalSymbols ?? 0} functions in src`);

    // Run an AST query for console usage (there should be none in src — clean code).
    const consoleHits = await client.callTool({ name: "search_ast", arguments: { query: "any_usage", target: "src" } });
    assert(consoleHits.structuredContent !== undefined, "search_ast(any_usage) returned structured content");

    // Summarize the server module itself.
    const sum = await client.callTool({ name: "summarize_module", arguments: { file: "src/server.ts" } });
    assert(
      sum.structuredContent && Array.isArray(sum.structuredContent.imports) && sum.structuredContent.imports.length > 0,
      `summarize_module(src/server.ts) found ${sum.structuredContent?.imports?.length ?? 0} imports`
    );

    // Complexity over the whole src tree.
    const cx = await client.callTool({ name: "analyze_complexity", arguments: { target: "src" } });
    assert(
      cx.structuredContent && cx.structuredContent.totalFunctions > 0,
      `analyze_complexity scanned ${cx.structuredContent?.totalFunctions ?? 0} functions (max complexity ${cx.structuredContent?.maxComplexity})`
    );

    console.error("\nSmoke test PASSED — server boots, lists tools, and answers tool calls over stdio.");
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(`\nSmoke test FAILED: ${err?.message ?? err}`);
  process.exit(1);
});
