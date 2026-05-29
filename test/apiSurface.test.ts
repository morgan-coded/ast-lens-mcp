import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectClient, structured, type ConnectedClient } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A dedicated package fixture for api_surface: package.json points at build
 * output (dist/index.js) that maps back to src/index.ts, a barrel that
 * re-exports a mix of function/class/interface/type/const/enum symbols from
 * sub-modules (named, renamed, `export *`, `export * as ns`, `export type`),
 * declares one symbol + a default export itself, and forwards one name from a
 * bare (out-of-scope) package. Sub-modules also export INTERNAL symbols the
 * barrel never forwards, and contain non-exported helpers — both must be
 * excluded from the public surface.
 */
const API_PKG_ROOT = path.join(here, "fixtures", "api-surface-pkg");

interface Member {
  name: string;
  kind: string;
  signature: string;
  static?: boolean;
  optional?: boolean;
}
interface PublicSymbol {
  name: string;
  kind: string;
  exportKind: string;
  signature: string;
  declaredIn?: string;
  typeOnly?: boolean;
  members?: Member[];
}
interface Surface {
  target: string;
  packageEntryPoints: string[];
  entries: { entry: string; symbols: PublicSymbol[]; unresolved: { from: string; source: string; kind: string; names?: string[] }[] }[];
  totalSymbols: number;
  count: number;
  truncated: boolean;
  parseErrors: { file: string }[];
}

let conn: ConnectedClient;

beforeAll(async () => {
  conn = await connectClient(API_PKG_ROOT);
});
afterAll(async () => {
  await conn.close();
});

function call(args: Record<string, unknown>): Promise<CallToolResult> {
  return conn.client.callTool({ name: "api_surface", arguments: args }) as Promise<CallToolResult>;
}

/** Convenience: the flat symbol list of the first entry. */
function firstEntrySymbols(data: Surface): PublicSymbol[] {
  return data.entries[0]?.symbols ?? [];
}
function findSym(data: Surface, name: string): PublicSymbol | undefined {
  return firstEntrySymbols(data).find((s) => s.name === name);
}

describe("api_surface — package entry resolution", () => {
  it("resolves the package.json entry (dist/index.js -> src/index.ts) and enumerates the public surface", async () => {
    const data = structured<Surface>(await call({ target: "." }));

    // Declared build-output entries surfaced for transparency.
    expect(data.packageEntryPoints).toEqual(
      expect.arrayContaining(["dist/index.js", "dist/index.mjs", "dist/index.d.ts"])
    );
    // The real entry source file is recognized.
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]!.entry).toBe("src/index.ts");

    const names = firstEntrySymbols(data).map((s) => s.name).sort();
    // Exactly the symbols reachable from the barrel.
    expect(names).toEqual(
      ["ApiClient", "ClientOptions", "PI", "Shape", "Status", "VERSION", "add", "default", "makeShape", "times", "utils"].sort()
    );
  });

  it("excludes internal symbols a sub-module exports but the entry never re-exports", async () => {
    const data = structured<Surface>(await call({ target: "." }));
    const names = firstEntrySymbols(data).map((s) => s.name);
    // subtract is `export`ed in math.ts but NOT re-exported by the barrel.
    expect(names).not.toContain("subtract");
  });

  it("excludes non-exported module-internal helpers entirely", async () => {
    const data = structured<Surface>(await call({ target: "." }));
    const names = firstEntrySymbols(data).map((s) => s.name);
    expect(names).not.toContain("roundTo"); // private helper in math.ts
    expect(names).not.toContain("normalizeSize"); // private helper in shapes.ts
  });
});

