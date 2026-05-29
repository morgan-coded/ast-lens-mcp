// Edge-case symbol/export forms, for regression coverage.

const renameMe = 1;
function renameFn(): void {}
// Renamed named export: both must report exported=true despite the rename.
export { renameMe as publicValue, renameFn as publicFn };

// Ambient declarations (TSDeclareFunction / declare const).
export declare function ambientExported(x: number): void;
declare function ambientLocal(): void;

// Optional-chaining call sites — exercise calls_to / console_usage through `?.`.
export function useOptional(logger?: { log: (m: string) => void }): void {
  logger?.log("hi");
  console?.log("via optional console");
}
