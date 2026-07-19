import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync, rmSync, statSync, copyFileSync, readdirSync, unlinkSync } from "fs";
import { resolve, dirname, basename } from "path";
import type { MessageContent, TokenUsage, StopReason, ProviderMessage } from "./providers/types.js";

export interface SessionMessage {
  id: string;
  timestamp: string;
  role: "user" | "assistant" | "system";
  content: MessageContent[];
  // How a user-role message entered the transcript. Absent = the user typed
  // it (the overwhelmingly common case; old rows predate the field).
  //   "note" — a steer-while-busy note delivered MID-turn via the turn
  //   mailbox.
  //   "system-delivery" — a synthetic delivery ([BACKGROUND TASK …] /
  //   [SUBAGENT_COMPLETE …]) appended by the outbox.
  // Both render user-role to providers, but retry/edit anchoring skips
  // them: /retry must re-run the user's real ask, not harness plumbing.
  // The UI can also render them distinctly.
  origin?: "note" | "system-delivery";
  model?: string;
  provider?: string;
  usage?: TokenUsage;
  stopReason?: StopReason;
  // Deck-assist only: the systems artifact open when this user turn was sent
  // (kind + label), surfaced as a per-message context chip in the dock so the
  // user can see what each turn carried to the agent. Set by handleAssist.
  assistContext?: { kind: string; label: string; create?: boolean };
}

// Walk a transcript backwards and return the text of the most recent
// assistant message that has any text content (joined across its text
// blocks). Skips assistant messages that ended on tool_use only, and
// returns "" when there's no assistant text at all. Used by sub-agent
// result delivery as a transcript-level fallback when the loop's
// TurnOutcome.lastAssistantText is empty (cron reads the outcome
// directly and no longer calls this).
export function extractLastAssistantText(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const parts: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push(b.text);
    }
    if (parts.length > 0) return parts.join("");
  }
  return "";
}

// Unknown extra keys in older index.json files remain inert JSON properties;
// parsing preserves them, while current code never reads them.
export interface SessionMeta {
  id: string;
  createdAt: string;
  lastMessageAt: string;
  title: string;
  provider: string;
  model: string;
  messageCount: number;
  persona?: string;
  lastMessagePersona?: string;
  isCron?: boolean;
  // A cron job's REPORT THREAD (`cron-thread-<jobId8>`) — the one per-job
  // session every run files its report into, surfaced in the cron deck and
  // continuable like any chat (the next run reads the user's replies as
  // steering). Holds the owning job's full id; isCron is set alongside so
  // the chat sidebar and delivery-target resolution both exclude it.
  cronThreadFor?: string;
  // The systems-deck assist companion's continuous conversation — one hidden
  // session per agent (id "assist"). Flagged so the chat sidebar filters it
  // out; the dock loads it via GET /api/agents/:id/assist/session. Set at
  // creation via createSessionMeta and preserved by updateIndex thereafter.
  isAssist?: boolean;
  // User-curated sidebar state (PATCH /api/agents/:id/sessions/:sid).
  // `titleEdited` guards a hand-renamed title against the first-message
  // auto-derive (which otherwise overwrites a rename on empty sessions).
  pinned?: boolean;
  titleEdited?: boolean;
  // ── Call mode (xAI Realtime voice) ───────────────────────────────────
  // Locked at session creation. When true the session is a realtime
  // voice call routed through wss://api.x.ai/v1/realtime. No agentic
  // loop runs; turns come from the duplex audio bridge. Transcripts
  // (user + assistant) are still persisted as SessionMessage rows so
  // the session can be reviewed afterward like any other.
  // `callVoice` records which xAI voice was used (eve/ara/rex/sal/leo
  // or a custom voice id) for display in the session list.
  // `callDurationMs` is filled in on call end so the sidebar can show
  // call length without parsing the transcript timestamps.
  isCall?: boolean;
  callVoice?: string;
  callDurationMs?: number;
  // ── Sub-agent mode (spawn_agent) ─────────────────────────────────────
  // Locked at session creation. When true this session was spawned by
  // a parent agent loop via spawn_agent, not started by a user. The UI
  // groups child sessions under their parent in the sidebar.
  //   parentSessionId  — which session spawned this one
  //   subagentDepth    — 0 for a normal session, 1 for a child of a
  //                      normal session, 2 for grandchild. Hard-capped
  //                      at 2 (depth 2 cannot spawn) — see
  //                      subagent-manager.ts MAX_SUBAGENT_DEPTH.
  //   subagentTask     — short summary of the task the child was given,
  //                      shown in the sidebar so the parent can see at
  //                      a glance what their children are working on.
  //   subagentTaskId   — id of the spawn task in SubagentManager.tasks;
  //                      links the session to its delivery state.
  isSubagent?: boolean;
  parentSessionId?: string;
  subagentDepth?: number;
  subagentTask?: string;
  subagentTaskId?: string;
}