describe("api_surface — symbol kinds + signatures", () => {
  let data: Surface;
  beforeAll(async () => {
    data = structured<Surface>(await call({ target: "." }));
  });

  it("extracts a function signature with params and return type, attributed to its declaring file", () => {
    const add = findSym(data, "add");
    expect(add?.kind).toBe("function");
    expect(add?.signature).toBe("add(a: number, b: number): number");
    expect(add?.declaredIn).toBe("src/math.ts");
  });

  it("follows a renamed re-export (multiply as times) and keeps the origin signature", () => {
    const times = findSym(data, "times");
    expect(times?.kind).toBe("function");
    // Public name is `times`; the signature is reproduced under that name.
    expect(times?.signature).toBe("times(a: number, b: number): number");
    expect(times?.declaredIn).toBe("src/math.ts");
    // The origin name `multiply` is NOT exposed.
    expect(findSym(data, "multiply")).toBeUndefined();
  });

  it("extracts a const type from its annotation", () => {
    expect(findSym(data, "PI")?.signature).toBe("const PI: number");
    expect(findSym(data, "VERSION")?.signature).toBe("const VERSION: string");
    expect(findSym(data, "VERSION")?.declaredIn).toBe("src/index.ts"); // declared by the entry itself
  });

  it("extracts a class header plus PUBLIC members only (private/protected/#private excluded)", () => {
    const cls = findSym(data, "ApiClient");
    expect(cls?.kind).toBe("class");
    expect(cls?.signature).toBe("class ApiClient");
    const memberNames = (cls?.members ?? []).map((m) => m.name);
    // Public surface members.
    expect(memberNames).toEqual(
      expect.arrayContaining(["defaultTimeout", "baseUrl", "constructor", "get", "create", "isAuthenticated"])
    );
    // Non-public members must be excluded.
    expect(memberNames).not.toContain("token"); // private
    expect(memberNames).not.toContain("retries"); // protected
    expect(memberNames).not.toContain("#secret"); // #private
    expect(memberNames).not.toContain("buildHeaders"); // private method

    // Member signatures + modifiers.
    const get = cls?.members?.find((m) => m.name === "get");
    expect(get?.kind).toBe("method");
    expect(get?.signature).toBe("get<T>(path: string): Promise<T>");
    const create = cls?.members?.find((m) => m.name === "create");
    expect(create?.static).toBe(true);
    const isAuth = cls?.members?.find((m) => m.name === "isAuthenticated");
    expect(isAuth?.kind).toBe("getter");
    const staticProp = cls?.members?.find((m) => m.name === "defaultTimeout");
    expect(staticProp?.static).toBe(true);
  });

  it("extracts interface members with optional flags, and marks an `export type {}` re-export type-only", () => {
    const iface = findSym(data, "ClientOptions");
    expect(iface?.kind).toBe("interface");
    expect(iface?.typeOnly).toBe(true); // re-exported via `export type { ClientOptions }`
    const members = iface?.members ?? [];
    expect(members.find((m) => m.name === "baseUrl")?.signature).toBe("baseUrl: string");
    expect(members.find((m) => m.name === "timeout")?.optional).toBe(true);
    expect(members.find((m) => m.name === "headers")?.signature).toBe("headers: Record<string, string>");
  });

  it("extracts a type alias right-hand side (reached via a bare `export *`)", () => {
    const shape = findSym(data, "Shape");
    expect(shape?.kind).toBe("type");
    expect(shape?.typeOnly).toBe(true); // declared `export type Shape`
    expect(shape?.signature).toContain("type Shape =");
    expect(shape?.signature).toContain("size: number");
    expect(shape?.declaredIn).toBe("src/shapes.ts");
  });

  it("lists enum members (reached via a bare `export *`)", () => {
    const status = findSym(data, "Status");
    expect(status?.kind).toBe("enum");
    expect(status?.signature).toBe("enum Status");
    expect((status?.members ?? []).map((m) => m.name)).toEqual(["Active", "Inactive", "Pending"]);
  });

  it("represents `export * as ns` as a single namespace symbol", () => {
    const utils = findSym(data, "utils");
    expect(utils?.kind).toBe("namespace");
    expect(utils?.signature).toContain("namespace utils");
    expect(utils?.declaredIn).toBe("src/utils.ts");
  });

  it("captures a default export with its signature and exportKind", () => {
    const def = findSym(data, "default");
    expect(def?.exportKind).toBe("default");
    expect(def?.kind).toBe("function");
    expect(def?.signature).toBe("createPackage(): ApiClient");
    expect(def?.declaredIn).toBe("src/index.ts");
  });

  it("reports a re-export from a bare/out-of-scope package as unresolved", () => {
    const unresolved = data.entries[0]!.unresolved;
    const ext = unresolved.find((u) => u.source === "external-dep");
    expect(ext).toBeDefined();
    expect(ext?.kind).toBe("named");
    expect(ext?.names).toContain("something");
    // The unresolved name is not smuggled into the symbol list.
    expect(firstEntrySymbols(data).map((s) => s.name)).not.toContain("something");
  });
});

describe("api_surface — single-file entry mode", () => {
  it("treats a single source file as the sole entry (no package.json read)", async () => {
    const data = structured<Surface>(await call({ target: "src/index.ts" }));
    expect(data.packageEntryPoints).toEqual([]);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]!.entry).toBe("src/index.ts");
    // Same public surface as the package-dir entry resolution.
    expect(data.totalSymbols).toBe(11);
  });

  it("scopes the surface to a sub-module when that file is the entry", async () => {
    const data = structured<Surface>(await call({ target: "src/client.ts" }));
    const names = firstEntrySymbols(data).map((s) => s.name).sort();
    expect(names).toEqual(["ApiClient", "ClientOptions"]);
  });
});

describe("api_surface — options + guards", () => {
  it("omits members when includeMembers=false", async () => {
    const data = structured<Surface>(await call({ target: ".", includeMembers: false }));
    const cls = findSym(data, "ApiClient");
    expect(cls).toBeDefined();
    expect(cls?.members).toBeUndefined();
  });

  it("applies the global symbol limit and flags truncation", async () => {
    const data = structured<Surface>(await call({ target: ".", limit: 3 }));
    expect(data.count).toBe(3);
    expect(data.totalSymbols).toBe(11);
    expect(data.truncated).toBe(true);
    expect(firstEntrySymbols(data)).toHaveLength(3);
  });

  it("errors clearly for a path that is neither a source file nor a package directory", async () => {
    const missing = await call({ target: "src/does-not-exist.ts" });
    expect(missing.isError).toBe(true);
    expect((missing.content[0] as { text: string }).text).toMatch(/single source file|package\.json/i);

    const noManifest = await call({ target: "src" });
    expect(noManifest.isError).toBe(true);
  });

  it("returns markdown when requested", async () => {
    const res = await call({ target: ".", response_format: "markdown" });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toMatch(/^# API surface/);
    expect(text).toContain("ApiClient");
    expect(text).toContain("add(a: number, b: number): number");
  });
});
