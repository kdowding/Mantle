// Detect when the agent loop is repeating itself unproductively.
//
// Mantle's per-turn iteration cap (default 100) protects against
// unbounded runs but is a blunt tool — by the time it fires, 100
// iterations of wasted work have already happened. This module catches
// the common "stuck" patterns within 3-5 calls so most turns abort or
// self-correct early. It runs after every tool result, looking at a
// rolling window of recent calls fingerprinted by `(toolName, argsHash,
// resultHash)`.
//
// Patterns we catch today:
//   - Failing tool: same tool failing in an UNBROKEN streak (args-agnostic) —
//     soft warn at 3, hard abort at 6. Counted as a streak since the tool's
//     last SUCCESS, so a healthy fail→fix→succeed loop resets and never
//     aborts. Checked first so thrash-with-different-args is caught even
//     though the args-repeat rule (identical args only) never would. bash is
//     excluded — its non-zero exits are benign control-flow, not stuck-ness.
//     Needs the per-result status fed into record().
//   - Same (tool, args) called 3+ times — model is querying for the
//     same answer repeatedly. Soft warn: append a hint to the result so
//     the model self-corrects next iteration.
//   - Same (tool, args) called 5+ times — model is stuck in a loop.
//     Hard abort: persist the result with the warning, then exit the
//     turn so the user can intervene.
//   - No progress: a read-only query lens (recall / recall_source) returns
//     the byte-identical result 2+ times — rephrasing the query but
//     learning nothing. Soft warn. (read/glob/grep are excluded — the
//     turn-cache already short-circuits their identical repeats.)
//   - Ping-pong between exactly two fingerprints, alternating with no
//     break — read/edit/read/edit non-convergence. Soft warn.
//
// Hashes are stable JSON sha256 (sorted keys) so semantically-identical
// objects with different insertion orders hash the same. argsHash and
// resultHash are derived independently so a "polling" call with same
// args but evolving result doesn't trip the args-repeat rule by itself
// (the call counts toward the same-args tally but if results vary,
// that's not what this detector is for — that's the cron/status-check
// case and is fine in moderation).

import { createHash } from "node:crypto";
import type { ToolStatus } from "../tools/types.js";

export type LoopSeverity = "warn" | "abort";

export interface LoopDetection {
  severity: LoopSeverity;
  // Machine-readable label for telemetry / structured error events:
  // "args_repeated_3x", "args_repeated_5x", "ping_pong",
  // "failing_tool_3x", "failing_tool_6x", "no_progress".
  reason: string;
  // Human/model-readable feedback. Appended to the offending tool's
  // result string so the model sees it next iteration (on soft warn)
  // and the user sees it in the transcript (on hard abort).
  message: string;
}

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash: string;
  // True when the tool's classified status was "failed" (ran-but-errored or
  // threw). Drives detectFailingTool independent of argsHash.
  failed: boolean;
  iter: number;
}

const WINDOW_SIZE = 30;

// Thresholds tuned to be generous to legitimate fan-out:
//   - 3+ same args → soft warn (might be a slip; model can recover)
//   - 5+ same args → hard abort (clearly stuck)
//   - 4+ ping-pong alternations → soft warn (model is "checking" but
//     never breaking out of the cycle)
const WARN_REPEAT_THRESHOLD = 3;
const ABORT_REPEAT_THRESHOLD = 5;
const PING_PONG_WINDOW = 8;
// 6 = three full A/B cycles. At 4 (two cycles), one iteration of two
// legitimate parallel reads repeated once — e.g. re-checking a pair of files
// after an edit — already warned. Three cycles is unambiguous.
const PING_PONG_MIN = 6;

// Failing-tool thresholds: a tool that keeps erroring (any args) warns at 3
// and aborts at 6 — deliberately looser than the identical-args abort (5) so
// a healthy retry-with-correction (fail, fix, succeed) isn't punished.
const WARN_FAILING_THRESHOLD = 3;
const ABORT_FAILING_THRESHOLD = 6;
// No-progress: a read-only query lens returning the same result this many
// times is fruitless. Warn only — never aborts (the model may legitimately
// re-query once before changing strategy).
const NO_PROGRESS_THRESHOLD = 2;
// Non-cached read-only query lenses. read_file/glob/grep are intentionally
// excluded — the turn-cache rewrites their identical repeats to a distinct
// [CACHED RESULT] stub, so they never present a repeated resultHash here.
const READ_ONLY_QUERY_TOOLS = new Set<string>(["recall", "recall_source"]);

