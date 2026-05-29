// Second call-graph file: defines `helper`, the cross-file callee of alpha().

export function helper(n: number): number {
  return inner(n) * 2;
}

function inner(n: number): number {
  return n + 1;
}
