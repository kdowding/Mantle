import type { Tool } from "../../tools/types.js";
import type { MusicManager, TrackInfo, LyricsData } from "./manager.js";
import type { MantleConfig } from "../../config/schema.js";
import { KIE_MODELS } from "./kie.js";

// generate_music — kick off a Suno (kie.ai) generation. Async + silent: returns
// immediately, the manager polls + downloads in the background, and the finished
// track appears in the music player on its own (a `music_changed` WS event
// refreshes it). Registered only when music is configured (key present),
// closing over the MusicManager — same pattern as createCronTool.
//
// INSTRUMENTAL ONLY by design: agents don't get a lyrics/vocals surface. The
// tool always generates instrumental. (The manager + UI still support vocal
// tracks for the user via the player's own Generate form.)
export function createGenerateMusicTool(manager: MusicManager): Tool {
  return {
    name: "generate_music",
    description:
      "Generate an original INSTRUMENTAL track with AI (Suno) and add it to the music player. " +
      "ASYNCHRONOUS AND SILENT: this returns right away, the track keeps rendering in the background " +
      "(~2-3 minutes), then appears in the player on its own. Do NOT call again to poll or check status — " +
      "there is nothing to wait for. The `style` field is the entire creative lever (genre, mood, " +
      "instrumentation, tempo, production). See the `suno-generate` skill for how to structure a strong " +
      "style prompt and for your own music taste. Two variations are produced per call.",
    inputSchema: {
      type: "object",
      properties: {
        style: {
          type: "string",
          description:
            "The full Suno style prompt — your whole creative control. Comma-separated, ordered " +
            "genre → mood → 3-6 instrument nouns → tempo/BPM → production/era, with the word " +
            "\"instrumental\" LAST. E.g. 'midnight darksynth, brooding and cinematic, analog bass " +
            "arpeggio, gated-reverb drums, glassy FM bells, 100 BPM, tape saturation, instrumental'. " +
            "Read the suno-generate skill for the full craft.",
        },
        title: { type: "string", description: "Track title (also becomes the filename in the player)." },
        model: {
          type: "string",
          description: `Suno model id. Defaults to the configured default (V5_5). One of: ${KIE_MODELS.join(", ")}.`,
          enum: [...KIE_MODELS],
        },
        basedOn: {
          type: "string",
          description:
            "Optional lineage: the TITLE of an existing track this one riffs on (e.g. when asked to make " +
            "something like a song you inspected with get_music_track). Records a 'based on' link shown in the " +
            "player — it doesn't change generation, so still write a full `style` yourself. Any agent's track works.",
        },
      },
      required: ["style", "title"],
    },
    async execute(input, context) {
      const agentId = context?.agentId;
      if (!agentId) {
        return { content: "generate_music needs an agent context (no agentId).", isError: true };
      }
      if (!manager.isEnabled()) {
        return {
          content: "Music generation isn't configured. Set KIE_API_KEY (or config.music.apiKey) and restart.",
          isError: true,
        };
      }

      const style = String(input.style ?? "").trim();
      const title = String(input.title ?? "").trim();
      if (!style) return { content: "`style` is required — the genre/mood/instrumentation/tempo prompt.", isError: true };
      if (!title) return { content: "`title` is required.", isError: true };
      const model = input.model ? String(input.model) : undefined;
      const basedOn = input.basedOn ? String(input.basedOn).trim() : undefined;

      try {
        // Always instrumental for the agent-facing tool.
        const { taskId } = await manager.generate({ agentId, style, title, instrumental: true, model, basedOn }, context?.signal);
        return {
          content:
            `Started generating "${title}" (instrumental). It will take ~2-3 minutes and then appear in the ` +
            `music player automatically — no need to wait, poll, or call this again. (taskId: ${taskId})`,
        };
      } catch (err) {
        return {
          content: `Failed to start music generation: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  };
}

// ── list_music / get_music_track — read-only library inspection ─────────────
// Let an agent browse every track (its own AND other agents') and pull the
// exact style prompt a song was generated from. That turns "make something like
// X" into: inspect X's prompt, then craft a fresh prompt for generate_music.
// Both read through MusicManager.library(), which parses the .meta.json
// sidecars written at generation time. Registered whenever music is enabled
// (no API key needed — they only read what's already on disk).

function fmtDuration(sec?: number): string {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}

function ymd(ms: number): string {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "";
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

// "ECHO (echo)" when the display name differs from the bucket id, else just id.
function agentLabel(config: MantleConfig, agentId: string): string {
  const name = config.agents.find((x) => x.id === agentId)?.name?.trim();
  return name && name !== agentId ? `${name} (${agentId})` : agentId;
}

// Tracks generated "in the vein of" `t` — the child→parent edges that point
// back at it (matched by title, scoped to its agent when the child recorded one).
function variationsOf(t: TrackInfo, all: TrackInfo[]): TrackInfo[] {
  const title = t.title.toLowerCase();
  return all.filter(
    (x) =>
      x.meta?.parentTitle &&
      x.meta.parentTitle.toLowerCase() === title &&
      (!x.meta.parentAgentId || x.meta.parentAgentId === t.agentId) &&
      !(x.agentId === t.agentId && x.title === t.title),
  );
}

function formatTrack(t: TrackInfo, all: TrackInfo[], config: MantleConfig): string {
  const out: string[] = [`"${t.title}" — by ${agentLabel(config, t.agentId)}`];
  if (t.folder) out.push(`Folder: ${t.folder}/`);
  const children = variationsOf(t, all);
  const lineage = (): void => {
    if (children.length) {
      out.push(`Variations made from this: ${children.map((c) => `"${c.title}" (${c.agentId})`).join(", ")}`);
    }
  };
  const m = t.meta;
  if (!m) {
    out.push("");
    out.push(
      "No generation prompt is on file for this track — it was uploaded, or made before prompts were saved, so the recipe isn't recoverable.",
    );
    out.push(t.hasLyrics ? "It does have a karaoke transcript (lyrics on file)." : "No lyrics on file.");
    lineage();
    const added = ymd(t.createdAt);
    if (added) out.push(`Added ${added}.`);
    return out.join("\n");
  }
  const facts = [`model ${m.model}`, m.instrumental ? "instrumental" : "vocal"];
  const dur = fmtDuration(m.durationSec);
  if (dur) facts.push(dur);
  const made = ymd(m.generatedAt);
  if (made) facts.push(`generated ${made}`);
  out.push(facts.join(" · "));
  if (m.parentTitle) {
    const by = m.parentAgentId && m.parentAgentId !== t.agentId ? ` (by ${agentLabel(config, m.parentAgentId)})` : "";
    out.push(`Based on: "${m.parentTitle}"${by}`);
  }
  lineage();
  if (m.tags) out.push(`Suno tags: ${m.tags}`);
  out.push("");
  out.push("Style prompt:");
  out.push(m.style ? m.style.trim() : "(none recorded)");
  if (!m.instrumental && m.lyrics) {
    out.push("", "Lyrics:", m.lyrics.trim());
  }
  if (t.hasLyrics) {
    out.push("", "(A karaoke transcript is on file — read it with get_music_lyrics, or view it in the player.)");
  }
  return out.join("\n");
}

// Whisper sometimes hallucinates filler on instrumental gaps; mirror the
// player's junk filter so the tool returns the real sung lines, not noise.
const LYRIC_JUNK = new Set([
  "well be right back", "thanks for watching", "thank you for watching",
  "thanks for watching this video", "please subscribe", "subscribe",
  "like and subscribe", "see you next time", "see you in the next video",
  "dont forget to subscribe", "music", "intro", "outro",
]);
function normLyric(s: string): string {
  return s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
// Cleaned sung lines (one per Whisper segment), junk dropped. Falls back to the
// raw transcript text if there are no usable segments.
function cleanLyricLines(data: LyricsData): string[] {
  const out: string[] = [];
  for (const seg of data.segments ?? []) {
    const text = (seg.text ?? "").trim();
    const n = normLyric(text);
    if (!n || LYRIC_JUNK.has(n)) continue;
    out.push(text);
  }
  if (!out.length && data.text && data.text.trim()) out.push(data.text.trim());
  return out;
}

export function createListMusicTool(manager: MusicManager, config: MantleConfig): Tool {
  return {
    name: "list_music",
    description:
      "Browse the shared music library — every track in the player, across ALL agents (yours and other agents'). " +
      "For each track: title, which agent made it, its folder, length, whether a generation prompt and/or lyrics " +
      "are on file, and a short style-prompt preview. Read-only. Use it to see what music exists before inspecting " +
      "a track with get_music_track or generating something in a similar vein. Filter to one agent with `agentId`, " +
      "or match titles with `search`.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description: "Only list this agent's tracks (their bucket id). Omit to list every agent's music.",
        },
        search: { type: "string", description: "Case-insensitive substring filter on the track title." },
      },
    },
    async execute(input, context) {
      const filterId = input.agentId ? String(input.agentId).trim() : undefined;
      const search = input.search ? String(input.search).trim().toLowerCase() : "";
      let tracks = manager.library(filterId);
      if (search) tracks = tracks.filter((t) => t.title.toLowerCase().includes(search));
      if (tracks.length === 0) {
        const where = filterId ? ` for agent "${filterId}"` : "";
        const filt = search ? ` matching "${search}"` : "";
        return { content: `No tracks${where}${filt}. The music library may be empty.` };
      }

      const byAgent = new Map<string, TrackInfo[]>();
      for (const t of tracks) {
        const arr = byAgent.get(t.agentId);
        if (arr) arr.push(t);
        else byAgent.set(t.agentId, [t]);
      }

      const self = context?.agentId;
      const out: string[] = [];
      for (const aid of [...byAgent.keys()].sort((a, b) => a.localeCompare(b))) {
        const list = byAgent.get(aid)!.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
        out.push(`## ${agentLabel(config, aid)}${aid === self ? " — you" : ""} (${list.length})`);
        for (const t of list) {
          const bits = [`"${t.title}"`];
          if (t.folder) bits.push(`(${t.folder}/)`);
          const dur = fmtDuration(t.meta?.durationSec);
          if (dur) bits.push(dur);
          bits.push([t.meta ? "prompt" : "no prompt", t.hasLyrics ? "lyrics" : null].filter(Boolean).join("+"));
          let line = `- ${bits.join(" · ")}`;
          if (t.meta?.style) line += `\n    ↳ ${truncate(t.meta.style, 120)}`;
          out.push(line);
        }
        out.push("");
      }
      out.push(`${tracks.length} track(s). Use get_music_track({ title }) to read a track's full style prompt.`);
      return { content: out.join("\n").trim() };
    },
  };
}

export function createGetMusicTrackTool(manager: MusicManager, config: MantleConfig): Tool {
  return {
    name: "get_music_track",
    description:
      "Look up one track in the music library and return its full details — most importantly the exact STYLE " +
      "PROMPT it was generated from (the creative recipe), plus model, instrumental/vocal, any lyrics, Suno's own " +
      "tags, length, and who made it. Read-only. Use it to study how a song was made — e.g. before generating " +
      "something in a similar style. Identify the track by `title`; if the same title exists under more than one " +
      "agent, narrow it with `agentId`.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The track title, as shown in list_music / the player." },
        agentId: { type: "string", description: "Which agent's bucket to look in. Omit to search every agent." },
      },
      required: ["title"],
    },
    async execute(input) {
      const title = String(input.title ?? "").trim();
      if (!title) return { content: "`title` is required.", isError: true };
      const filterId = input.agentId ? String(input.agentId).trim() : undefined;
      // One full-library scan: match the requested track AND let formatTrack
      // find its variations (which may be by any agent).
      const all = manager.library();
      const matches = all.filter(
        (t) => t.title.toLowerCase() === title.toLowerCase() && (!filterId || t.agentId === filterId),
      );
      if (matches.length === 0) {
        return {
          content: `No track titled "${title}"${filterId ? ` for agent "${filterId}"` : ""}. Use list_music to see what's available.`,
        };
      }
      if (matches.length > 1) {
        const lines = matches.map(
          (t) => `- "${t.title}" — agent "${t.agentId}"${t.folder ? `, folder ${t.folder}/` : ""}`,
        );
        return { content: `Several tracks are titled "${title}" — pass agentId to pick one:\n${lines.join("\n")}` };
      }
      return { content: formatTrack(matches[0]!, all, config) };
    },
  };
}

