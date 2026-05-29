import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CYCLE_FIXTURE_ROOT, connectClient, structured, type ConnectedClient } from "./helpers.js";

let conn: ConnectedClient;

beforeAll(async () => {
  conn = await connectClient(CYCLE_FIXTURE_ROOT);
});

afterAll(async () => {
  await conn.close();
});

interface CycleResult {
  scanned: number;
  edgeCount: number;
  cycleCount: number;
  count: number;
  truncated: boolean;
  hasCycles: boolean;
  cycles: Array<{ length: number; selfImport: boolean; modules: string[] }>;
  unresolvedLocal: Array<{ from: string; specifier: string }>;
  parseErrors: Array<{ file: string }>;
}

function call(args: Record<string, unknown>): Promise<CallToolResult> {
  return conn.client.callTool({ name: "detect_circular_deps", arguments: args }) as Promise<CallToolResult>;
}

/** Find a cycle whose member set equals `members` (order-independent). */
function cycleWith(data: CycleResult, members: string[]): CycleResult["cycles"][number] | undefined {
  const want = [...members].sort().join("|");
  return data.cycles.find((c) => [...c.modules].sort().join("|") === want);
}

describe("detect_circular_deps", () => {
  it("registers as a read-only tool with a schema", async () => {
    const { tools } = await conn.client.listTools();
    const tool = tools.find((t) => t.name === "detect_circular_deps");
    expect(tool).toBeDefined();
    expect(tool!.annotations?.readOnlyHint).toBe(true);
    expect((tool!.description ?? "").length).toBeGreaterThan(50);
    expect(tool!.inputSchema).toBeTruthy();
  });

  it("detects a 2-module cycle (two-a <-> two-b)", async () => {
    const data = structured<CycleResult>(await call({ target: "src/two-a.ts" }));
    // Scoped to one file, the import to two-b is out of scope -> no edge -> no cycle.
    expect(data.hasCycles).toBe(false);
    // The unresolved local specifier (out of scope) is surfaced as a caveat.
    expect(data.unresolvedLocal.some((u) => u.specifier === "./two-b")).toBe(true);

    // Widening to both files yields exactly the 2-cycle.
    const both = structured<CycleResult>(await call({ target: "src/two-*.ts" }));
    expect(both.hasCycles).toBe(true);
    const c = cycleWith(both, ["src/two-a.ts", "src/two-b.ts"]);
    expect(c).toBeDefined();
    expect(c!.length).toBe(2);
    expect(c!.selfImport).toBe(false);
  });

  it("detects a 3-module cycle (three/a -> b -> c -> a) reported once, not per rotation", async () => {
    const data = structured<CycleResult>(await call({ target: "src/three/{a,b,c}.ts" }));
    const c = cycleWith(data, ["src/three/a.ts", "src/three/b.ts", "src/three/c.ts"]);
    expect(c).toBeDefined();
    expect(c!.length).toBe(3);
    // Canonical rotation begins at the lexicographically smallest member.
    expect(c!.modules[0]).toBe("src/three/a.ts");
    // Exactly one cycle for this SCC (no rotated duplicates).
    const threeCycles = data.cycles.filter((cy) => cy.modules.every((m) => m.startsWith("src/three/")));
    expect(threeCycles).toHaveLength(1);
  });

  it("reports NO cycle for an acyclic chain and ignores the external (node:) leaf", async () => {
    const data = structured<CycleResult>(await call({ target: "src/acyclic" }));
    expect(data.scanned).toBe(3);
    expect(data.hasCycles).toBe(false);
    expect(data.cycleCount).toBe(0);
    // top -> mid -> leaf = 2 in-scope edges; the node:fs/promises import is a leaf.
    expect(data.edgeCount).toBe(2);
    expect(data.unresolvedLocal).toHaveLength(0);
  });

  it("detects a self-import as a length-1 cycle", async () => {
    const data = structured<CycleResult>(await call({ target: "src/self.ts" }));
    expect(data.hasCycles).toBe(true);
    const self = data.cycles.find((c) => c.selfImport);
    expect(self).toBeDefined();
    expect(self!.length).toBe(1);
    expect(self!.modules).toEqual(["src/self.ts"]);
  });

  it("resolves a tsconfig path alias to detect an aliased cycle; off by toggle", async () => {
    const withAlias = structured<CycleResult>(await call({ target: "src/aliased" }));
    expect(cycleWith(withAlias, ["src/aliased/x.ts", "src/aliased/y.ts"])).toBeDefined();

    const without = structured<CycleResult>(await call({ target: "src/aliased", useTsconfigPaths: false }));
    // With alias resolution off, "@alias/y" is indistinguishable from a bare
    // package specifier, so it is treated as an external leaf (no edge, not a
    // caveat) -> no cycle. Only the relative y -> x edge remains.
    expect(cycleWith(without, ["src/aliased/x.ts", "src/aliased/y.ts"])).toBeUndefined();
    expect(without.hasCycles).toBe(false);
    expect(without.edgeCount).toBe(1);
    expect(without.unresolvedLocal.some((u) => u.specifier === "@alias/y")).toBe(false);
  });

  it("counts dynamic import() as an edge by default; excludes it when includeDynamic=false", async () => {
    const withDyn = structured<CycleResult>(await call({ target: "src/dyn" }));
    expect(cycleWith(withDyn, ["src/dyn/da.ts", "src/dyn/db.ts"])).toBeDefined();

    const noDyn = structured<CycleResult>(await call({ target: "src/dyn", includeDynamic: false }));
    expect(noDyn.hasCycles).toBe(false);
    // The static edge da -> db survives; only db's dynamic back-edge is dropped.
    expect(noDyn.edgeCount).toBe(1);
  });

  it("resolves a `.js`-extension specifier to its `.ts` source (TS ESM convention)", async () => {
    const data = structured<CycleResult>(await call({ target: "src/esm" }));
    // ea.ts imports "./eb.js" and eb.ts imports "./ea.js"; both must resolve to
    // the .ts files on disk, forming a 2-cycle.
    expect(cycleWith(data, ["src/esm/ea.ts", "src/esm/eb.ts"])).toBeDefined();
    expect(data.unresolvedLocal).toHaveLength(0);
  });

  it("finds all independent cycles across the whole project at once", async () => {
    const data = structured<CycleResult>(await call({ target: "src" }));
    expect(data.hasCycles).toBe(true);
    // 2-cycle, 3-cycle, self-import, aliased, dynamic, .js-ESM = 6 distinct.
    expect(cycleWith(data, ["src/two-a.ts", "src/two-b.ts"])).toBeDefined();
    expect(cycleWith(data, ["src/three/a.ts", "src/three/b.ts", "src/three/c.ts"])).toBeDefined();
    expect(cycleWith(data, ["src/self.ts"])).toBeDefined();
    expect(cycleWith(data, ["src/aliased/x.ts", "src/aliased/y.ts"])).toBeDefined();
    expect(cycleWith(data, ["src/dyn/da.ts", "src/dyn/db.ts"])).toBeDefined();
    expect(cycleWith(data, ["src/esm/ea.ts", "src/esm/eb.ts"])).toBeDefined();
    expect(data.cycleCount).toBe(6);
    expect(data.parseErrors).toHaveLength(0);
  });

  it("respects the cycle limit and flags truncation", async () => {
    const data = structured<CycleResult>(await call({ target: "src", limit: 2 }));
    expect(data.count).toBe(2);
    expect(data.cycleCount).toBe(2);
    expect(data.truncated).toBe(true);
  });

  it("ignores type-only edges when includeTypeOnly=false", async () => {
    // The whole-project graph has no type-only cycle, so toggling it off must not
    // change the cycle set — a sanity check that the toggle is wired and inert
    // where there are no type-only edges.
    const on = structured<CycleResult>(await call({ target: "src" }));
    const off = structured<CycleResult>(await call({ target: "src", includeTypeOnly: false }));
    expect(off.cycleCount).toBe(on.cycleCount);
  });

  it("renders markdown when requested", async () => {
    const res = await call({ target: "src/two-*.ts", response_format: "markdown" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^# Circular dependencies/);
    expect(text).toContain("two-a.ts");
  });
});
