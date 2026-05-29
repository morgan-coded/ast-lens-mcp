/**
 * Server-wide shared context: the project root and a single parser cache that
 * all tools reuse, plus batch helpers for loading many files while collecting
 * (rather than throwing on) parse errors.
 */
import { ParserCache, type ParsedFile } from "./parser.js";
import { discoverFiles, type DiscoverResult, toDisplayPath } from "./files.js";
import type { ParseErrorInfo } from "./types.js";

export interface BatchLoad {
  parsed: ParsedFile[];
  parseErrors: ParseErrorInfo[];
  /** True when file discovery was capped. */
  truncated: boolean;
  /** Number of files discovered (before parsing). */
  discovered: number;
}

export class ServerContext {
  readonly cache: ParserCache;

  constructor(public readonly root: string, cache?: ParserCache) {
    this.cache = cache ?? new ParserCache();
  }

  /** Make an absolute path relative to the project root for display. */
  display(abs: string): string {
    return toDisplayPath(this.root, abs);
  }

  /**
   * Discover + parse all supported files for a target. Parse failures are
   * collected into `parseErrors` with display paths; they never throw.
   */
  async loadBatch(target: string, opts?: { ignore?: string[]; maxFiles?: number }): Promise<BatchLoad> {
    const discovery: DiscoverResult = await discoverFiles({
      root: this.root,
      target,
      ...(opts?.ignore ? { ignore: opts.ignore } : {}),
      ...(opts?.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {})
    });

    const parsed: ParsedFile[] = [];
    const parseErrors: ParseErrorInfo[] = [];

    for (const file of discovery.files) {
      const result = await this.cache.load(file);
      if (result.ok) {
        parsed.push(result.value);
      } else {
        parseErrors.push({
          file: this.display(result.error.file),
          message: result.error.error.message,
          ...(result.error.error.position ? { position: result.error.error.position } : {})
        });
      }
    }

    return {
      parsed,
      parseErrors,
      truncated: discovery.truncated,
      discovered: discovery.files.length
    };
  }
}
