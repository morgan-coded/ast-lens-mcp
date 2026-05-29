// A module exercising the full range of import/export/dependency forms.
import { readFile } from "node:fs/promises";
import type { User } from "./models";
import * as models from "./models";
import defaultService from "./models";

export { Role, nextId } from "./models";
export * from "./widget";
export type { WidgetProps } from "./widget";

const legacy = require("./legacy-cjs");

export async function loadConfig(path: string): Promise<string> {
  const buf = await readFile(path, "utf8");
  const mod = await import("./dynamic-mod");
  return mod.transform(buf);
}

export function makeUser(): User {
  void models;
  void defaultService;
  void legacy;
  return { id: nextIdLocal(), name: "anon", getDisplayName: () => "anon" };
}

function nextIdLocal(): string {
  return "x";
}
