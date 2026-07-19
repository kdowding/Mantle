// Per-loop concurrency control for parallel tool dispatch.
//
// The agent loop runs all tool calls from a single assistant turn in
// parallel (`Promise.all` in loop.ts) so wall-clock = max(tools) instead
// of sum. That's a real win for read/grep batches, but unbounded
// parallelism is also a footgun — a model that emits 20 bash calls in
// one turn would spawn 20 child processes simultaneously and starve the
// host. This module gates dispatch by tool *category* so the parallel
// model survives pathological inputs.
//
// The semaphores are per-runAgentLoop-invocation. A sub-agent and its
// parent each get their own pools — independent caps, no cross-loop
// contention. Module-level state would be wrong: cron ticks and
// chat turns running on different agents should not throttle each other.

export type ToolCategory =
  | "bash"        // shell — spawns child processes, hits FS
  | "filesystem"  // local FS — cheap but I/O-bound on big repos
  | "web"         // outbound HTTP — rate-limited by remote
  | "mcp"         // bridged MCP tools (englyph etc.) — daemon-bound
  | "subagent"    // spawn_agent and friends — each fires a nested loop
  | "default";    // anything we haven't classified

// Default per-category concurrency caps. These are the active limits
// when the caller doesn't override via `createSemaphoreMap({...})`.
// Tuned for a single developer workstation:
//   bash:4       — Windows process creation is heavy; 4 keeps the box usable
//   filesystem:8 — reads are fast and parallel-friendly even on Windows
//   web:4        — most public APIs rate-limit at ~10 rps; 4 stays well under
//   mcp:2        — englyph daemon serializes embeds; little gain past 2
//   subagent:4   — bounded with the per-parent child cap from the spawner
//   default:6    — generous fallback for unclassified tools (custom MCP, etc.)
export const DEFAULT_CONCURRENCY: Record<ToolCategory, number> = {
  bash: 4,
  filesystem: 8,
  web: 4,
  mcp: 2,
  subagent: 4,
  default: 6,
};

// Per-category HARD timeout (ms) for a single tool call. The agent loop
// races each tool against this so a signal-deaf or wedged tool (a hung MCP
// server, a stalled web_fetch, a custom tool that ignores AbortSignal)
// can't freeze the whole turn. This closes the gap the Semaphore comment
// below names: the idle watchdog only wraps provider.stream(), so tool
// execution had no cancellation surface at all. Tuned to the category cost
// profile so a cheap read isn't given a heavy build's budget. 0 = no
// per-call timeout — nested loops (subagents) bound themselves via their
// own iteration cap + idle watchdog, and the parent's turn ceiling still
// applies.
export const CATEGORY_TIMEOUTS: Record<ToolCategory, number> = {
  bash: 120_000,
  filesystem: 30_000,
  web: 60_000,
  mcp: 60_000,
  subagent: 0,
  default: 60_000,
};

// Hard timeout (ms) for a single call to the named tool, 0 = no timeout.
export function toolTimeoutMs(name: string): number {
  return CATEGORY_TIMEOUTS[classifyTool(name)];
}

// Maps a tool name to a category. Pure string match — no Tool metadata
// passed through the loop because that would require threading a registry
// reference (or a parallel metadata map) for every runAgentLoop caller.
// Heuristic for unknown names: MCP servers ship tools with vendor-prefixed
// names (englyph_*, brave_*, etc.) so a small prefix list catches the
// common cases; everything else falls to "default" with a generous cap.
export function classifyTool(name: string): ToolCategory {
  if (name === "bash") return "bash";
  if (
    name === "read_file" ||
    name === "write_file" ||
    name === "edit_file" ||
    name === "list_directory" ||
    name === "glob_files" ||
    name === "grep_files" ||
    name === "attach_local_file"
  ) {
    return "filesystem";
  }
  if (name === "web_fetch" || name === "attach_url_file") return "web";
  if (
    name.startsWith("englyph_") ||
    name.startsWith("mcp_") ||
    name.startsWith("brave_") ||
    name.startsWith("playwright_") ||
    // The memory-lens wrappers delegate to englyph_* under the hood — same
    // single-daemon backend, same cap. As "default" (cap 6) a parallel
    // recall burst just queued inside the serialized daemon anyway.
    name === "recall" ||
    name === "recall_history" ||
    name === "recall_area" ||
    name === "recall_source" ||
    name === "expand_memory" ||
    name === "memory_status" ||
    name === "remember"
  ) {
    return "mcp";
  }
  if (name === "spawn_agent") return "subagent";
  return "default";
}

// Tiny FIFO semaphore. Independent of any timer or event loop quirks —
// strict FIFO ensures fairness so a slow tool doesn't perpetually lose
// to faster ones. The acquire() promise resolves with a release function
// the caller invokes (typically in a try/finally). No timeout handling
// here — the agent loop's idle watchdog + tool-level signals are the
// cancellation surface.
class Semaphore {
  private available: number;
  private waiters: Array<() => void> = [];

  constructor(public readonly max: number) {
    this.available = max;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.available--;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export interface SemaphoreMap {
  acquire(category: ToolCategory): Promise<() => void>;
}

// Build a SemaphoreMap for one runAgentLoop invocation. Caller can
// override per-category limits (e.g., a cron task that wants tighter
// concurrency, or a future config knob). Unset categories use the
// DEFAULT_CONCURRENCY value.
export function createSemaphoreMap(overrides?: Partial<Record<ToolCategory, number>>): SemaphoreMap {
  const semaphores = new Map<ToolCategory, Semaphore>();
  const caps: Record<ToolCategory, number> = { ...DEFAULT_CONCURRENCY, ...overrides };
  for (const cat of Object.keys(caps) as ToolCategory[]) {
    semaphores.set(cat, new Semaphore(caps[cat]));
  }
  return {
    async acquire(category: ToolCategory) {
      const sem = semaphores.get(category) ?? semaphores.get("default")!;
      return sem.acquire();
    },
  };
}
