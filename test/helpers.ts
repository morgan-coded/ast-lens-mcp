import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ServerContext } from "../src/core/context.js";
import { createServer } from "../src/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the sample fixture project root. */
export const FIXTURE_ROOT = path.join(here, "fixtures", "sample-project");

/**
 * Absolute path to the package-aware fixture root: a small project with a
 * package.json declaring a non-index entry (dist/main.js), a tsconfig path
 * alias, circular deps, dynamic imports, type-only exports, and a nested
 * sub-package. Used to exercise entry-point resolution + edge cases.
 */
export const PKG_FIXTURE_ROOT = path.join(here, "fixtures", "pkg-project");

/**
 * Absolute path to the circular-dependency fixture root: a project containing a
 * 2-module cycle, a 3-module cycle, an acyclic chain, a self-import, a
 * tsconfig-path-aliased cycle, and a dynamic-import-only cycle. Used to exercise
 * detect_circular_deps.
 */
export const CYCLE_FIXTURE_ROOT = path.join(here, "fixtures", "cycle-project");

/** A ServerContext scoped to the fixture project (for unit-testing core/tools directly). */
export function fixtureContext(): ServerContext {
  return new ServerContext(FIXTURE_ROOT);
}

/** Resolve a path inside the fixture project. */
export function fixturePath(...parts: string[]): string {
  return path.join(FIXTURE_ROOT, ...parts);
}

/** Resolve a path inside the package-aware fixture project. */
export function pkgFixturePath(...parts: string[]): string {
  return path.join(PKG_FIXTURE_ROOT, ...parts);
}

export interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

/** Spin up the real MCP server connected to an in-memory transport and return a client. */
export async function connectClient(root: string = FIXTURE_ROOT): Promise<ConnectedClient> {
  const server = createServer({ root });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    }
  };
}

/** Parse the structuredContent (or JSON text fallback) from a tool result. */
export function structured<T = Record<string, unknown>>(result: CallToolResult): T {
  if (result.structuredContent) return result.structuredContent as T;
  const first = result.content?.[0];
  if (first && first.type === "text") return JSON.parse(first.text) as T;
  throw new Error("No structured content in tool result");
}
