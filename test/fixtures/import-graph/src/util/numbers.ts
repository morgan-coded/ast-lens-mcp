// Named re-export target: util/index.ts has `export { clamp } from "./numbers"`.
export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}
