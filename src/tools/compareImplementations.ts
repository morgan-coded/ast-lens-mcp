/**
 * Tool: compare_implementations
 *
 * Compares two implementations of the same functionality (e.g. two candidate
 * solutions to the same task) on objective, AST-derived structural signals and
 * surfaces a side-by-side comparison plus a transparent, caveated preference
 * recommendation.
 *
 * This is decision SUPPORT for a "which solution is better, and why" judgment
 * (preference ranking / rubric review of generated code), not an automated
 * correctness verdict. Every signal is a deterministic count from the AST; the
 * recommendation is an auditable per-dimension tally with the weights exposed in
 * the output, and the caveats state plainly what the metrics do and do not show.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as t from "@babel/types";
import { z } from "zod";
import type { ServerContext, BatchLoad } from "../core/context.js";
import { errorResult, toolResult } from "../core/response.js";
import { analyzeAllFunctions, locOf, traverse } from "../core/traverse.js";
import type { ParseErrorInfo } from "../core/types.js";
import { ignoreSchema, responseFormatSchema, targetSchema } from "./shared.js";

const inputSchema = z
  .object({
    left: targetSchema.describe(
      "First implementation: a file, directory, or glob (relative to project root). Treat as candidate A."
    ),
    right: targetSchema.describe(
      "Second implementation: a file, directory, or glob (relative to project root). Treat as candidate B."
    ),
    leftLabel: z.string().min(1).max(40).default("left").describe("Human label for the first implementation."),
    rightLabel: z.string().min(1).max(40).default("right").describe("Human label for the second implementation."),
    complexityThreshold: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe("Cyclomatic-complexity threshold used only to count 'flagged' functions per side (default 10)."),
    ignore: ignoreSchema,
    response_format: responseFormatSchema
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

/** Objective, AST-derived signals computed for one implementation. */
interface Metrics {
  /** Number of function-like definitions found. */
  functions: number;
  /** Sum of function body LOC (a size proxy). */
  functionLoc: number;
  /** Non-empty source lines across the side's files (a size proxy). */
  codeLines: number;
  totalComplexity: number;
  maxComplexity: number;
  averageComplexity: number;
  /** Functions at or above complexityThreshold. */
  flaggedFunctions: number;
  /** Largest parameter count of any function. */
  maxParams: number;
  /** `catch` clauses. */
  tryCatch: number;
  /** `catch` clauses with an empty body (swallowed errors). */
  emptyCatch: number;
  /** `throw` statements. */
  throws: number;
  /** `await` expressions. */
  awaits: number;
  /** Comments containing TODO/FIXME/XXX/HACK. */
  todoComments: number;
  /** `console.*` calls (debug leftovers). */
  consoleCalls: number;
  /** TS `any` keyword annotations. */
  anyAnnotations: number;
  /** TS non-null assertions (`x!`). */
  nonNullAssertions: number;
}

interface SideResult {
  label: string;
  target: string;
  metrics: Metrics;
  parseErrors: ParseErrorInfo[];
}

type Direction = "lower_is_better" | "higher_is_better";

interface DimensionSpec {
  name: string;
  weight: number;
  direction: Direction;
  /** How much the two values must differ before a dimension is decisive. */
  margin: number;
  get: (m: Metrics) => number;
  /** Short phrase describing the "good" outcome, used in rationale. */
  better: string;
}

/**
 * The comparison rubric. Counts are mostly "lower is better" code smells;
 * error-handling presence is "higher is better". Weights are deliberately small
 * and explicit so the tally is auditable rather than a black box.
 */
const DIMENSIONS: DimensionSpec[] = [
  // Complexity is noisy at the margins, so require a real gap. The count-based
  // smells are binary-ish signals where any nonzero difference is meaningful.
  { name: "averageComplexity", weight: 2, direction: "lower_is_better", margin: 0.5, get: (m) => m.averageComplexity, better: "lower average complexity" },
  { name: "maxComplexity", weight: 1, direction: "lower_is_better", margin: 1, get: (m) => m.maxComplexity, better: "a lower complexity peak" },
  { name: "emptyCatch", weight: 2, direction: "lower_is_better", margin: 0, get: (m) => m.emptyCatch, better: "fewer empty catch blocks" },
  { name: "anyAnnotations", weight: 1, direction: "lower_is_better", margin: 0, get: (m) => m.anyAnnotations, better: "fewer `any` annotations" },
  { name: "nonNullAssertions", weight: 1, direction: "lower_is_better", margin: 0, get: (m) => m.nonNullAssertions, better: "fewer non-null assertions" },
  { name: "consoleCalls", weight: 1, direction: "lower_is_better", margin: 0, get: (m) => m.consoleCalls, better: "fewer leftover console calls" },
  { name: "todoComments", weight: 1, direction: "lower_is_better", margin: 0, get: (m) => m.todoComments, better: "fewer TODO/FIXME markers" },
  { name: "maxParams", weight: 1, direction: "lower_is_better", margin: 1, get: (m) => m.maxParams, better: "smaller parameter lists" },
  { name: "errorHandling", weight: 1, direction: "higher_is_better", margin: 0, get: (m) => m.tryCatch + m.throws, better: "more explicit error handling" }
];

