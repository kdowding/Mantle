// Channel persistence — fully self-contained (no SessionManager/core import),
// so the feature stays bolt-on. Storage is a NEW top-level root sibling to
// sessions/ : .mantle/channels/index.json (registry) + .mantle/channels/<id>/<id>.jsonl
// (one shared, author-tagged transcript per channel). A channel belongs to no
// single agent, so it must NOT live under sessions/<agentId>/ (agent purge
// would delete it, and the per-agent index/lock don't apply).
//
// The transcript JSONL uses the SAME line format as SessionManager
// (JSON.stringify(row) + "\n") so that, in later phases, a real SessionManager
// pointed at the channel dir (which runAgentLoop requires) and this store can
// read/write the same file interchangeably. The `author` field rides as an
// extra JSON property — invisible to core SessionMessage.
//
// CONCURRENCY INVARIANT (the transcript has two writers: the sub-turn's
// SessionManager appends, this store appends/rewrites): every mutating op in
// this file must stay fully SYNCHRONOUS — read, modify, write in one tick,
// no await between them. Sync fs calls on one JS thread cannot interleave,
// which is the entire mutual-exclusion story. If any op here ever needs an
// await mid-mutation, it needs a real per-channel write lock first.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "fs";
import { resolve } from "path";
import type { ChannelMessage, ChannelMeta, ChannelModelOverride, ChannelReaction, ChannelVolley, ChannelWhisper } from "./types.js";
import { VOLLEY_CAP, VOLLEY_DEFAULTS } from "./types.js";

// The only id shape this store ever mints (create() below). Everything that
// turns an id into a filesystem path validates against it, so a raw id from
// the WS/REST boundary ("../../etc") can never traverse out of the channels
// root — even if a future call site forgets to validate at the edge.
const CHANNEL_ID_RE = /^chan-[0-9a-f]{8}$/;

export function isValidChannelId(id: string): boolean {
  return CHANNEL_ID_RE.test(id);
}

// Clamp a (possibly garbage) maxTurns to the allowed [1, VOLLEY_CAP] range,
// falling back to the default when it isn't a finite number.
function clampTurns(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return VOLLEY_DEFAULTS.maxTurns;
  return Math.max(1, Math.min(VOLLEY_CAP, v));
}

// Backfill the volley + auto-respond fields onto a meta read from disk so the
// rest of the codebase can assume they exist (channels created before the
// feature shipped lack them). Mutates + returns the same object. Also enforces
// the invariant that autoRespond ⊆ participants. Because readIndex normalizes
// every entry, the next write through writeIndex persists the healed shape.
function normalizeMeta(meta: ChannelMeta): ChannelMeta {
  const participants = Array.isArray(meta.participants) ? meta.participants : [];
  meta.participants = participants;
  const auto = Array.isArray(meta.autoRespond) ? meta.autoRespond : [];
  // Keep roster order + drop any live mic that's no longer a participant.
  meta.autoRespond = participants.filter((id) => auto.includes(id));
  const v = (meta.volley ?? {}) as Partial<ChannelVolley>;
  meta.volley = {
    enabled: !!v.enabled,
    maxTurns: clampTurns(v.maxTurns),
    style: v.style === "round-robin" ? "round-robin" : "free",
  };
  meta.memoryPack = !!meta.memoryPack;
  return meta;
}

export class ChannelStore {
  constructor(private basePath: string) {}

  private root(): string {
    return resolve(this.basePath, ".mantle", "channels");
  }
  private indexPath(): string {
    return resolve(this.root(), "index.json");
  }
  channelDir(id: string): string {
    // Containment backstop — see CHANNEL_ID_RE. Throwing (vs sanitizing)
    // is deliberate: a non-conforming id reaching a path computation is a
    // caller bug, and every route/bridge entry point 404s/notices first.
    if (!isValidChannelId(id)) throw new Error(`Invalid channel id: ${id}`);
    return resolve(this.root(), id);
  }
  transcriptPath(id: string): string {
    return resolve(this.channelDir(id), `${id}.jsonl`);
  }

  private readIndex(): ChannelMeta[] {
    const p = this.indexPath();
    if (!existsSync(p)) return [];
    try {
      const parsed = JSON.parse(readFileSync(p, "utf-8"));
      return Array.isArray(parsed) ? (parsed as ChannelMeta[]).map((m) => normalizeMeta(m)) : [];
    } catch {
      return [];
    }
  }

