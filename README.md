# ast-lens-mcp

> An MCP server that gives AI agents **structural understanding** of a TypeScript / JavaScript codebase — so an agent can *query* code structure instead of reading whole files into its context window.

`ast-lens-mcp` parses your project with the Babel AST toolchain and exposes six focused, read-only tools over the [Model Context Protocol](https://modelcontextprotocol.io). Point it at a project root and an LLM client (Claude Desktop, Cursor, or anything that speaks MCP) can ask precise structural questions: *what symbols are exported here? where is this function called? which functions are too complex? what does this module import?* — all without paging entire files through the model.

It runs entirely on your **local files**. No API keys, no network calls, no credentials.

- **Built with:** TypeScript (strict), the official [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [`@babel/parser`](https://babeljs.io/docs/babel-parser) / [`@babel/traverse`](https://babeljs.io/docs/babel-traverse) / `@babel/types` for AST analysis, [`zod`](https://zod.dev) for tool input schemas, and [`vitest`](https://vitest.dev) for tests.
- **Transport:** stdio. **Runtime:** Node 18+. **Module system:** ESM.
- **Languages analyzed:** `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`. `node_modules` and build output are ignored automatically.

---

## Why this exists

Coding agents waste a lot of context re-reading files just to answer structural questions ("does this symbol exist?", "where is it used?", "what's the shape of this class?"). Those questions have *exact* answers that come from the AST, not from an approximate read. `ast-lens-mcp` turns them into cheap, deterministic tool calls that return small structured JSON — leaving more of the model's context for actual reasoning.

It is deliberately **syntactic, not type-aware**: it parses, it does not type-check. That keeps it fast, dependency-light, and able to analyze a file in isolation (no `tsconfig` resolution, no whole-program build). `find_references` is therefore a precise *name-based* search classified by syntactic role, not a type-resolved rename index — see the note on that tool below.

---

## Install

```bash
# from npm (once published)
npm install -g ast-lens-mcp

# or run without installing
npx ast-lens-mcp /path/to/your/project
```

From source:

```bash
git clone <your-repo-url> ast-lens-mcp
cd ast-lens-mcp
npm install
npm run build
node dist/index.js /path/to/your/project   # boots on stdio
```

The project root that tools analyze is resolved in this order:

1. a positional CLI arg or `--root <path>` flag,
2. the `AST_LENS_PROJECT_ROOT` environment variable,
3. the current working directory.

---

## MCP client configuration

### Claude Desktop

Add an entry to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ast-lens": {
      "command": "npx",
      "args": ["-y", "ast-lens-mcp", "/absolute/path/to/your/project"]
    }
  }
}
```

Or, if installed globally / from source:

```json
{
  "mcpServers": {
    "ast-lens": {
      "command": "node",
      "args": ["/absolute/path/to/ast-lens-mcp/dist/index.js"],
      "env": {
        "AST_LENS_PROJECT_ROOT": "/absolute/path/to/your/project"
      }
    }
  }
}
```

### Generic `mcp.json` (Cursor, VS Code MCP, etc.)

```json
{
  "mcpServers": {
    "ast-lens": {
      "command": "npx",
      "args": ["-y", "ast-lens-mcp", "${workspaceFolder}"]
    }
  }
}
```

All paths passed to tools are interpreted **relative to the project root** (or absolute, as long as they stay inside it). Directory traversal outside the root is refused, and so are symlinks that resolve to a location outside the root — the server verifies the real (symlink-resolved) path before reading any file.

---

## Tools

Every tool is read-only (`readOnlyHint: true`, `openWorldHint: false`), validates input with a strict zod schema, returns both human-readable text and machine-readable `structuredContent`, supports `response_format: "json" | "markdown"`, and never throws on bad input — parse failures come back as structured `parseErrors`.

### 1. `list_symbols`

All top-level / exported symbols (function, class, interface, type, enum, const/let/var) across a file, directory, or glob.

```jsonc
// input
{ "target": "src/models.ts", "kinds": ["function", "class"] }

