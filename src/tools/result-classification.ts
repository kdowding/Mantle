// Pure classifier that upgrades the legacy isError boolean into a richer
// {status, tag}: "ok" succeeded, "failed" ran-but-errored, "empty" succeeded
// but produced nothing useful. The tag is a short (≤~12 char) human label for
// the UI chip ("exit 1", "written", "empty", "not found", "quota", "timeout").
//
// Called by ToolRegistry.execute with the tool name + the assembled
// ToolResult, so it can key on per-tool result-string conventions. Pure: no
// I/O, no async, no SDK imports — only the ToolResult/ToolStatus types.
//
// INVARIANT (load-bearing for the loop-detector's failing-tool signal): any
// result with isError === true classifies as "failed". status is a superset of
// isError and never disagrees with it. Rules are first-match-wins, ordered so
// positive write-proof beats a generic "Error" sniff (a file whose path or
// body contains the word "Error" must not be misread as a failure).

import type { ToolResult, ToolStatus } from "./types.js";

export interface ToolClassification {
  status: ToolStatus;
  tag?: string;
}

const GENERIC_ERROR_RE = /^(Error|Invalid|Unknown tool|Tool error|File not found|Directory not found|old_string)/i;
const NO_RESULTS_RE = /^No (results|files|matches|matching)/i;
const ZERO_RESULTS_RE = /\b0 (results|matches|files)\b/i;

export function classifyToolResult(toolName: string, result: ToolResult): ToolClassification {
  const content = typeof result.content === "string" ? result.content : "";
  const trimmed = content.trim();
  let out: ToolClassification;

  // (1) bash — keyed on the tool's own exit-code framing (bash.ts).
  if (toolName === "bash") {
    out = classifyBash(trimmed, result.isError === true);
  }
  // (2) positive proof of a successful write — must run before the generic
  // error sniff so a path/body containing "Error" isn't misread.
  else if (toolName === "write_file" && /^Written \d+/.test(trimmed)) {
    out = { status: "ok", tag: "written" };
  } else if (toolName === "edit_file" && /^Edited .*replac/i.test(trimmed)) {
    out = { status: "ok", tag: "edited" };
  }
  // (3) memory/englyph structured failure — many results are JSON strings
  // through the MCP bridge.
  else if (isStructuredFailure(trimmed)) {
    out = { status: "failed", tag: /quota|rate limit/i.test(trimmed) ? "quota" : "failed" };
  }
  // (4) empty — succeeded but produced nothing useful.
  else if (result.isError !== true && isEmptyResult(trimmed)) {
    out = { status: "empty", tag: "empty" };
  }
  // (5) generic error. The text-sniff (when isError is false) is restricted to
  // non-bridged tools — an englyph/MCP result whose content legitimately begins
  // with "Error"/"Invalid" (e.g. a recalled memory ABOUT an error) must not be
  // mislabeled failed; those tools signal failure via isError / {success:false}.
  else if (result.isError === true || (GENERIC_ERROR_RE.test(trimmed) && !isBridgedTool(toolName))) {
    out = { status: "failed", tag: genericErrorTag(trimmed) };
  }
  // (6) default.
  else {
    out = { status: "ok" };
  }

  // Hard invariant: a legacy error is always "failed", whatever the ladder said.
  if (result.isError === true && out.status !== "failed") {
    out = { status: "failed", tag: out.tag ?? "failed" };
  }
  return out;
}

function classifyBash(trimmed: string, isError: boolean): ToolClassification {
  if (trimmed.startsWith("(no output, exit code: 0)")) {
    return { status: "empty", tag: "no output" };
  }
  if (trimmed.startsWith("Command timed out") || trimmed.startsWith("Aborted")) {
    return { status: "failed", tag: "timeout" };
  }
  const exitPrefix = trimmed.match(/^Exit code: (\d+)/);
  if (exitPrefix && exitPrefix[1] !== "0") {
    return { status: "failed", tag: `exit ${exitPrefix[1]}` };
  }
  const noOut = trimmed.match(/^\(no output, exit code: (\d+)\)/);
  if (noOut && noOut[1] !== "0") {
    return { status: "failed", tag: `exit ${noOut[1]}` };
  }
  // exit 0 with output, or any other shape — error wins if the flag is set.
  return isError ? { status: "failed", tag: "failed" } : { status: "ok" };
}

function isEmptyResult(trimmed: string): boolean {
  return (
    trimmed === "" ||
    trimmed === "(no output)" ||
    NO_RESULTS_RE.test(trimmed) ||
    // Length-guarded: an incidental "0 matches" buried in a large successful
    // payload shouldn't flip the whole result to "empty".
    (trimmed.length < 200 && ZERO_RESULTS_RE.test(trimmed))
  );
}

// englyph_* / mcp_ / brave_ / playwright_ — bridged tools whose result content
// is arbitrary text we shouldn't text-sniff for error prefixes.
function isBridgedTool(name: string): boolean {
  return (
    name.startsWith("englyph_") ||
    name.startsWith("mcp_") ||
    name.startsWith("brave_") ||
    name.startsWith("playwright_") ||
    // The core memory tools are thin wrappers over englyph_* — their result
    // text is recalled memory content, which can legitimately begin with
    // "Error…" (a memory ABOUT an error). Without the exemption, six such
    // recalls in a row tripped the failing_tool_6x hard abort.
    name === "recall" ||
    name === "recall_source" ||
    name === "remember" ||
    name === "memory_status"
  );
}

function isStructuredFailure(trimmed: string): boolean {
  if (!trimmed.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return !!parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).success === false;
  } catch {
    return false;
  }
}

function genericErrorTag(trimmed: string): string {
  if (/^Invalid|old_string/i.test(trimmed)) return "invalid args";
  if (/^(File|Directory) not found/i.test(trimmed)) return "not found";
  return "failed";
}
