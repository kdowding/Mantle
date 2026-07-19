import { resolve, join, relative, sep } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, renameSync } from "fs";
import type { MantleConfig, MusicConfig } from "../../config/schema.js";
import { safeFetch, readResponseCapped } from "../../tools/core/net-guard.js";
import { KieClient, type GenerateParams, type SunoTrack } from "./kie.js";
import { sanitizeSegment, sanitizeFilename, uniquePath } from "./paths.js";
import { writeMeta, readMeta, lyricsPathFor, coverPathFor, walkMp3, type MusicMeta } from "./metadata.js";

// A generation kie.ai is still working on. Persisted to _pending.json so a
// mantle restart mid-generation resumes polling instead of losing the track.
// The generation params ride along so the poll loop can write the .meta.json
// sidecar (the prompt + lineage) when the track lands — they survive a restart.
interface PendingTask {
  taskId: string;
  agentId: string;
  title: string;
  startedAt: number; // epoch ms
  style: string;
  model: string;
  instrumental: boolean;
  lyrics?: string;
  parentTitle?: string; // lineage: resolved `basedOn` reference
  parentAgentId?: string;
}

// A track on disk with its parsed generation metadata — what the read tools
// (list_music / get_music_track) and the player's prompt panel work from.
export interface TrackInfo {
  agentId: string;
  title: string; // mp3 stem
  relPath: string; // posix path within the agent bucket
  folder: string; // posix parent folder ("" = bucket root)
  createdAt: number; // file mtime (epoch ms)
  hasLyrics: boolean; // a .lyrics.json karaoke transcript sits beside it
  hasCover: boolean; // a .cover.jpg album-art sidecar sits beside it
  meta: MusicMeta | null; // the .meta.json generation record, if any
}

// The saved karaoke transcript (Whisper) for a track — what get_music_lyrics
// reads. Word-level timing is omitted (the tool only needs the lines/text).
export interface LyricsData {
  text?: string;
  language?: string;
  audioDurationS?: number;
  segments?: Array<{ start?: number; end?: number; text?: string }>;
}

const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // a Suno track is a few MB; this is slack
const MAX_COVER_BYTES = 10 * 1024 * 1024; // album art is a small jpeg; generous slack
const DOWNLOAD_TIMEOUT_MS = 90_000;

// Owns Suno generation: kicks tasks off via kie.ai, runs a detached poll loop
// (only while tasks are pending), downloads finished mp3s into
// .mantle/music/<agentId>/, and broadcasts a `music_changed` WS event so the
// player refreshes. Completion is deliberately SILENT — no agent chat turn.
export class MusicManager {
  private cfg: MusicConfig;
  private musicRoot: string;
  private pendingFile: string;
  private pending = new Map<string, PendingTask>();
  private client: KieClient | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private disposed = false;
  // WS broadcast, injected at construction — a room never imports the
  // server; the composition root wires broadcastToAllWebSockets in.
  private broadcast: (msg: Record<string, unknown>) => void;

  constructor(
    config: MantleConfig,
    basePath: string,
    broadcast: (msg: Record<string, unknown>) => void = () => {},
  ) {
    this.cfg = config.music;
    this.broadcast = broadcast;
    this.musicRoot = resolve(basePath, ".mantle", "music");
    this.pendingFile = join(this.musicRoot, "_pending.json");
    mkdirSync(this.musicRoot, { recursive: true });
    this.client = this.cfg.apiKey
      ? new KieClient(this.cfg.apiKey, this.cfg.baseUrl, this.cfg.defaultModel)
      : null;
  }

  // Generation is available only with a key AND the master switch on. The
  // player (listing/streaming existing files) works regardless.
  isEnabled(): boolean {
    return this.cfg.enabled && !!this.cfg.apiKey;
  }

  get root(): string {
    return this.musicRoot;
  }

  // In-flight generations, for the tray's "generating…" placeholders.
  generating(): Array<{ agentId: string; title: string; taskId: string }> {
    return [...this.pending.values()].map((t) => ({
      agentId: t.agentId,
      title: t.title,
      taskId: t.taskId,
    }));
  }