export function createGetMusicLyricsTool(manager: MusicManager, config: MantleConfig): Tool {
  return {
    name: "get_music_lyrics",
    description:
      "Read a track's saved karaoke lyrics, if it has any. Lyrics exist ONLY for tracks someone transcribed " +
      "(Whisper) via the player's CC button — instrumental or untranscribed tracks have none. The transcription " +
      "is approximate (it's machine-heard over instrumentation), so treat it as a best-effort reading. Read-only. " +
      "Identify the track by `title`; narrow with `agentId` if the same title exists under more than one agent.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "The track title, as shown in list_music / the player." },
        agentId: { type: "string", description: "Which agent's bucket to look in. Omit to search every agent." },
      },
      required: ["title"],
    },
    async execute(input) {
      const title = String(input.title ?? "").trim();
      if (!title) return { content: "`title` is required.", isError: true };
      const filterId = input.agentId ? String(input.agentId).trim() : undefined;
      const matches = manager.library(filterId).filter((t) => t.title.toLowerCase() === title.toLowerCase());
      if (matches.length === 0) {
        return { content: `No track titled "${title}"${filterId ? ` for agent "${filterId}"` : ""}. Use list_music to see what's available.` };
      }
      if (matches.length > 1) {
        const lines = matches.map((t) => `- "${t.title}" — agent "${t.agentId}"${t.folder ? `, folder ${t.folder}/` : ""}`);
        return { content: `Several tracks are titled "${title}" — pass agentId to pick one:\n${lines.join("\n")}` };
      }
      const track = matches[0]!;
      if (!track.hasLyrics) {
        const why = track.meta && track.meta.instrumental ? " (it was generated instrumental)" : "";
        return { content: `"${track.title}" has no lyrics on file${why} — transcribe it with the CC button in the player to create some.` };
      }
      const data = manager.readLyrics(track.agentId, track.relPath);
      if (!data) return { content: `Couldn't read the lyrics file for "${track.title}".`, isError: true };
      const lines = cleanLyricLines(data);
      if (!lines.length) {
        return { content: `"${track.title}" has a transcript but no usable lyric lines (Whisper likely found only instrumental noise).` };
      }
      const lang = data.language ? data.language.toUpperCase() : "?";
      return {
        content: `Lyrics for "${track.title}" — by ${agentLabel(config, track.agentId)} · Whisper transcription (${lang}, approximate)\n\n${lines.join("\n")}`,
      };
    },
  };
}