export function registerCompareImplementations(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "compare_implementations",
    {
      title: "Compare Implementations",
      description: `Compare two implementations of the same functionality (e.g. two candidate solutions to one task) on objective, AST-derived structural signals, and return a side-by-side comparison plus a transparent preference recommendation.

This is decision SUPPORT for a "which solution is better, and why" judgment — preference ranking / rubric review of generated code. It is NOT a correctness verdict: every number is a deterministic count from the AST, the recommendation is an auditable per-dimension tally (weights are in the output), and the caveats state what the signals do and do not prove. Run the candidates' tests for ground truth on correctness.

Signals per side: function count, summed function LOC, cyclomatic complexity (total/max/average and a flagged count over a threshold), max parameter count, try/catch and empty-catch counts, throw and await counts, TODO/FIXME markers, console.* calls, TS \`any\` annotations, and non-null assertions.

Args:
  - left (string): first implementation — file, directory, or glob.
  - right (string): second implementation — file, directory, or glob.
  - leftLabel / rightLabel (string): human labels (default 'left' / 'right').
  - complexityThreshold (number): threshold for the per-side flagged count, 1-100 (default 10).
  - ignore (string[], optional): extra ignore globs.
  - response_format ('json'|'markdown'): output format (default 'json').

Returns (JSON):
  {
    "left":  { "label": string, "target": string, "metrics": {...}, "parseErrors": [...] },
    "right": { "label": string, "target": string, "metrics": {...}, "parseErrors": [...] },
    "dimensions": [ { "name", "weight", "direction", "leftValue", "rightValue", "winner": "left"|"right"|"tie", "delta" } ],
    "score": { "left": number, "right": number },
    "recommendation": "prefer_left" | "prefer_right" | "comparable" | "insufficient_signal",
    "rationale": [ string ],
    "caveats": [ string ]
  }

Examples:
  - "Which of these two solutions is structurally cleaner?" -> left="solutions/a.ts", right="solutions/b.ts"
  - "Compare the old and new versions" -> left="src/old", right="src/new", leftLabel="old", rightLabel="new"

Notes:
  - A dimension is only decisive when the two sides differ by more than its margin; otherwise it is a tie.
  - 'comparable' means no measurable structural edge either way; 'insufficient_signal' means neither side parsed into any function.
  - Lower complexity is usually but not always better — a terse solution can omit needed handling. Treat this as a starting point for review, not the answer.`,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input: Input) => {
      try {
        const ignore = input.ignore ? { ignore: input.ignore } : undefined;
        const [leftBatch, rightBatch] = await Promise.all([
          ctx.loadBatch(input.left, ignore),
          ctx.loadBatch(input.right, ignore)
        ]);

        const left: SideResult = {
          label: input.leftLabel,
          target: input.left,
          metrics: computeMetrics(leftBatch, input.complexityThreshold),
          parseErrors: leftBatch.parseErrors
        };
        const right: SideResult = {
          label: input.rightLabel,
          target: input.right,
          metrics: computeMetrics(rightBatch, input.complexityThreshold),
          parseErrors: rightBatch.parseErrors
        };

        const { dimensions, score, recommendation, rationale } = compare(left, right);
        const caveats = buildCaveats(left, right);

        const structured = { left, right, dimensions, score, recommendation, rationale, caveats };

        return toolResult(structured, {
          format: input.response_format,
          markdown: () => renderMarkdown(structured)
        });
      } catch (err) {
        return errorResult(
          err instanceof Error ? err.message : String(err),
          "Check that both 'left' and 'right' resolve to files inside the project root."
        );
      }
    }
  );
}

