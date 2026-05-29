import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Fixtures are sample source files analyzed at runtime, not test files.
    exclude: ["test/fixtures/**", "node_modules/**", "dist/**"],
    environment: "node"
  }
});