  // Flat listing of every track on disk, with parsed generation metadata —
  // backs the read tools (list_music / get_music_track). Optionally scoped to
  // one agent's bucket. Tolerant of a missing root (returns []). Reads sidecars
  // synchronously, which is fine for a library of tens–hundreds of tracks.
  library(filterAgentId?: string): TrackInfo[] {
    const out: TrackInfo[] = [];
    const want = filterAgentId ? sanitizeSegment(filterAgentId) : null;
    let buckets: string[];
    try {
      buckets = readdirSync(this.musicRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      return out;
    }
    for (const agentId of buckets) {
      if (want && agentId !== want) continue;
      const dir = join(this.musicRoot, agentId);
      for (const file of walkMp3(dir)) {
        const rel = relative(dir, file).split(sep).join("/");
        const slash = rel.lastIndexOf("/");
        const folder = slash === -1 ? "" : rel.slice(0, slash);
        const stem = (slash === -1 ? rel : rel.slice(slash + 1)).replace(/\.mp3$/i, "");
        out.push({
          agentId,
          title: stem,
          relPath: rel,
          folder,
          createdAt: Math.floor(statSync(file).mtimeMs),
          hasLyrics: existsSync(lyricsPathFor(file)),
          hasCover: existsSync(coverPathFor(file)),
          meta: readMeta(file),
        });
      }
    }
    return out;
  }

  // Read a track's saved karaoke transcript (the .lyrics.json sidecar), or null
  // if none / unreadable. Backs the get_music_lyrics tool. agentId + relPath
  // come from a TrackInfo (both already on-disk values), so the path is safe.
  readLyrics(agentId: string, relPath: string): LyricsData | null {
    const segs = relPath.split("/").filter((s) => s && s !== "." && s !== "..");
    const abs = join(this.musicRoot, sanitizeSegment(agentId), ...segs);
    const lp = lyricsPathFor(abs);
    if (!existsSync(lp)) return null;
    try {
      return JSON.parse(readFileSync(lp, "utf-8")) as LyricsData;
    } catch {
      return null;
    }
  }

  // Resume any tasks persisted before a restart. Called once after boot.
  start(): void {
    this.loadPending();
    if (this.pending.size > 0) {
      console.log(`[MANTLE:music] Resuming ${this.pending.size} pending generation(s)`);
      this.ensurePolling();
    }
  }

  // Kick off a generation. Returns immediately with the kie.ai taskId; the
  // poll loop downloads + broadcasts when it lands. Shared by the
  // generate_music tool and POST /api/music/generate.
  async generate(
    params: GenerateParams & { agentId: string; basedOn?: string; basedOnAgentId?: string },
    signal?: AbortSignal,
  ): Promise<{ taskId: string }> {
    if (!this.client || !this.isEnabled()) {
      throw new Error("Music generation is not configured — set KIE_API_KEY (or config.music.apiKey).");
    }
    const parent = params.basedOn?.trim() ? this.resolveParent(params.basedOn.trim(), params.basedOnAgentId) : null;
    const { taskId } = await this.client.generate(params, signal);
    console.log(`[MANTLE:music] Generation queued: "${(params.title || "Untitled").trim()}" (${taskId}) for "${params.agentId}"${parent ? ` (based on "${parent.title}")` : ""} — polling every ${Math.round(this.cfg.pollIntervalMs / 1000)}s`);
    this.pending.set(taskId, {
      taskId,
      agentId: params.agentId,
      title: (params.title || "Untitled").trim(),
      startedAt: Date.now(),
      style: params.style,
      model: (params.model || this.cfg.defaultModel).trim(),
      instrumental: params.instrumental,
      lyrics: params.instrumental ? undefined : params.lyrics,
      parentTitle: parent?.title,
      parentAgentId: parent?.agentId,
    });
    this.savePending();
    this.ensurePolling();
    return { taskId };
  }

  // Resolve a `basedOn` reference (track title, optionally scoped to an agent)
  // to a canonical {agentId, title}. Falls back to the raw title with no agent
  // if it can't be pinned down, so a stale/typo'd reference still records intent.
  private resolveParent(basedOn: string, basedOnAgentId?: string): { agentId?: string; title: string } {
    const matches = this.library(basedOnAgentId).filter((t) => t.title.toLowerCase() === basedOn.toLowerCase());
    if (matches.length === 1 || (matches.length > 1 && basedOnAgentId)) {
      return { agentId: matches[0]!.agentId, title: matches[0]!.title };
    }
    return { title: basedOn };
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // Purge support (Room.onAgentPurge): drop any in-flight generations
  // targeting this agent FIRST — an active kie.ai poll would otherwise
  // re-create the bucket via mkdirSync when its track lands — then delete
  // the bucket tree (tracks + sidecars).
  purgeAgent(agentId: string): { droppedTasks: number; bucketDeleted: boolean } {
    let dropped = 0;
    for (const [taskId, task] of this.pending) {
      if (task.agentId === agentId) {
        this.pending.delete(taskId);
        dropped++;
      }
    }
    if (dropped > 0) this.savePending();
    const bucket = join(this.musicRoot, sanitizeSegment(agentId));
    let bucketDeleted = false;
    if (existsSync(bucket)) {
      rmSync(bucket, { recursive: true, force: true });
      bucketDeleted = true;
    }
    return { droppedTasks: dropped, bucketDeleted };
  }

  // ── poll loop ────────────────────────────────────────────────────────────
  // Self-arming: runs only while there are pending tasks, re-schedules itself
  // after each tick, and goes idle (no timer) once everything drains.
  private ensurePolling(): void {
    if (this.disposed || this.timer || this.pending.size === 0) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.cfg.pollIntervalMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (this.disposed || !this.client) return;
    if (this.ticking) {
      this.ensurePolling();
      return;
    }
    this.ticking = true;
    try {
      const timeoutMs = this.cfg.maxPollMinutes * 60_000;
      // Snapshot — we delete entries from `pending` while iterating.
      const tasks = Array.from(this.pending.values());
      for (const task of tasks) {
        if (this.disposed) break;

        if (Date.now() - task.startedAt > timeoutMs) {
          console.warn(
            `[MANTLE:music] Task ${task.taskId} ("${task.title}") timed out after ${this.cfg.maxPollMinutes}m — dropping`,
          );
          this.pending.delete(task.taskId);
          this.savePending();
          this.broadcast({ type: "music_error", agentId: task.agentId, title: task.title, reason: "timeout" });
          continue;
        }

        let state;
        try {
          state = await this.client.check(task.taskId);
        } catch (err) {
          // Transient — retry on the next tick.
          console.warn(`[MANTLE:music] check ${task.taskId} errored: ${err instanceof Error ? err.message : err}`);
          continue;
        }

        if (state.status === "pending") continue;

        if (state.status === "failed") {
          console.warn(`[MANTLE:music] Task ${task.taskId} ("${task.title}") failed: ${state.reason}`);
          this.pending.delete(task.taskId);
          this.savePending();
          this.broadcast({ type: "music_error", agentId: task.agentId, title: task.title, reason: state.reason });
          continue;
        }

        // complete
        const saved = await this.downloadTracks(task, state.tracks);
        this.pending.delete(task.taskId);
        this.savePending();
        if (saved > 0) {
          console.log(`[MANTLE:music] Task ${task.taskId} done — saved ${saved} track(s) for "${task.agentId}"`);
          this.broadcast({ type: "music_changed", agentId: task.agentId });
        } else {
          console.warn(`[MANTLE:music] Task ${task.taskId} reported complete but no audio downloaded`);
        }
      }
    } finally {
      this.ticking = false;
      this.ensurePolling();
    }
  }

  private async downloadTracks(task: PendingTask, tracks: SunoTrack[]): Promise<number> {
    const dir = join(this.musicRoot, sanitizeSegment(task.agentId));
    mkdirSync(dir, { recursive: true });
    let count = 0;
    for (const track of tracks) {
      const url = track.audioUrl || track.streamAudioUrl;
      if (!url) continue;
      try {
        // The download URL comes from the VENDOR RESPONSE, not config — a
        // compromised/poisoned reply could point anywhere (second-order
        // SSRF), so it gets the full net-guard treatment + a streamed,
        // capped read instead of an unbounded arrayBuffer().
        const res = await safeFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!res.ok) {
          console.warn(`[MANTLE:music] download HTTP ${res.status} for "${track.title ?? task.title}"`);
          continue;
        }
        const { bytes, capped } = await readResponseCapped(res, MAX_AUDIO_BYTES);
        if (capped) {
          console.warn(`[MANTLE:music] track exceeded ${MAX_AUDIO_BYTES} bytes — skipping`);
          continue;
        }
        const base = sanitizeFilename(track.title || task.title || "track");
        const dest = uniquePath(dir, base, ".mp3");
        writeFileSync(dest, Buffer.from(bytes));
        // Persist the prompt + params beside the mp3 so it's reproducible /
        // inspectable later (the read tools + the player's prompt panel). Both
        // variations of a call share the request params; per-track id/tags/
        // duration come from Suno's own response.
        try {
          writeMeta(dest, {
            style: task.style,
            title: (track.title || task.title || base).trim(),
            instrumental: task.instrumental,
            lyrics: task.instrumental ? undefined : task.lyrics,
            model: task.model,
            taskId: task.taskId,
            agentId: task.agentId,
            generatedAt: Date.now(),
            sunoId: track.id,
            tags: track.tags,
            durationSec: track.duration,
            parentTitle: task.parentTitle,
            parentAgentId: task.parentAgentId,
          });
        } catch (err) {
          // A missing sidecar isn't fatal — the track still plays.
          console.warn(`[MANTLE:music] could not write metadata for "${base}": ${err instanceof Error ? err.message : err}`);
        }
        // Album art: Suno returns a per-track imageUrl. Save it beside the mp3
        // as a .cover.jpg sidecar (best-effort — a missing cover isn't fatal).
        if (track.imageUrl) {
          try {
            await this.downloadCover(track.imageUrl, coverPathFor(dest));
          } catch (err) {
            console.warn(`[MANTLE:music] cover download failed for "${base}": ${err instanceof Error ? err.message : err}`);
          }
        }
        count++;
      } catch (err) {
        console.warn(`[MANTLE:music] download failed for "${track.title ?? task.title}": ${err instanceof Error ? err.message : err}`);
      }
    }
    return count;
  }

  private async downloadCover(url: string, dest: string): Promise<void> {
    // Vendor-supplied URL — same second-order-SSRF + capped-read treatment
    // as the audio download.
    const res = await safeFetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { bytes, capped } = await readResponseCapped(res, MAX_COVER_BYTES);
    if (capped) throw new Error(`cover exceeded ${MAX_COVER_BYTES} bytes`);
    writeFileSync(dest, Buffer.from(bytes));
  }

  // ── pending persistence ────────────────────────────────────────────────
  private loadPending(): void {
    if (!existsSync(this.pendingFile)) return;
    try {
      const arr = JSON.parse(readFileSync(this.pendingFile, "utf-8")) as PendingTask[];
      if (!Array.isArray(arr)) return;
      for (const t of arr) {
        if (t && typeof t.taskId === "string" && typeof t.agentId === "string") {
          // Old pending files (pre prompt-saving) lack the generation params —
          // default them so a resumed task still writes a (partial) sidecar.
          this.pending.set(t.taskId, {
            taskId: t.taskId,
            agentId: t.agentId,
            title: typeof t.title === "string" ? t.title : "Untitled",
            startedAt: typeof t.startedAt === "number" ? t.startedAt : Date.now(),
            style: typeof t.style === "string" ? t.style : "",
            model: typeof t.model === "string" && t.model ? t.model : this.cfg.defaultModel,
            instrumental: typeof t.instrumental === "boolean" ? t.instrumental : true,
            lyrics: typeof t.lyrics === "string" ? t.lyrics : undefined,
            parentTitle: typeof t.parentTitle === "string" ? t.parentTitle : undefined,
            parentAgentId: typeof t.parentAgentId === "string" ? t.parentAgentId : undefined,
          });
        }
      }
    } catch {
      /* corrupt pending file — ignore, start clean */
    }
  }

  private savePending(): void {
    try {
      // tmp+rename: a torn write would lose every pending generation on
      // the next restart (resume reads this file).
      const tmp = `${this.pendingFile}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.pending.values()], null, 2), "utf-8");
      renameSync(tmp, this.pendingFile);
    } catch (err) {
      console.warn(`[MANTLE:music] could not persist pending tasks: ${err instanceof Error ? err.message : err}`);
    }
  }
}