export class LoopDetector {
  private history: ToolCallRecord[] = [];

  // Record a completed tool call and return a detection if a loop
  // pattern is found, else null. Sync — safe to call from inside a
  // Promise.all map body without race concerns (JS single-threaded
  // sync section between awaits). The agent loop calls this once per
  // tool result, after truncation so the resultHash matches what the
  // model will actually see.
  record(toolName: string, args: unknown, result: unknown, iter: number, status?: ToolStatus): LoopDetection | null {
    const argsHash = stableHash(args);
    const resultHash = stableHash(result);
    this.history.push({ toolName, argsHash, resultHash, failed: status === "failed", iter });
    if (this.history.length > WINDOW_SIZE) this.history.shift();

    // Order: failing-tool first (catches thrash-with-varied-args that the
    // identical-args rule misses), then args-repeat, then no-progress, then
    // ping-pong. First match wins.
    return (
      this.detectFailingTool(toolName) ??
      this.detectArgsRepeat(toolName, argsHash) ??
      this.detectNoProgress(toolName, resultHash) ??
      this.detectPingPong()
    );
  }

  private detectArgsRepeat(toolName: string, argsHash: string): LoopDetection | null {
    let count = 0;
    for (const r of this.history) {
      if (r.toolName === toolName && r.argsHash === argsHash) count++;
    }

    if (count >= ABORT_REPEAT_THRESHOLD) {
      return {
        severity: "abort",
        reason: "args_repeated_5x",
        message:
          `[LOOP DETECTED] You've called \`${toolName}\` with identical arguments ${count} times in this turn — ` +
          `each call returned the same result. Stopping the turn. If you retry, try a fundamentally different approach: ` +
          `different args, a different tool, or explain the blocker to the user instead of looping.`,
      };
    }

    if (count >= WARN_REPEAT_THRESHOLD) {
      return {
        severity: "warn",
        reason: "args_repeated_3x",
        message:
          `[LOOP DETECTOR] You've called \`${toolName}\` with these exact arguments ${count} times now ` +
          `and gotten the same result each time. Trying again won't help. ` +
          `Change your args, switch tools, or stop and explain what's blocking you.`,
      };
    }

    return null;
  }

