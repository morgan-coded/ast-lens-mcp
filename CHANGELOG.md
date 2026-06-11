# Changelog

## Unreleased

Adds a thirteenth tool, `compare_implementations`.

- `compare_implementations` compares two implementations of the same functionality (e.g. two candidate solutions to one task) on objective, AST-derived structural signals — cyclomatic complexity, empty `catch` blocks, `console.*` calls, TS `any` annotations, non-null assertions, TODO/FIXME markers, parameter counts, and error-handling — and returns a side-by-side table plus a transparent, auditable preference recommendation (`prefer_left` / `prefer_right` / `comparable` / `insufficient_signal`). The output includes explicit caveats: the signals are structural only and are not a correctness verdict.

Verification: `npm run typecheck`, `npm test` (183 tests), `npm run build`, and `npm run smoke` (13 tools exposed and exercised).

## 0.2.0 - 2026-05-29

This release expands `ast-lens-mcp` from eight tools to twelve.

New tools:

- `import_graph` maps resolved import, re-export, dynamic import, and `require()` edges.
- `detect_circular_deps` reports circular dependencies in the module graph.
- `find_dead_files` finds source files that are not reachable from package or index entry points.
- `api_surface` shows the public symbols reachable from a package or entry file, with best-effort signatures.

Also fixed `find_unused_exports` for modern TS-ESM projects that write relative imports or re-exports with `.js` specifiers while the source files are `.ts`, `.tsx`, `.mts`, `.cts`, or `.d.ts`. Those public re-exports are now resolved back to source instead of being misread as unused.

Verification for this release: `npm run typecheck`, `npm test` (178 tests), `npm run build`, and `npm run smoke` (12 tools exposed and exercised).