// output (abridged)
{
  "totalSymbols": 3,
  "fileCount": 1,
  "files": [
    {
      "file": "src/models.ts",
      "symbols": [
        { "name": "nextId", "kind": "function", "exported": true,
          "exportKind": "named", "span": { "start": {"line":21,"column":8}, "end": {"line":24,"column":2} } },
        { "name": "UserService", "kind": "class", "exported": true, "exportKind": "named",
          "span": { "start": {"line":26,"column":8}, "end": {"line":44,"column":2} } }
      ]
    }
  ],
  "parseErrors": []
}
```

Options: `kinds` (filter), `exportedOnly`, `ignore` (extra globs), `response_format`.

### 2. `get_file_outline`

A hierarchical outline of **one** file: classes with their methods/properties, interfaces with their members, enums with their members.

```jsonc
// input
{ "file": "src/models.ts" }

// output (abridged)
{
  "file": "src/models.ts",
  "symbolCount": 8,
  "outline": [
    { "name": "User", "kind": "interface", "exported": true,
      "children": [
        { "name": "id", "kind": "property", "span": { "start": {"line":4,"column":3}, ... } },
        { "name": "getDisplayName", "kind": "method", "span": { ... } }
      ] },
    { "name": "UserService", "kind": "class", "exported": true,
      "children": [
        { "name": "create", "kind": "method", "static": true, "span": { ... } },
        { "name": "count", "kind": "getter", "span": { ... } },
        { "name": "findById", "kind": "method", "async": true, "span": { ... } }
      ] }
  ]
}
```

### 3. `find_references`

Every reference to an identifier name across the project, with locations, a source snippet, and a syntactic-context classification (`call` / `import` / `declaration` / `type` / `jsx` / `reference`).

```jsonc
// input
{ "name": "UserService", "target": "src" }

// output (abridged)
{
  "name": "UserService",
  "total": 6,
  "count": 6,
  "references": [
    { "file": "src/models.ts", "context": "declaration",
      "snippet": "export class UserService {", "span": { "start": {"line":26,"column":14}, ... } },
    { "file": "src/models.ts", "context": "call",
      "snippet": "return new UserService();", "span": { ... } },
    { "file": "src/widget.tsx", "context": "import",
      "snippet": "import { UserService } from \"./models\";", "span": { ... } }
  ],
  "byContext": { "declaration": 1, "type": 1, "call": 1, "reference": 2, "import": 1 },
  "parseErrors": [ { "file": "src/broken.ts", "message": "Unexpected keyword 'const'. (3:2)", "position": {"line":3,"column":3} } ]
}
```

> **Note:** this is a fast, name-based search (no full type resolution), so identical names from different scopes/modules are all reported. Use the `snippet` and `context` to disambiguate, and the `byContext` histogram to, e.g., count only call sites. Options: `target` (defaults to the whole project), `includeDeclarations`, `ignore`, `limit`, `response_format`.

### 4. `search_ast`

Structural queries over the AST — far more precise than text search. Ships a curated set of named queries plus a generic node-type escape hatch:

| query | finds |
|---|---|
| `calls_to` | calls to a specific callee (set `callee`, e.g. `"console.log"` or `"fetch"`) |
| `console_usage` | any `console.*` call |
| `any_usage` | TypeScript `any` type annotations |
| `non_null_assertion` | TypeScript `!` non-null assertions |
| `await_in_loop` | `await` inside `for`/`while` loops (a sequential-await perf smell) |
| `empty_catch` | `catch` clauses with an empty body (swallowed errors) |
| `todo_fixme` | `TODO` / `FIXME` / `HACK` / `XXX` markers in comments |
| `ts_ignore` | `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` suppression comments |
| `node_type` | generic: match any Babel node type (set `nodeType`, e.g. `"TryStatement"`) |

```jsonc
// input
{ "query": "await_in_loop", "target": "src/smelly.ts" }

// output
{
  "query": "await_in_loop",
  "total": 1,
  "matches": [
    { "file": "src/smelly.ts", "nodeType": "AwaitExpression",
      "snippet": "const result = await fetchValue(item); // await in loop",
      "span": { "start": {"line":8,"column":20}, "end": {"line":8,"column":42} } }
  ],
  "parseErrors": []
}
```

### 5. `analyze_complexity`

Per-function cyclomatic complexity (McCabe: `1 + decision points` — `if`, loops, each non-default `case`, `catch`, ternary, `&&`/`||`/`??`, and optional chaining) plus lines-of-code, with a threshold flag. Nested functions are measured independently.

```jsonc
// input
{ "target": "src/smelly.ts", "threshold": 5, "flaggedOnly": true }

