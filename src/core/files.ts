/**
 * File discovery + project-root sandboxing.
 *
 * Resolves a tool's path/glob input into a concrete list of supported source
 * files, always confined to the configured project root. Directory traversal
 * outside the root is refused so a misbehaving client cannot read arbitrary
 * files on the host.
 */
import fg from "fast-glob";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isSupportedFile } from "./parser.js";

/** Default ignore globs applied to every directory/glob scan. */
export const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**"
];

const SUPPORTED_GLOB = "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}";

/** Thrown when a resolved path escapes the project root. */
export class PathEscapeError extends Error {
  constructor(public readonly attempted: string, public readonly root: string) {
    super(`Path "${attempted}" is outside the project root "${root}"`);
    this.name = "PathEscapeError";
  }
}

/** True when `child` is the same as or nested under `parent` (both absolute). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Resolve a possibly-relative path against the root and assert it stays inside. */
export function resolveInsideRoot(root: string, target: string): string {
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
  if (!isInside(root, abs)) {
    throw new PathEscapeError(target, root);
  }
  return abs;
}

export interface DiscoverOptions {
  /** Absolute project root. All results are confined to it. */
  root: string;
  /** A single file path, a directory, or a glob (relative to root or absolute inside root). */
  target: string;
  /** Extra ignore globs to merge with DEFAULT_IGNORE. */
  ignore?: string[];
  /** Hard cap on number of files returned (defensive against huge trees). */
  maxFiles?: number;
}

export interface DiscoverResult {
  files: string[];
  /** True when the result was capped at maxFiles. */
  truncated: boolean;
}

/**
 * Resolve a target into a sorted list of absolute, supported source files,
 * confined to the project root.
 *
 * Resolution rules:
 *  - If `target` is an existing file: return it (if supported), else empty.
 *  - If `target` is an existing directory: recursively glob supported files under it.
 *  - Otherwise treat `target` as a glob pattern, anchored at the root.
 */
export async function discoverFiles(opts: DiscoverOptions): Promise<DiscoverResult> {
  const { root, target } = opts;
  const ignore = [...DEFAULT_IGNORE, ...(opts.ignore ?? [])];
  const maxFiles = opts.maxFiles ?? 5000;

  // Distinguish "looks like a glob" from a literal path. fast-glob treats these
  // chars as magic. If none are present we can stat the path directly.
  const looksLikeGlob = fg.isDynamicPattern(target);

  if (!looksLikeGlob) {
    const abs = resolveInsideRoot(root, target);
    let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
    try {
      stat = await fs.stat(abs);
    } catch {
      stat = undefined;
    }

    if (stat?.isFile()) {
      return { files: isSupportedFile(abs) ? [abs] : [], truncated: false };
    }

    if (stat?.isDirectory()) {
      const matches = await fg(SUPPORTED_GLOB, {
        cwd: abs,
        ignore,
        absolute: true,
        onlyFiles: true,
        dot: false,
        followSymbolicLinks: false,
        suppressErrors: true
      });
      return finalize(matches, root, maxFiles);
    }

    // Non-existent literal path: return empty rather than error so batch tools
    // can skip gracefully.
    return { files: [], truncated: false };
  }

  // Glob path. Anchor at root, force results to stay inside.
  const matches = await fg(target, {
    cwd: root,
    ignore,
    absolute: true,
    onlyFiles: true,
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true
  });
  return finalize(matches.filter(isSupportedFile), root, maxFiles);
}

function finalize(matches: string[], root: string, maxFiles: number): DiscoverResult {
  const inside = matches.filter((m) => isInside(root, m));
  const unique = Array.from(new Set(inside)).sort();
  if (unique.length > maxFiles) {
    return { files: unique.slice(0, maxFiles), truncated: true };
  }
  return { files: unique, truncated: false };
}

/** Make an absolute path relative to root for display (forward slashes). */
export function toDisplayPath(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel === "" ? path.basename(abs) : rel.split(path.sep).join("/");
}
