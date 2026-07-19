// Per-turn idempotent-read cache.
//
// Models routinely re-read the same file or re-glob the same pattern
// across iterations of a single turn. Without dedup, each re-read
// lands a fresh copy of the content in the transcript and gets shipped
// to the provider on every subsequent iteration — a 5KB file read
// three times costs ~3KB of redundant prompt tokens every iteration
// for the rest of the turn.
//
// This cache short-circuits the 2nd+ call to a cacheable tool with
// identical args by returning a small stub instead of the full result.
// The model's prior iteration already has the original content in its
// context, so the stub just points back to that iter — preserving the
// information while collapsing the transcript footprint.
//
// Scope: per-runAgentLoop-invocation. State resets on every new user
// turn (each turn constructs its own cache). Sub-agents get their own
// pools, no cross-loop sharing.
//
// Invalidation: when a write tool (write_file, edit_file) modifies a
// path, future cache lookups that overlap that path miss and run
// fresh. Conservatively: any write clears glob/grep cache entries
// entirely (those cross the whole tree); read_file and list_directory
// invalidate on path-prefix overlap.
//
// What does NOT go through the cache: tools with side effects (bash,
// web_fetch, attach_*, spawn_agent), englyph and MCP tools (state can
// evolve in the daemon), and the write tools themselves. See
// CACHEABLE_TOOLS for the exhaustive allowlist.

import { createHash } from "node:crypto";

// Tools whose results are idempotent within a single user turn —
// repeated calls with the same args return the same content unless a
// write tool has touched the underlying state. Stay conservative —
// adding a tool here without confirming idempotence risks the model
// getting stale info.
export const CACHEABLE_TOOLS = new Set<string>([
  "read_file",
  "list_directory",
  "glob_files",
  "grep_files",
]);

// Tools that mutate the filesystem. After one fires, the cache
// invalidates entries that could be affected so subsequent reads
// return fresh content. Listed explicitly rather than detected via
// "isError + path arg" because we'd rather miss invalidation for an
// exotic side-effect tool than have a silent staleness bug.
export const WRITE_TOOLS = new Set<string>([
  "write_file",
  "edit_file",
]);

interface CacheEntry {
  result: string;
  iter: number;
  hash: string;
  resultLength: number;
}

export class TurnReadCache {
  private entries = new Map<string, CacheEntry>();
  // Paths that have been written/edited in this turn. Each entry is
  // the raw `path` arg as the model supplied it (after toString) so
  // path-prefix overlap checks operate on the same surface the model
  // sees. Lower-cased for case-insensitive Windows matching.
  private writtenPaths: string[] = [];

  private key(tool: string, args: Record<string, unknown>): string {
    return `${tool}|${stableStringify(args)}`;
  }

  // Returns the cache entry if a hit, else null. Non-cacheable tools
  // always miss. Path invalidation logic varies by tool:
  //   - read_file:       miss if any write overlapped the requested path
  //   - list_directory:  miss if any write landed under the listed dir
  //   - glob_files:      miss if ANY write happened (cross-tree pattern)
  //   - grep_files:      miss if ANY write happened (cross-tree pattern)
  lookup(tool: string, args: Record<string, unknown>): CacheEntry | null {
    if (!CACHEABLE_TOOLS.has(tool)) return null;

    if (tool === "glob_files" || tool === "grep_files") {
      if (this.writtenPaths.length > 0) return null;
    } else if (tool === "read_file" || tool === "list_directory") {
      const path = typeof args.path === "string" ? args.path : "";
      if (path && this.writtenPaths.some((w) => pathOverlaps(w, path))) {
        return null;
      }
    }

    return this.entries.get(this.key(tool, args)) ?? null;
  }

  // Store a successful tool result for future hits. Non-cacheable
  // tools and error results are filtered out at call sites — this
  // method assumes the caller has already gated.
  store(tool: string, args: Record<string, unknown>, result: string, iter: number): void {
    if (!CACHEABLE_TOOLS.has(tool)) return;
    const hash = createHash("sha256").update(result).digest("hex").slice(0, 12);
    this.entries.set(this.key(tool, args), {
      result,
      iter,
      hash,
      resultLength: result.length,
    });
  }

  // Record that a write happened so future reads invalidate. Called
  // for any tool in WRITE_TOOLS that completed without error.
  noteWrite(args: Record<string, unknown>): void {
    const path = typeof args.path === "string" ? args.path : "";
    if (path) this.writtenPaths.push(path);
  }

  // Drop every cached read. For mutations the path-overlap heuristic can't
  // see into — a successful `bash` call (sed -i, git checkout, scripts) can
  // touch anything, so every cached read is suspect afterward.
  clearAll(): void {
    this.entries.clear();
  }

  // Build the short stub returned on a cache hit. References the
  // original iter + hash so the model can locate the full content in
  // its context. Deliberately terse: the whole point of the cache is
  // to keep the transcript lean, so we don't reproduce the content
  // here. If the original content was compacted out of the model's
  // context, the model can re-call with `force_reread` — except we
  // don't have that param yet, so for now the workaround is to use a
  // different arg shape (different offset/limit, etc.). Roughly 200
  // chars regardless of original size.
  buildStubResult(tool: string, args: Record<string, unknown>, entry: CacheEntry): string {
    const pathHint = typeof args.path === "string" ? ` for \`${args.path}\`` : "";
    return [
      `[CACHED RESULT]`,
      `You already called \`${tool}\`${pathHint} with these exact arguments in iteration ${entry.iter} of this turn.`,
      `That call returned ${entry.resultLength.toLocaleString()} chars (hash: ${entry.hash}).`,
      `The full content is still in your context — refer back to the iter ${entry.iter} tool result.`,
      `(Edits through write_file/edit_file/bash invalidate this cache; if you changed the file some other way and need a fresh read, vary the arguments — e.g. pass an explicit offset/limit.)`,
    ].join("\n");
  }
}

// Path-prefix overlap check — handles Windows backslashes, trailing
// slashes, case. Returns true if `a` and `b` reference the same file
// or one is a subdirectory of the other. Used to decide whether a
// write at path `a` invalidates a read at path `b` (or vice versa).
function pathOverlaps(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

// Stable JSON serialization (sorted keys) so semantically-identical
// args produce the same cache key regardless of insertion order. Same
// pattern as loop-detector.ts — could share but duplication is cheap
// and keeps the modules independent.
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
  try {
    return JSON.stringify(obj);
  } catch {
    return `"<unstringifiable:${t}>"`;
  }
}