/** Aggregate AST-derived signals across every parsed file in a side's batch. */
function computeMetrics(batch: BatchLoad, threshold: number): Metrics {
  const m: Metrics = {
    functions: 0,
    functionLoc: 0,
    codeLines: 0,
    totalComplexity: 0,
    maxComplexity: 0,
    averageComplexity: 0,
    flaggedFunctions: 0,
    maxParams: 0,
    tryCatch: 0,
    emptyCatch: 0,
    throws: 0,
    awaits: 0,
    todoComments: 0,
    consoleCalls: 0,
    anyAnnotations: 0,
    nonNullAssertions: 0
  };

  for (const parsed of batch.parsed) {
    // Complexity / LOC / params reuse the same engine as analyze_complexity so
    // the two tools agree on the numbers.
    const fns = analyzeAllFunctions(parsed.ast, threshold);
    for (const fn of fns) {
      m.functions++;
      m.functionLoc += fn.loc;
      m.totalComplexity += fn.complexity;
      if (fn.complexity > m.maxComplexity) m.maxComplexity = fn.complexity;
      if (fn.overThreshold) m.flaggedFunctions++;
      if (fn.params > m.maxParams) m.maxParams = fn.params;
    }

    // Non-empty source lines, a coarse size proxy.
    for (const line of parsed.code.split(/\r?\n/)) {
      if (line.trim().length > 0) m.codeLines++;
    }

    // One structural pass for the smell signals.
    traverse(parsed.ast, {
      CatchClause(path) {
        m.tryCatch++;
        const body = path.node.body;
        if (t.isBlockStatement(body) && body.body.length === 0) m.emptyCatch++;
      },
      ThrowStatement() {
        m.throws++;
      },
      AwaitExpression() {
        m.awaits++;
      },
      TSAnyKeyword() {
        m.anyAnnotations++;
      },
      TSNonNullExpression() {
        m.nonNullAssertions++;
      },
      CallExpression(path) {
        const callee = path.node.callee;
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object) && callee.object.name === "console") {
          m.consoleCalls++;
        }
      }
    });

    // Comments are on the File node, not visited by traverse.
    for (const comment of parsed.ast.comments ?? []) {
      if (/\b(TODO|FIXME|XXX|HACK)\b/i.test(comment.value)) m.todoComments++;
    }
  }

  m.averageComplexity = m.functions === 0 ? 0 : Number((m.totalComplexity / m.functions).toFixed(2));
  return m;
}

interface DimensionResult {
  name: string;
  weight: number;
  direction: Direction;
  leftValue: number;
  rightValue: number;
  winner: "left" | "right" | "tie";
  delta: number;
}

/** Run the rubric and tally an auditable per-dimension score. */
function compare(left: SideResult, right: SideResult) {
  const dimensions: DimensionResult[] = [];
  let leftScore = 0;
  let rightScore = 0;
  const rationale: string[] = [];

  for (const dim of DIMENSIONS) {
    const lv = dim.get(left.metrics);
    const rv = dim.get(right.metrics);
    const delta = Number((lv - rv).toFixed(2));
    let winner: "left" | "right" | "tie" = "tie";

    if (Math.abs(delta) > dim.margin) {
      const leftIsLower = lv < rv;
      const leftWins = dim.direction === "lower_is_better" ? leftIsLower : !leftIsLower;
      winner = leftWins ? "left" : "right";
      if (leftWins) leftScore += dim.weight;
      else rightScore += dim.weight;
      const w = winner === "left" ? left : right;
      const wv = winner === "left" ? lv : rv;
      const ov = winner === "left" ? rv : lv;
      rationale.push(`${w.label} has ${dim.better} (${wv} vs ${ov}).`);
    }

    dimensions.push({ name: dim.name, weight: dim.weight, direction: dim.direction, leftValue: lv, rightValue: rv, winner, delta });
  }

  const bothEmpty = left.metrics.functions === 0 && right.metrics.functions === 0;
  let recommendation: "prefer_left" | "prefer_right" | "comparable" | "insufficient_signal";
  if (bothEmpty) {
    recommendation = "insufficient_signal";
  } else if (leftScore > rightScore) {
    recommendation = "prefer_left";
  } else if (rightScore > leftScore) {
    recommendation = "prefer_right";
  } else {
    recommendation = "comparable";
  }

  return { dimensions, score: { left: leftScore, right: rightScore }, recommendation, rationale };
}

/** Caveats are first-class output: they state what the signals do and do not prove. */
function buildCaveats(left: SideResult, right: SideResult): string[] {
  const caveats = [
    "These are objective STRUCTURAL signals, not a correctness or behavior judgment — run the candidates' own tests for ground truth.",
    "Lower complexity/size is usually but not always better: a terse solution can omit needed edge-case handling. Use this to focus a review, not to decide it.",
    "Signals are static counts; they do not detect logic bugs, missing requirements, performance, or security issues."
  ];
  if (left.parseErrors.length > 0 || right.parseErrors.length > 0) {
    caveats.push("One or more files failed to parse; the affected side's signals are incomplete (see parseErrors).");
  }
  return caveats;
}

interface ComparisonResult {
  left: SideResult;
  right: SideResult;
  dimensions: DimensionResult[];
  score: { left: number; right: number };
  recommendation: string;
  rationale: string[];
  caveats: string[];
}

function renderMarkdown({ left, right, dimensions, score, recommendation, rationale, caveats }: ComparisonResult): string {
  const lines: string[] = [
    `# Compare: ${left.label} vs ${right.label}`,
    "",
    `Recommendation: **${recommendation}** (score ${left.label} ${score.left} – ${score.right} ${right.label})`,
    "",
    `| Dimension | ${left.label} | ${right.label} | Winner |`,
    "| --- | --- | --- | --- |"
  ];
  for (const d of dimensions) {
    lines.push(`| ${d.name} | ${d.leftValue} | ${d.rightValue} | ${d.winner} |`);
  }
  lines.push("");
  if (rationale.length > 0) {
    lines.push("## Why", ...rationale.map((r) => `- ${r}`), "");
  }
  lines.push("## Caveats", ...caveats.map((c) => `- ${c}`));
  return lines.join("\n");
}
