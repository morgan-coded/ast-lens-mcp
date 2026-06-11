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
    assert(tools.length === 13, "exposes 13 tools");
    for (const expected of [
      "list_symbols",
      "get_file_outline",
      "find_references",
      "search_ast",
      "analyze_complexity",
      "summarize_module",
      "find_unused_exports",
      "call_graph",
      "import_graph",
      "detect_circular_deps",
      "find_dead_files",
      "api_surface",
      "compare_implementations"
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

    // Build a call graph of the core directory.
    const cg = await client.callTool({ name: "call_graph", arguments: { target: "src/core" } });
    assert(
      cg.structuredContent && cg.structuredContent.nodeCount > 0,
      `call_graph(src/core) found ${cg.structuredContent?.nodeCount ?? 0} functions, ${cg.structuredContent?.edgeCount ?? 0} edges`
    );

    // Scan the project's own source for unused exports (name-based; informational).
    const ue = await client.callTool({ name: "find_unused_exports", arguments: { target: "src" } });
    assert(
      ue.structuredContent && Array.isArray(ue.structuredContent.unused),
      `find_unused_exports(src) scanned ${ue.structuredContent?.scanned ?? 0} files, ${ue.structuredContent?.total ?? 0} candidates`
    );

    // Build an import/export resolution graph of the project's own source.
    const ig = await client.callTool({ name: "import_graph", arguments: { target: "src" } });
    assert(
      ig.structuredContent && ig.structuredContent.nodeCount > 0,
      `import_graph(src) found ${ig.structuredContent?.nodeCount ?? 0} modules, ${ig.structuredContent?.edgeCount ?? 0} edges (${ig.structuredContent?.internalEdges ?? 0} internal)`
    );

    // Detect circular import dependencies in the project's own source.
    const cd = await client.callTool({ name: "detect_circular_deps", arguments: { target: "src" } });
    assert(
      cd.structuredContent && Array.isArray(cd.structuredContent.cycles),
      `detect_circular_deps(src) scanned ${cd.structuredContent?.scanned ?? 0} modules, ${cd.structuredContent?.cycleCount ?? 0} cycles`
    );

    // Find orphan modules (files no entry point reaches) in the project's own source.
    const df = await client.callTool({ name: "find_dead_files", arguments: { target: "src" } });
    assert(
      df.structuredContent && Array.isArray(df.structuredContent.deadFiles),
      `find_dead_files(src) scanned ${df.structuredContent?.scanned ?? 0} files, ${df.structuredContent?.count ?? 0} dead`
    );

    // Extract the package's public API surface from its declared entry points.
    // Target the package root (".") so package.json's main (dist/index.js) is
    // mapped back to its source entry (src/index.ts). This project's entry is a
    // bin script that re-exports nothing, so assert the call resolves an entry
    // and returns a coherent surface — not a positive symbol count.
    const as = await client.callTool({ name: "api_surface", arguments: { target: "." } });
    assert(
      as.structuredContent && Array.isArray(as.structuredContent.entries) && as.structuredContent.entries.length > 0,
      `api_surface(.) resolved ${as.structuredContent?.entries?.length ?? 0} entry point(s) -> ${as.structuredContent?.totalSymbols ?? 0} public symbols (entry: ${as.structuredContent?.entries?.[0]?.entry ?? "none"})`
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