// output
{
  "threshold": 5,
  "totalFunctions": 4,
  "flaggedCount": 1,
  "maxComplexity": 6,
  "averageComplexity": 2.75,
  "files": [
    { "file": "src/smelly.ts",
      "functions": [
        { "name": "classify", "kind": "function", "complexity": 6, "loc": 16, "params": 1,
          "overThreshold": true, "span": { "start": {"line":23,"column":8}, ... } }
      ] }
  ]
}
```

Options: `threshold`, `flaggedOnly`, `sortBy` (`complexity` | `loc` | `location`), `ignore`, `limit`, `response_format`.

### 6. `summarize_module`

One file's imports, exports, and dependencies — including static imports, re-exports, dynamic `import()` calls, and `require()` calls. Dependencies are split into local (relative/absolute paths) vs external (bare package specifiers).

```jsonc
// input
{ "file": "src/barrel.ts" }

// output (abridged)
{
  "file": "src/barrel.ts",
  "imports": [
    { "source": "node:fs/promises", "typeOnly": false, "bindings": [ { "local": "readFile", "imported": "readFile" } ] },
    { "source": "./models", "typeOnly": true,  "bindings": [ { "local": "User", "imported": "User" } ] },
    { "source": "./models", "typeOnly": false, "bindings": [ { "local": "models", "imported": "*" } ] },
    { "source": "./models", "typeOnly": false, "bindings": [ { "local": "defaultService", "imported": "default" } ] }
  ],
  "exports": [
    { "name": "Role", "kind": "named", "source": "./models", "typeOnly": false },
    { "name": "*", "kind": "named", "source": "./widget", "typeOnly": false },
    { "name": "loadConfig", "kind": "named", "typeOnly": false }
  ],
  "dependencies": ["./dynamic-mod", "./legacy-cjs", "./models", "./widget", "node:fs/promises"],
  "localDependencies": ["./dynamic-mod", "./legacy-cjs", "./models", "./widget"],
  "externalDependencies": ["node:fs/promises"],
  "counts": { "imports": 4, "exports": 6, "dependencies": 5 }
}
```

---

## Architecture

```
src/
  index.ts            # bin entry — resolves project root, starts stdio transport
  server.ts           # builds the McpServer and registers all tools (transport-agnostic)
  core/               # the reusable AST layer
    parser.ts         #   Babel parse + mtime-based parse cache (never throws)
    files.ts          #   glob/dir/file discovery, node_modules ignore, path-traversal sandbox
    traverse.ts       #   shared traversal helpers + cyclomatic-complexity engine
    extract.ts        #   symbol / outline / module-summary extraction
    context.ts        #   ServerContext: shared root + cache + batch loader
    response.ts       #   JSON/Markdown formatting, character-limit guard, error results
    types.ts          #   shared structured-output types
  tools/              # one file per tool, each exporting register<Tool>(server, ctx)
    listSymbols.ts  getFileOutline.ts  findReferences.ts
    searchAst.ts    analyzeComplexity.ts  summarizeModule.ts
    shared.ts         #   shared zod schema fragments
test/
  core.test.ts        # parser, cache, path-safety, complexity
  tools.test.ts       # every tool, end-to-end through an in-memory MCP client
  fixtures/sample-project/  # small, realistic fixtures (incl. a deliberately broken file)
scripts/
  smoke.mjs           # boots the built server over real stdio and exercises the tools
```

Design notes:

- **Robust by construction.** A bad file never crashes a call: the parser returns a structured result, and batch tools collect failures into `parseErrors`. Tools that expect a single file return actionable errors when handed a directory or glob.
- **Sandboxed.** Tool inputs are confined to the project root; any path that resolves outside it — including via a symlink that points out of the tree — is rejected (`PathEscapeError`) before any file is read.
- **Context-friendly.** Responses carry a 25k-character guard that summarizes oversized payloads and tells the agent how to narrow the query.

---

## Development

```bash
npm install
npm run build        # bundle with tsup -> dist/index.js (executable, ESM)
npm run typecheck    # tsc --noEmit, strict, over src + tests
npm test             # vitest run (47 tests)
npm run smoke        # build first, then boot the server over stdio and call tools
npm run dev          # tsx watch (run the server from source)
```

---

## License

MIT © Morgan