  // Same tool failing in an UNBROKEN streak — 3 warns, 6 aborts. Args-agnostic
  // (catches thrash that varies the call each time), but counted as a streak
  // SINCE THE TOOL'S LAST SUCCESS so a healthy fail→fix→succeed loop resets to
  // zero and never accrues toward the abort.
  //
  // bash is excluded entirely: a non-zero exit is benign control-flow (grep
  // no-match, `git diff --exit-code`, a failing test during a debug loop), not
  // a stuck tool — and counting those args-agnostically would silently kill
  // legitimate multi-probe / iterative turns. Genuine bash thrash (the SAME
  // failing command over and over) is still caught by detectArgsRepeat.
  private detectFailingTool(toolName: string): LoopDetection | null {
    if (toolName === "bash") return null;
    let streak = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const r = this.history[i];
      if (r.toolName !== toolName) continue; // other tools don't break the streak
      if (!r.failed) break; // a success resets it
      streak++;
    }
    if (streak >= ABORT_FAILING_THRESHOLD) {
      return { severity: "abort", reason: "failing_tool_6x", message: failingMessage(toolName, streak, true) };
    }
    if (streak >= WARN_FAILING_THRESHOLD) {
      return { severity: "warn", reason: "failing_tool_3x", message: failingMessage(toolName, streak, false) };
    }
    return null;
  }

  // A read-only query lens returning the byte-identical result 2+ times —
  // the model rephrases the query (args differ) but learns nothing new.
  // Keyed on (toolName, resultHash), NOT args. Warn only.
  private detectNoProgress(toolName: string, resultHash: string): LoopDetection | null {
    if (!READ_ONLY_QUERY_TOOLS.has(toolName)) return null;
    let count = 0;
    for (const r of this.history) {
      if (r.toolName === toolName && r.resultHash === resultHash) count++;
    }
    if (count >= NO_PROGRESS_THRESHOLD) {
      return { severity: "warn", reason: "no_progress", message: noProgressMessage(toolName, count) };
    }
    return null;
  }

  private detectPingPong(): LoopDetection | null {
    if (this.history.length < PING_PONG_MIN) return null;

    const recent = this.history.slice(-PING_PONG_WINDOW);
    const fingerprints = recent.map((r) => `${r.toolName}:${r.argsHash}`);
    const unique = new Set(fingerprints);

    // Two-fingerprint alternation pattern: [A, B, A, B, ...] with no
    // two adjacent entries equal. Anything else (more fingerprints,
    // any repeated adjacency) is not ping-pong.
    if (unique.size !== 2) return null;
    for (let i = 1; i < fingerprints.length; i++) {
      if (fingerprints[i] === fingerprints[i - 1]) return null;
    }

    return {
      severity: "warn",
      reason: "ping_pong",
      message:
        `[LOOP DETECTOR] You're alternating between exactly two tool calls with no third action breaking the cycle. ` +
        `If you're reading-then-editing without convergence, step back: re-read the goal, consider if the file or query ` +
        `is even the right target, or summarize the blocker to the user.`,
    };
  }
}

// Tool-specific, actionable recovery hint appended to a detection message —
// generic templates make models repeat the same dead end, a concrete next
// action ("try an absolute path") helps them break out.
function toolHint(toolName: string): string {
  if (toolName === "bash") return "Try `ls`/`pwd` to orient, or pass an absolute path.";
  if (toolName === "recall" || toolName === "recall_source" || toolName.startsWith("englyph_")) {
    return "Broaden the query, drop filters, or try `recall_source` for raw transcript matches.";
  }
  if (toolName === "web_fetch" || toolName === "attach_url_file") {
    return "Check the URL — the host may be blocking automated fetches.";
  }
  return "Change the arguments, switch tools, or stop and explain the blocker to the user.";
}

function failingMessage(toolName: string, count: number, abort: boolean): string {
  const prefix = abort ? "[LOOP DETECTED]" : "[LOOP DETECTOR]";
  const tail = abort
    ? "Stopping the turn. Try a fundamentally different approach if you retry."
    : "Repeating the same approach won't help.";
  return `${prefix} \`${toolName}\` has failed ${count} times this turn (regardless of arguments). ${tail} ${toolHint(toolName)}`;
}

function noProgressMessage(toolName: string, count: number): string {
  return (
    `[LOOP DETECTOR] \`${toolName}\` returned the same result ${count} times this turn — ` +
    `rephrasing the query isn't surfacing anything new. ${toolHint(toolName)}`
  );
}

// Stable JSON serialization with sorted keys. Required for reproducible
// hashing — JSON.stringify's default key order matches insertion order,
// so two semantically-identical objects with different construction
// paths would hash differently and the detector would miss real loops.
// Handles null/undefined/primitives/arrays/objects; bigint and symbols
// fall back to JSON.stringify (which may throw — caller is responsible
// for not feeding unstringifiable values, but realistically tool args
// and results are always plain JSON shapes).
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  const t = typeof obj;
  if (t === "string" || t === "number" || t === "boolean") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  if (t === "object") {
    const o = obj as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
  }
  // bigint / function / symbol — best-effort fallback
  try {
    return JSON.stringify(obj);
  } catch {
    return `"<unstringifiable:${t}>"`;
  }
}

// 16-hex-char prefix is enough for collision safety within a single
// 30-entry window. Full sha256 is wasteful for the in-memory comparison
// use case here.
export function stableHash(obj: unknown): string {
  return createHash("sha256").update(stableStringify(obj)).digest("hex").slice(0, 16);
}
