import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  // The published product is the CLI/stdio server (the `bin`), not a typed
  // library, so we don't emit declaration files.
  dts: false,
  sourcemap: true,
  splitting: false,
  shims: false
  // tsup preserves the `#!/usr/bin/env node` shebang already present at the top
  // of src/index.ts and marks the output executable, so no banner is needed.
});