export interface SessionIndex {
  sessions: SessionMeta[];
}

// ── index.json persistence (shared + atomic) ────────────────────────────────
//
// Every writer of an agent's index.json funnels through these helpers. Writes
// go to a sibling .tmp then rename over the target (mirrors the users.json fix
// in f56b136). A plain writeFileSync truncates-then-writes, so a crash or kill
// mid-write leaves a torn file on disk; the read paths fall back to an empty
// index on a parse error, and the next append would then persist that blank —
// silently wiping the whole session sidebar (JSONL transcripts survive but
// orphaned). rename is atomic, so a reader sees either the old index or the new
// one, never a half. The read-modify-write in mutateSessionIndex runs in a
// single tick — JS is single-threaded, so no other writer interleaves between
// the read and the rename.

// Thrown when the index file exists but stays unreadable after retries
// (Windows AV/indexer sharing violations). Writers catch it and SKIP the
// write — the old blanket `catch { return { sessions: [] } }` here is the
// bug that wiped the sidebar twice: a transient read error became an empty
// index, and the next writer persisted the blank durably.
export class SessionIndexUnavailableError extends Error {
  constructor(indexPath: string, cause: unknown) {
    super(
      `index.json unreadable after retries (${indexPath}): ${cause instanceof Error ? cause.message : cause}`,
    );
    this.name = "SessionIndexUnavailableError";
  }
}

// Paths whose corrupt index has already been preserved this process — a
// corrupt file is copied aside once, not on every read until a writer
// heals it.
const corruptPreserved = new Set<string>();

// Rebuild a minimal index from the *.jsonl transcripts next to a corrupt
// index.json. Per-session meta (call flags, pins) is lost — the
// preserved .corrupt copy keeps it recoverable — but the sessions reappear
// in the sidebar and the next write persists the healed file.
function rebuildIndexFromTranscripts(indexPath: string): SessionIndex {
  const sessions: SessionMeta[] = [];
  try {
    const dir = dirname(indexPath);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue;
      const full = resolve(dir, file);
      try {
        const stat = statSync(full);
        let messageCount = 0;
        // Bounded line count — recovery only; a huge transcript just gets 0.
        if (stat.size < 10 * 1024 * 1024) {
          const raw = readFileSync(full, "utf-8");
          for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) messageCount++;
        }
        sessions.push({
          id: file.slice(0, -".jsonl".length),
          createdAt: (stat.birthtime ?? stat.mtime).toISOString(),
          lastMessageAt: stat.mtime.toISOString(),
          title: "Recovered session",
          provider: "unknown",
          model: "unknown",
          messageCount,
        });
      } catch {
        // Skip transcripts we can't stat/read — better a partial rebuild.
      }
    }
    sessions.sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  } catch {
    // Directory unreadable — empty rebuild; writers will still heal later.
  }
  return { sessions };
}

/**
 * Read an index.json with failure modes that never silently wipe state:
 *   - missing file → empty index (the only case that legitimately is empty)
 *   - transient read error → up to 3 attempts (Windows AV/indexer holds);
 *     still failing → `forWrite` callers get SessionIndexUnavailableError
 *     (write skipped, file intact), read-only callers get a logged empty
 *     view (UI degrades for one poll; nothing persists it)
 *   - parse/shape failure (torn or hand-mangled JSON) → preserve a
 *     `.corrupt-<ts>` copy once, rebuild a minimal index from the *.jsonl
 *     transcripts; the next successful write persists the healed file
 */
