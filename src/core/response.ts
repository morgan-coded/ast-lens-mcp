/**
 * Tool response helpers.
 *
 * Centralizes how tools render their structured output into MCP tool results,
 * including the response-format toggle (json/markdown), the character-limit
 * guard, and a consistent error result shape.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const CHARACTER_LIMIT = 25_000;

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}

/**
 * Build a successful tool result. The structured object is always attached as
 * `structuredContent`; the text content is either pretty JSON or a caller-
 * supplied markdown rendering. If the rendered TEXT exceeds CHARACTER_LIMIT it
 * is replaced with a compact notice pointing the agent at narrowing options.
 *
 * Important: only the human-facing TEXT is summarized in that case — the
 * `structuredContent` always carries the complete structured payload. The text
 * summarization is signalled with `responseTextTruncated` (a presentation flag)
 * rather than `truncated`, so it never collides with a tool's own data-level
 * `truncated` field (e.g. call_graph capping nodes+edges). Conflating the two
 * made fully-complete structured results look as if data were dropped.
 */
export function toolResult(
  structured: Record<string, unknown>,
  opts: { format: ResponseFormat; markdown?: () => string; narrowHint?: string }
): CallToolResult {
  let text: string;
  if (opts.format === ResponseFormat.MARKDOWN && opts.markdown) {
    text = opts.markdown();
  } else {
    text = JSON.stringify(structured, null, 2);
  }

  if (text.length > CHARACTER_LIMIT) {
    const hint =
      opts.narrowHint ??
      "Narrow the scope (target a specific file or directory, lower the limit, or add filters) to see full results.";
    const notice = {
      responseTextTruncated: true,
      message: `Text response exceeded the ${CHARACTER_LIMIT}-character limit and was summarized; the full result is in structuredContent. ${hint}`,
      summary: summarize(structured)
    };
    text = JSON.stringify(notice, null, 2);
    return {
      content: [{ type: "text", text }],
      // Preserve the complete structured payload (including any tool-set
      // `truncated` flag) and add a distinct presentation-level marker.
      structuredContent: { ...structured, responseTextTruncated: true, truncationHint: hint }
    };
  }

  return {
    content: [{ type: "text", text }],
    structuredContent: structured
  };
}

/** Produce a tiny summary of a structured payload for truncation notices. */
function summarize(structured: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(structured)) {
    if (Array.isArray(value)) {
      summary[`${key}_count`] = value.length;
    } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      summary[key] = value;
    }
  }
  return summary;
}

/** Build an error tool result. Errors are reported in-band per MCP guidance. */
export function errorResult(message: string, suggestion?: string): CallToolResult {
  const text = suggestion ? `Error: ${message}\nSuggestion: ${suggestion}` : `Error: ${message}`;
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: { error: message, ...(suggestion ? { suggestion } : {}) }
  };
}