  // Atomic index write (temp + rename) — same durability pattern as the
  // per-agent session index.
  private writeIndex(metas: ChannelMeta[]): void {
    mkdirSync(this.root(), { recursive: true });
    const p = this.indexPath();
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(metas, null, 2));
    renameSync(tmp, p);
  }

  create(params: { title: string; participants?: string[] }): ChannelMeta {
    const id = `chan-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const meta: ChannelMeta = {
      id,
      title: params.title,
      participants: params.participants ?? [],
      autoRespond: [],
      volley: { ...VOLLEY_DEFAULTS },
      memoryPack: false,
      modelOverrides: {},
      createdAt: now,
      lastMessageAt: now,
    };
    mkdirSync(this.channelDir(id), { recursive: true });
    const metas = this.readIndex();
    metas.push(meta);
    this.writeIndex(metas);
    return meta;
  }

  list(): ChannelMeta[] {
    return this.readIndex().sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  get(id: string): ChannelMeta | undefined {
    return this.readIndex().find((m) => m.id === id);
  }

  // Read-modify-write a single channel's meta atomically. Returns the updated
  // meta, or undefined if the channel doesn't exist.
  update(id: string, mutate: (m: ChannelMeta) => void): ChannelMeta | undefined {
    const metas = this.readIndex();
    const meta = metas.find((m) => m.id === id);
    if (!meta) return undefined;
    mutate(meta);
    this.writeIndex(metas);
    return meta;
  }

  delete(id: string): void {
    this.writeIndex(this.readIndex().filter((m) => m.id !== id));
    // FULLY remove the channel: drop the transcript dir (and its JSONL) so the
    // session is gone entirely — no orphaned dirs left to sweep. `force` makes
    // a missing dir a no-op so a double-delete / index-only entry is safe.
    rmSync(this.channelDir(id), { recursive: true, force: true });
  }

  invite(id: string, agentId: string): ChannelMeta | undefined {
    return this.update(id, (m) => {
      if (!m.participants.includes(agentId)) m.participants.push(agentId);
    });
  }

  dismiss(id: string, agentId: string): ChannelMeta | undefined {
    return this.update(id, (m) => {
      m.participants = m.participants.filter((a) => a !== agentId);
      // A dismissed agent can't be a live mic — drop it so it doesn't linger.
      m.autoRespond = m.autoRespond.filter((a) => a !== agentId);
    });
  }

  // Toggle an agent's "live mic" (auto-respond) state. A no-op if `on` is true
  // but the agent isn't a participant (you can only auto-reply if you're in the
  // channel). Stored in participant (roster) order so the opening queue is
  // deterministic.
  setAutoRespond(id: string, agentId: string, on: boolean): ChannelMeta | undefined {
    return this.update(id, (m) => {
      const set = new Set(m.autoRespond);
      if (on && m.participants.includes(agentId)) set.add(agentId);
      else set.delete(agentId);
      m.autoRespond = m.participants.filter((p) => set.has(p));
    });
  }

  // Patch the volley config (partial merge). maxTurns is clamped to the allowed
  // range; style is validated. Absent fields keep their current value.
  updateVolley(id: string, patch: Partial<ChannelVolley>): ChannelMeta | undefined {
    return this.update(id, (m) => {
      m.volley = {
        enabled: patch.enabled ?? m.volley.enabled,
        maxTurns: patch.maxTurns != null ? clampTurns(patch.maxTurns) : m.volley.maxTurns,
        style: patch.style ?? m.volley.style,
      };
    });
  }

  // Set (or clear) an agent's sticky provider/model override. An override with
  // neither field reverts the agent to its own defaults (the key is dropped, so
  // the index doesn't accumulate empty husks).
  setModelOverride(id: string, agentId: string, override: ChannelModelOverride): ChannelMeta | undefined {
    return this.update(id, (m) => {
      if (!override.provider && !override.model) delete m.modelOverrides[agentId];
      else m.modelOverrides[agentId] = override;
    });
  }

  // Append one author-tagged row to the transcript + bump meta. Synchronous
  // append for durability (matches SessionManager).
  appendMessage(id: string, msg: ChannelMessage): void {
    const dir = this.channelDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.transcriptPath(id), JSON.stringify(msg) + "\n", { flag: "a" });
    this.update(id, (m) => {
      m.lastMessageAt = msg.timestamp;
      if (msg.author?.kind === "agent") m.lastActiveAgentId = msg.author.agentId;
    });
  }

  readMessages(id: string): ChannelMessage[] {
    const p = this.transcriptPath(id);
    if (!existsSync(p)) return [];
    const out: ChannelMessage[] = [];
    for (const line of readFileSync(p, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as ChannelMessage);
      } catch {
        // skip a corrupt line rather than fail the whole read
      }
    }
    return out;
  }

  // Atomic transcript rewrite (temp + rename) — shared by the row-mutating ops.
  private writeMessages(id: string, rows: ChannelMessage[]): void {
    const p = this.transcriptPath(id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
    renameSync(tmp, p);
  }

  // Add/remove a reaction on a specific message row. on=true adds (idempotent),
  // on=false removes; a (by, emoji) pair is unique on a row (by = "user" or an
  // agentId). Returns the row's updated reactions + id, or undefined if the
  // channel/message isn't found.
  setReaction(channelId: string, messageId: string, emoji: string, by: string, on: boolean):
    { messageId: string; reactions: ChannelReaction[] } | undefined {
    const e = (emoji || "").trim();
    if (!e) return undefined;
    const rows = this.readMessages(channelId);
    const row = rows.find((r) => r.id === messageId);
    if (!row) return undefined;
    const list = Array.isArray(row.reactions) ? row.reactions : [];
    const idx = list.findIndex((r) => r.by === by && r.emoji === e);
    if (on && idx === -1) list.push({ emoji: e, by });
    else if (!on && idx !== -1) list.splice(idx, 1);
    else return { messageId, reactions: list }; // no change → don't rewrite
    row.reactions = list;
    this.writeMessages(channelId, rows);
    return { messageId, reactions: list };
  }

  // Channel RETRY support. Find the LAST user-authored row, drop every row
  // AFTER it (the prior attempt's agent replies), KEEP that user row, and
  // rewrite the transcript atomically (mirrors stampLastAssistantAuthor's
  // temp+rename). Recompute meta.lastActiveAgentId to the last AGENT-authored
  // row that REMAINS (or clear it when none remain). Returns the kept user
  // row's joined text content + its whisper scope (a retried aside must
  // re-route privately), or null if there is no user row to retry.
  truncateAfterLastUser(id: string): { text: string; whisper?: ChannelWhisper } | null {
    const rows = this.readMessages(id);
    let lastUser = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].author?.kind === "user") {
        lastUser = i;
        break;
      }
    }
    if (lastUser === -1) return null;

    const kept = rows.slice(0, lastUser + 1);
    const p = this.transcriptPath(id);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join("\n") + (kept.length ? "\n" : ""));
    renameSync(tmp, p);

    // Recompute last-active from the rows that REMAIN: the last agent-authored
    // row, or clear it (a retry of the very first user turn has no prior agent).
    let lastActiveAgentId: string | undefined;
    for (let i = kept.length - 1; i >= 0; i--) {
      const a = kept[i].author;
      if (a?.kind === "agent") {
        lastActiveAgentId = a.agentId;
        break;
      }
    }
    this.update(id, (m) => {
      m.lastActiveAgentId = lastActiveAgentId;
    });

    // Join the kept user row's text blocks (matches how the row was authored:
    // a single { type: "text" } block, but join defensively across all of them).
    const parts: string[] = [];
    for (const b of kept[lastUser].content) {
      if (b.type === "text") parts.push(b.text);
    }
    return { text: parts.join(""), whisper: kept[lastUser].whisper };
  }

  // Record that an agent's reply landed in the transcript. The rows
  // themselves are author-stamped at append time by ChannelSessionManager
  // (which replaced the old post-turn stampLastAssistantAuthor rewrite —
  // one fewer whole-file writer racing the loop's appends); this just bumps
  // the meta the sidebar and un-@'d routing read.
  noteAgentReply(id: string, agentId: string): void {
    this.update(id, (m) => {
      m.lastActiveAgentId = agentId;
      m.lastMessageAt = new Date().toISOString();
    });
  }
}