function readIndexAt(indexPath: string, opts?: { forWrite?: boolean }): SessionIndex {
  if (!existsSync(indexPath)) return { sessions: [] };

  let raw: string | null = null;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = readFileSync(indexPath, "utf-8");
      break;
    } catch (err) {
      lastErr = err;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { sessions: [] };
      Bun.sleepSync(15);
    }
  }
  if (raw === null) {
    if (opts?.forWrite) throw new SessionIndexUnavailableError(indexPath, lastErr);
    console.warn(
      `[MANTLE:session] index read failed (${indexPath}): ${lastErr instanceof Error ? lastErr.message : lastErr} — serving empty view, NOT persisting`,
    );
    return { sessions: [] };
  }

  try {
    const index = JSON.parse(raw) as SessionIndex;
    if (!Array.isArray(index?.sessions)) throw new Error("index.json has no sessions array");
    return index;
  } catch (err) {
    if (!corruptPreserved.has(indexPath)) {
      corruptPreserved.add(indexPath);
      const backup = `${indexPath}.corrupt-${Date.now()}`;
      try {
        copyFileSync(indexPath, backup);
        console.error(
          `[MANTLE:session] index.json corrupt (${err instanceof Error ? err.message : err}) — preserved ${basename(backup)}, rebuilding from transcripts`,
        );
      } catch {
        console.error(`[MANTLE:session] index.json corrupt and backup copy failed — rebuilding from transcripts`);
      }
    }
    return rebuildIndexFromTranscripts(indexPath);
  }
}

