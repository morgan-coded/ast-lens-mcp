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

/** Resolve a possibly-relative path against the root and assert it stays inside.
 *
 * This is a TEXTUAL check only (`path.resolve` does not follow symlinks). It
 * rejects `..` traversal and absolute paths outside the root, but a symlink
 * that lives inside the root yet points outside it will pass here — callers
 * that touch the filesystem must additionally verify the *real* path with
 * {@link assertRealPathInside}. */
export function resolveInsideRoot(root: string, target: string): string {
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
  if (!isInside(root, abs)) {
    throw new PathEscapeError(target, root);
  }
  return abs;
}

/**
 * Verify that the symlink-resolved (real) location of `abs` is still inside the
 * symlink-resolved root. This closes a sandbox-escape hole: a symlink placed
 * inside the project root can otherwise point at arbitrary files on the host,
 * and a textual containment check (which does not follow links) would let it
 * through while `fs.readFile` happily follows the link.
 *
 * Resolves the longest existing prefix of `abs` (the path itself may not exist
 * yet) and compares it against the real root. Throws {@link PathEscapeError}
 * when the real target escapes. If neither the path nor the root can be
 * realpath-resolved (e.g. the root itself is missing) it falls back to the
 * textual check already performed by the caller.
 */
export async function assertRealPathInside(root: string, abs: string): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    // Root does not exist / cannot be resolved — nothing more we can verify
    // here; the textual check in resolveInsideRoot already ran.
    return;
  }

  // Resolve the longest existing ancestor of `abs`, then re-append the
  // non-existent tail. This handles paths that don't exist yet without letting
  // a symlinked existing ancestor smuggle us out of the root.
  let probe = abs;
  const tail: string[] = [];
  // Bounded walk up the directory tree.
  for (let i = 0; i < 4096; i++) {
    try {
      const realProbe = await fs.realpath(probe);
      const realTarget = tail.length ? path.join(realProbe, ...tail.reverse()) : realProbe;
      if (!isInside(realRoot, realTarget)) {
        throw new PathEscapeError(abs, root);
      }
      return;
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Reached the filesystem root without resolving anything real.
        return;
      }
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
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
    // Reject symlinks that resolve outside the root before touching the file.
    await assertRealPathInside(root, abs);
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

async function finalize(matches: string[], root: string, maxFiles: number): Promise<DiscoverResult> {
  const inside = matches.filter((m) => isInside(root, m));
  // Drop any path whose symlink-resolved location escapes the root. fast-glob is
  // configured with followSymbolicLinks:false, but a glob can still match a
  // symlinked file (or a file reached through a symlinked ancestor in the
  // directory-target branch), so verify the real path defensively.
  const verified: string[] = [];
  for (const m of inside) {
    try {
      await assertRealPathInside(root, m);
      verified.push(m);
    } catch {
      // escapes the root — silently exclude
    }
  }
  const unique = Array.from(new Set(verified)).sort();
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
