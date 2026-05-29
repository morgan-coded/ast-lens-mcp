// Star-re-exported by the barrel (`export * from "./shapes"`), so every export
// here is public API: the type alias `Shape`, the enum `Status`, and the
// function `makeShape`. `internalShapeHelper` is NOT exported, so it is invisible.

export type Shape = {
  kind: "circle" | "square";
  size: number;
};

export enum Status {
  Active,
  Inactive,
  Pending
}

export function makeShape(size: number): Shape {
  return { kind: "circle", size: normalizeSize(size) };
}

// Internal, non-exported -> never on the surface (even through the star).
function normalizeSize(size: number): number {
  return size < 0 ? 0 : size;
}
