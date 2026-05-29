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
 * supplied markdown rendering. If the text exceeds CHARACTER_LIMIT it is
 * replaced with a compact notice pointing the agent at narrowing options.
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
      truncated: true,
      message: `Response exceeded the ${CHARACTER_LIMIT}-character limit and was summarized. ${hint}`,
      summary: summarize(structured)
    };
    text = JSON.stringify(notice, null, 2);
    return {
      content: [{ type: "text", text }],
      structuredContent: { ...structured, truncated: true, truncationHint: hint }
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
