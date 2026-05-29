// Referenced ONLY via a computed/template dynamic import elsewhere
// (see consumer-computed.ts: `import(`./computed-${k}`)`). That specifier is
// NOT a string literal, so it cannot be resolved to a file and produces no
// edge. This module therefore looks dead -> flagged. This is a DOCUMENTED
// false positive: computed/dynamic specifiers are invisible to static analysis.
export function computedValue(): number {
  return 9;
}
