/**
 * Shared Zod schema fragments and helpers reused across tool input schemas.
 */
import { z } from "zod";
import { ResponseFormat } from "../core/response.js";

/** A path/dir/glob target, relative to the project root or absolute inside it. */
export const targetSchema = z
  .string()
  .min(1, "target must not be empty")
  .describe(
    "A file path, directory, or glob pattern to analyze, relative to the project root (or absolute inside it). " +
      'Examples: "src/index.ts", "src", "src/**/*.ts". node_modules and build output are ignored automatically.'
  );

/** Response-format toggle shared by all tools. */
export const responseFormatSchema = z
  .nativeEnum(ResponseFormat)
  .default(ResponseFormat.JSON)
  .describe("Output format: 'json' (default, machine-readable) or 'markdown' (human-readable).");

/** Optional extra ignore globs. */
export const ignoreSchema = z
  .array(z.string())
  .optional()
  .describe('Additional glob patterns to ignore, e.g. ["**/*.test.ts"].');

/** A symbol/identifier name. */
export const symbolNameSchema = z
  .string()
  .min(1, "name must not be empty")
  .max(200, "name is unreasonably long")
  .describe("The exact identifier name to look for (case-sensitive).");