function writeIndexAtomic(indexPath: string, index: SessionIndex): void {
  const tmp = `${indexPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), "utf-8");
  // Windows: a momentary AV/indexer hold on the target surfaces as
  // EPERM/EBUSY/EACCES from rename. Brief retry beats failing the write.
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, indexPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt < 2 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
        Bun.sleepSync(15);
        continue;
      }
      throw err;
    }
  }
}

// ── Process-global index writer chain ───────────────────────────────────────
// One serialized write queue PER index path, shared across every
// SessionManager instance (chat + cron sessions of the same agent used
// to hold separate per-instance queues). Every RMW body in this module is
// single-tick (no awaits between read and rename) so writes can't interleave
// — this chain makes the queue + flush ordering structural rather than
// emergent: flushIndexWrites() observes ALL pending writes for the path, not
// just one instance's. KEEP RMW BODIES SINGLE-TICK; an await inside one
// re-opens the interleave window the atomic helpers exist to close.
const indexWriteChains = new Map<string, Promise<void>>();

function enqueueIndexWrite(indexPath: string, task: () => void | Promise<void>): void {
  const prev = indexWriteChains.get(indexPath) ?? Promise.resolve();
  const next = prev.then(async () => {
    await task();
  }).catch((err) => {
    console.warn(
      `[MANTLE:session] queued index update failed (${indexPath}): ${err instanceof Error ? err.message : err}`,
    );
  });
  indexWriteChains.set(indexPath, next);
  void next.finally(() => {
    if (indexWriteChains.get(indexPath) === next) indexWriteChains.delete(indexPath);
  });
}

async function flushIndexWrites(indexPath: string): Promise<void> {
  // New writes queued while awaiting extend the chain — loop until stable.
  for (;;) {
    const tail = indexWriteChains.get(indexPath);
    if (!tail) return;
    await tail;
    if (indexWriteChains.get(indexPath) === tail) return;
  }
}

/**
 * Read an agent's index.json, apply `mutate`, write it back atomically.
 * `sessionsDir` is the per-agent sessions dir (…/sessions/<agentId>). When
 * `mutate` returns `false` the write is skipped, so conditional callers (only
 * register if absent, only bump if found) don't rewrite identical content.
 * Use this from every out-of-class writer instead of a hand-rolled
 * loadIndex → mutate → writeFileSync. The body MUST stay synchronous (no
 * awaits) — see the writer-chain invariant above. Throws
 * SessionIndexUnavailableError when the index can't be read for writing
 * (the write is skipped; on-disk state stays intact).
 */
export function mutateSessionIndex(
  sessionsDir: string,
  mutate: (index: SessionIndex) => void | boolean,
): void {
  mutateIndexAtPath(resolve(sessionsDir, "index.json"), mutate);
}

// Read-only snapshot of an agent's session index (same fail-closed reader the
// mutators use). For callers that pick a session without writing — e.g. cron
// delivery resolving "the user's most recent real chat session".
export function readSessionIndex(sessionsDir: string): SessionIndex {
  return readIndexAt(resolve(sessionsDir, "index.json"));
}

// Path-level twin of mutateSessionIndex, shared by the instance methods
// (which hold an indexPath, not a sessionsDir).
function mutateIndexAtPath(
  indexPath: string,
  mutate: (index: SessionIndex) => void | boolean,
): void {
  const index = readIndexAt(indexPath, { forWrite: true });
  if (mutate(index) === false) return;
  writeIndexAtomic(indexPath, index);
}

// Strip transcript states the Anthropic / OpenAI APIs reject:
//
//   1. Empty text blocks ({type: "text", text: ""}) — Anthropic
//      treats these as protocol errors on assistant messages.
//   2. Messages with no content blocks at all — degenerate states
//      that can result from (1) emptying everything out.
//   3. Unpaired tool_use / tool_result blocks. Every assistant
//      tool_use must be answered by a tool_result with the same id
//      in the immediately following user message, and every
//      tool_result must point back to a real tool_use. Mantle can
//      land in an unpaired state when /stop or a crash fires
//      between persisting the assistant message (with tool_use) and
//      persisting the user message (with tool_result) — the
//      assistant tool_use survives on disk but its partner never
//      arrived. On the next turn the provider would reject the
//      whole conversation; this drop heals it for the in-memory
//      view we send to the API while leaving the JSONL untouched.
//
// Pure (no instance state) so other transcript projections — notably the
// channel POV transform, which windows + reshapes rows itself — can reuse
// the exact same healing rules instead of duplicating them.
// `droppedSummary` is a human-readable account of what was dropped, or
// null when nothing was.
export function sanitizeProviderMessages(messages: ProviderMessage[]): {
  messages: ProviderMessage[];
  droppedSummary: string | null;
} {
  // First pass: scan adjacent assistant→user pairs and collect the
  // set of tool_use ids that have a matching tool_result. Anything
  // outside this set on either side is orphan and gets dropped.
  const validPairIds = new Set<string>();
  for (let i = 0; i < messages.length - 1; i++) {
    const cur = messages[i];
    const next = messages[i + 1];
    if (cur.role !== "assistant" || next.role !== "user") continue;

    const toolUseIds = new Set<string>();
    for (const b of cur.content) {
      if (b.type === "tool_use") {
        toolUseIds.add((b as { type: "tool_use"; id: string }).id);
      }
    }
    if (toolUseIds.size === 0) continue;

    for (const b of next.content) {
      if (b.type === "tool_result") {
        const id = (b as { type: "tool_result"; toolUseId: string }).toolUseId;
        if (toolUseIds.has(id)) validPairIds.add(id);
      }
    }
  }

  // Second pass: filter content blocks against validPairIds and the
  // empty-text rule, then drop messages that ended up empty.
  const result: ProviderMessage[] = [];
  let droppedEmptyText = 0;
  let droppedEmptyMessage = 0;
  let droppedOrphanToolUse = 0;
  let droppedOrphanToolResult = 0;

  for (const msg of messages) {
    const content = msg.content.filter((b) => {
      if (b.type === "text") {
        const ok = (b as { type: "text"; text: string }).text.trim().length > 0;
        if (!ok) droppedEmptyText++;
        return ok;
      }
      if (b.type === "tool_use") {
        const matched = validPairIds.has((b as { type: "tool_use"; id: string }).id);
        if (!matched) droppedOrphanToolUse++;
        return matched;
      }
      if (b.type === "tool_result") {
        const matched = validPairIds.has(
          (b as { type: "tool_result"; toolUseId: string }).toolUseId,
        );
        if (!matched) droppedOrphanToolResult++;
        return matched;
      }
      return true; // image / file / anything else passes through
    });

    if (content.length === 0) {
      droppedEmptyMessage++;
      continue;
    }

    result.push({ role: msg.role, content });
  }

  const total =
    droppedEmptyText + droppedEmptyMessage + droppedOrphanToolUse + droppedOrphanToolResult;
  let droppedSummary: string | null = null;
  if (total > 0) {
    const parts: string[] = [];
    if (droppedOrphanToolUse > 0) parts.push(`${droppedOrphanToolUse} orphan tool_use`);
    if (droppedOrphanToolResult > 0) parts.push(`${droppedOrphanToolResult} orphan tool_result`);
    if (droppedEmptyText > 0) parts.push(`${droppedEmptyText} empty text block(s)`);
    if (droppedEmptyMessage > 0) parts.push(`${droppedEmptyMessage} empty message(s)`);
    droppedSummary = parts.join(", ");
  }

  // Third pass: merge adjacent same-role messages into one. Mantle's own
  // transcripts legitimately produce these — a mid-turn note lands right
  // after a tool_result user message; an interrupted partial plus a graceful
  // landing are back-to-back assistant messages. Anthropic/OpenAI tolerate
  // consecutive same-role turns, but strict llama.cpp chat templates assert
  // alternation, so we normalize client-side for everyone. Ordering safety:
  // a tool_result that survived pass two is always directly preceded by its
  // assistant tool_use, so a merged user message can only ever be
  // [tool_results..., text...] — the order Anthropic requires.
  const mergedResult: ProviderMessage[] = [];
  for (const msg of result) {
    const prev = mergedResult[mergedResult.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...prev.content, ...msg.content];
    } else {
      mergedResult.push({ role: msg.role, content: msg.content });
    }
  }

  return { messages: mergedResult, droppedSummary };
}

export class SessionManager {
  readonly sessionId: string;
  private filePath: string;
  private indexPath: string;
  // In-memory copy of the JSONL transcript. Populated on first read,
  // kept coherent by appendMessage / replaceMessages. The agent loop
  // calls getTranscriptForProvider() every iteration (up to 25 per
  // turn) — without this cache that's a readFileSync + JSON.parse on
  // each, which is wasted work since within a single SessionManager
  // instance no other writer touches the file (agent-lock guarantees
  // exclusive access for the lifetime of a chat or cron run).
  // A new SessionManager is constructed per turn anyway, so external
  // mutations between turns are picked up automatically. Holding a
  // 200-message session in memory costs ~200KB.
  private cachedMessages: SessionMessage[] | null = null;
  // Set true on the first sanitizeForProvider() call within this
  // SessionManager instance that drops anything. Suppresses log spam
  // when the loop calls getTranscriptForProvider() multiple times per
  // turn (one per iteration). A new SessionManager is constructed per
  // turn, so any new orphan introduced by the previous turn surfaces
  // exactly once on the next turn's first iteration.
  private sanitizationLogged = false;
  // When true, appendMessage skips the per-dir index.json bookkeeping
  // entirely. The channel adapter sets this: a channel transcript's
  // metadata lives in the channels REGISTRY (.mantle/channels/index.json),
  // and the inherited per-dir index was a dead file nothing read — written
  // on every row of every volley.
  private readonly skipIndex: boolean;

  constructor(sessionId: string, sessionsDir: string, opts?: { skipIndex?: boolean }) {
    this.sessionId = sessionId;
    this.filePath = resolve(sessionsDir, `${sessionId}.jsonl`);
    this.indexPath = resolve(sessionsDir, "index.json");
    this.skipIndex = opts?.skipIndex === true;

    // Ensure sessions directory exists
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Returns the in-memory transcript. The array IS the cache — callers
  // must NOT mutate it (no push/pop/splice/sort). All current callers
  // are read-only or use .slice() to derive new arrays. To replace the
  // transcript wholesale use replaceMessages(); to add a turn use
  // appendMessage() — both keep the cache coherent.
  async getMessages(): Promise<SessionMessage[]> {
    if (this.cachedMessages !== null) {
      return this.cachedMessages;
    }

    if (!existsSync(this.filePath)) {
      this.cachedMessages = [];
      return this.cachedMessages;
    }

    const raw = readFileSync(this.filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const messages: SessionMessage[] = [];

    for (const line of lines) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    this.cachedMessages = messages;
    return this.cachedMessages;
  }

  async appendMessage(message: SessionMessage): Promise<void> {
    const line = JSON.stringify(message) + "\n";
    appendFileSync(this.filePath, line, "utf-8");
    // Keep the cache coherent if it's been loaded. If not yet loaded,
    // the next getMessages() call will read fresh from disk and pick
    // up this append naturally — no need to populate it here.
    if (this.cachedMessages !== null) {
      this.cachedMessages.push(message);
    }
    // Queue the index update behind any in-flight one and return —
    // caller doesn't wait. Saves ~5–10ms per appendMessage; with two
    // appends per loop iteration on a multi-step turn that adds up
    // to noticeable "no pause between tool result and next inference"
    // snappiness. The queue is PROCESS-GLOBAL per index path (not
    // per-instance), so concurrent SessionManager instances for the same
    // agent serialize their index writes and flushIndex observes all of
    // them. Errors are logged inside the chain, never thrown back; if the
    // index ends up stale the next append fixes it.
    if (!this.skipIndex) {
      enqueueIndexWrite(this.indexPath, () => this.updateIndex(message));
    }
  }

  // Wait for all queued index writes for THIS AGENT'S index to land on
  // disk — including writes queued by other SessionManager instances.
  // Callers that hand control to another consumer of the same agent's
  // index.json should call this before yielding — e.g. the agent loop's
  // exit path so that the next chat (or a cron run starting after a
  // chat) constructs its SessionManager against fully-written state.
  // Resolves immediately when the queue is empty.
  async flushIndex(): Promise<void> {
    await flushIndexWrites(this.indexPath);
  }

  // Convert stored messages to the format providers expect.
  // Drops thinking blocks (provider-private) and runs sanitizeForProvider
  // to strip degenerate states the provider would reject — empty text
  // blocks, content-empty messages, and unpaired tool_use / tool_result
  // blocks. The sanitization is read-only (the JSONL on disk is not
  // rewritten) so it acts as a safety net rather than a destructive heal.
  async getTranscriptForProvider(): Promise<ProviderMessage[]> {
    const messages = await this.getMessages();
    const transformed: ProviderMessage[] = [];

    for (const msg of messages) {
      if (msg.role === "system") continue; // System messages are not sent as conversation turns

      transformed.push({
        role: msg.role as "user" | "assistant",
        content: msg.content.filter((b) => b.type !== "thinking"),
      });
    }

    return this.sanitizeForProvider(transformed);
  }

  // See sanitizeProviderMessages below — this thin wrapper just adds the
  // once-per-SessionManager-instance logging (the method is called every
  // loop iteration; a real new orphan surfaces exactly once per turn).
  private sanitizeForProvider(messages: ProviderMessage[]): ProviderMessage[] {
    const { messages: result, droppedSummary } = sanitizeProviderMessages(messages);
    if (droppedSummary && !this.sanitizationLogged) {
      this.sanitizationLogged = true;
      console.warn(
        `[MANTLE:session] sanitized transcript for ${this.sessionId}: dropped ${droppedSummary}`,
      );
    }
    return result;
  }

  // Rough token estimation for compaction decisions. statSync gives
  // us file size without paying for the read+parse — the actual
  // messages aren't needed here, just byte count.
  estimateTokens(): number {
    if (!existsSync(this.filePath)) return 0;
    return Math.ceil(statSync(this.filePath).size / 4);
  }

  // Replace all messages (used after compaction)
  async replaceMessages(messages: SessionMessage[]): Promise<void> {
    const content = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    writeFileSync(this.filePath, content, "utf-8");
    // Replace the cache wholesale so subsequent getMessages() reflects
    // the post-compaction (or post-truncation) state. Defensive copy
    // so the caller can't mutate our internal state via the original
    // array reference.
    this.cachedMessages = messages.slice();
    // Resync the index's messageCount to the new reality — appendMessage
    // only ever increments, so after every compaction/retry-truncation the
    // sidebar count drifted further from the actual row count.
    if (!this.skipIndex) {
      enqueueIndexWrite(this.indexPath, () => {
        mutateIndexAtPath(this.indexPath, (index) => {
          const existing = index.sessions.find((s) => s.id === this.sessionId);
          if (!existing) return false;
          existing.messageCount = messages.length;
        });
      });
    }
  }

  // Find the index of the most recent user message that contains real
  // text or an attachment (i.e., a turn the user actually typed — not
  // a synthetic tool_result-only turn, not a mid-turn note). Returns -1
  // if none exists.
  private findLastUserTextIndex(messages: SessionMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      if (m.origin) continue; // notes / system deliveries never anchor retry/edit
      const hasText = m.content.some(
        (b) => b.type === "text" && b.text.trim().length > 0,
      );
      const hasAttachment = m.content.some(
        (b) => b.type === "image" || b.type === "file",
      );
      if (hasText || hasAttachment) return i;
    }
    return -1;
  }

  // Truncate the transcript AFTER the most recent real user turn, keeping
  // that user message intact. Used by the retry flow to re-run the loop
  // on the same prompt. Returns the kept user message's index (-1 if no
  // real user turn exists, in which case nothing is truncated).
  async truncateAfterLastUserText(): Promise<number> {
    const messages = await this.getMessages();
    const lastUserIdx = this.findLastUserTextIndex(messages);
    if (lastUserIdx === -1) return -1;
    const kept = messages.slice(0, lastUserIdx + 1);
    await this.replaceMessages(kept);
    return lastUserIdx;
  }

  // Drop the most recent real user turn AND everything after it. Used
  // by the edit flow before the new (edited) user message gets appended.
  // Returns true if anything was dropped, false otherwise.
  async dropLastUserAndAfter(): Promise<boolean> {
    const messages = await this.getMessages();
    const lastUserIdx = this.findLastUserTextIndex(messages);
    if (lastUserIdx === -1) return false;
    const kept = messages.slice(0, lastUserIdx);
    await this.replaceMessages(kept);
    return true;
  }

  private async updateIndex(lastMessage: SessionMessage): Promise<void> {
    mutateIndexAtPath(this.indexPath, (index) => {
      const existing = index.sessions.find((s) => s.id === this.sessionId);
      const now = new Date().toISOString();

      if (existing) {
        // If this is the first real message into a pre-created entry
        // (e.g. a call session pre-registered via createSessionMeta),
        // derive the title from the first user prompt instead of leaving
        // the "New session" placeholder.
        if (existing.messageCount === 0 && lastMessage.role === "user" && !existing.titleEdited) {
          const textBlock = lastMessage.content.find((b) => b.type === "text");
          if (textBlock && textBlock.type === "text") {
            existing.title = textBlock.text.slice(0, 80) + (textBlock.text.length > 80 ? "..." : "");
          }
        }
        existing.lastMessageAt = now;
        existing.messageCount += 1;
        if (lastMessage.provider) existing.provider = lastMessage.provider;
        if (lastMessage.model) existing.model = lastMessage.model;
      } else {
        // Derive title from first user message
        let title = "New session";
        if (lastMessage.role === "user") {
          const textBlock = lastMessage.content.find((b) => b.type === "text");
          if (textBlock && textBlock.type === "text") {
            title = textBlock.text.slice(0, 80);
            if (textBlock.text.length > 80) title += "...";
          }
        }

        index.sessions.push({
          id: this.sessionId,
          createdAt: now,
          lastMessageAt: now,
          title,
          provider: lastMessage.provider ?? "unknown",
          model: lastMessage.model ?? "unknown",
          messageCount: 1,
        });
      }
    });
  }

  // Read this session's metadata entry from the index. Returns undefined
  // if no entry exists yet (e.g., session UUID was minted but no message
  // has been appended and no createSessionMeta call was made).
  getMeta(): SessionMeta | undefined {
    return readIndexAt(this.indexPath).sessions.find((s) => s.id === this.sessionId);
  }

  // Patch this session's index entry; when no entry exists yet and `stub`
  // is provided, register one carrying the patch. Metadata setters share this
  // read-modify-write implementation.
  private patchMeta(
    patch: (existing: SessionMeta) => void,
    stub?: Partial<SessionMeta>,
  ): void {
    mutateIndexAtPath(this.indexPath, (index) => {
      const existing = index.sessions.find((s) => s.id === this.sessionId);
      if (existing) {
        patch(existing);
        return;
      }
      if (!stub) return false; // no entry + no stub → skip the write
      const now = new Date().toISOString();
      index.sessions.push({
        id: this.sessionId,
        createdAt: now,
        lastMessageAt: now,
        title: "New session",
        provider: "unknown",
        model: "unknown",
        messageCount: 0,
        ...stub,
      });
    });
  }

  // Persist final call duration onto the session meta. Called by the
  // RealtimeSession on close so the sidebar can render call length
  // without parsing transcript rows. No-op if the index doesn't have
  // an entry yet (call ended before any turns were persisted).
  async setCallDuration(durationMs: number): Promise<void> {
    if (!existsSync(this.indexPath)) return;
    this.patchMeta((m) => {
      m.callDurationMs = durationMs;
      m.lastMessageAt = new Date().toISOString();
    });
  }

  // Static helpers for session management

  // Pre-register a session in the index before any message has been
  // appended. Used when a non-chat mode needs metadata available before
  // its first persisted transcript message.
  static createSessionMeta(
    sessionId: string,
    sessionsDir: string,
    partial: Partial<SessionMeta> = {},
  ): SessionMeta {
    const indexPath = resolve(sessionsDir, "index.json");
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    let meta: SessionMeta | undefined;
    mutateIndexAtPath(indexPath, (index) => {
      const existing = index.sessions.find((s) => s.id === sessionId);
      if (existing) {
        meta = existing;
        return false; // already registered — skip the write
      }
      const now = new Date().toISOString();
      meta = {
        id: sessionId,
        createdAt: now,
        lastMessageAt: now,
        title: partial.title ?? "New session",
        provider: partial.provider ?? "unknown",
        model: partial.model ?? "unknown",
        messageCount: 0,
        ...partial,
      };
      index.sessions.push(meta);
    });
    return meta!;
  }

  static loadIndex(sessionsDir: string): SessionIndex {
    return readIndexAt(resolve(sessionsDir, "index.json"));
  }

  // Patch user-curated meta (rename / pin) from the REST layer. Same
  // read-modify-write pattern as the other index mutators. Returns the
  // updated meta, or null when the session has no index entry.
  static updateSessionMeta(
    sessionId: string,
    sessionsDir: string,
    patch: { title?: string; pinned?: boolean },
  ): SessionMeta | null {
    let updated: SessionMeta | null = null;
    mutateIndexAtPath(resolve(sessionsDir, "index.json"), (index) => {
      const existing = index.sessions.find((s) => s.id === sessionId);
      if (!existing) return false;
      if (typeof patch.title === "string" && patch.title.trim().length > 0) {
        existing.title = patch.title.trim().slice(0, 120);
        existing.titleEdited = true;
      }
      if (typeof patch.pinned === "boolean") {
        existing.pinned = patch.pinned || undefined; // keep the index lean
      }
      updated = existing;
    });
    return updated;
  }

  static deleteSession(sessionId: string, sessionsDir: string): boolean {
    const filePath = resolve(sessionsDir, `${sessionId}.jsonl`);
    const indexPath = resolve(sessionsDir, "index.json");

    // Remove JSONL file
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      return false;
    }

    // Remove uploads for this session
    try {
      const agentId = basename(sessionsDir);
      const uploadsDir = resolve(sessionsDir, "..", "..", "uploads", agentId, sessionId);
      if (existsSync(uploadsDir)) {
        rmSync(uploadsDir, { recursive: true });
      }
    } catch {
      // Upload cleanup failed, not critical
    }

    // Update index
    try {
      if (existsSync(indexPath)) {
        mutateIndexAtPath(indexPath, (index) => {
          index.sessions = index.sessions.filter((s) => s.id !== sessionId);
        });
      }
    } catch {
      // Index update failed, but file was deleted
    }

    return true;
  }
}
