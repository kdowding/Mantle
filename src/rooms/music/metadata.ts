import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

// Per-track sidecars + the shared mp3 walker. Two sidecar kinds live beside a
// track's mp3 and travel with it (rename/move/delete carry them):
//   foo.mp3 → foo.meta.json    generation prompt + params (this module)
//   foo.mp3 → foo.lyrics.json  karaoke transcript (written by api-music)
// Co-located here so the MusicManager (writes meta on download, scans for the
// read tools) and the /api/music layer (carries + serves both) share one
// implementation instead of each redefining the path math.

// What a track was generated FROM — persisted so agents (and the player) can
// study the exact recipe behind a song, e.g. to make something in a similar
// vein. Uploaded or pre-prompt-saving tracks simply have no sidecar; callers
// degrade to "no prompt on file".
export interface MusicMeta {
  // The Suno style prompt — the whole creative lever (genre/mood/instruments/…).
  style: string;
  // Title requested at generation time.
  title: string;
  // Instrumental (no vocals) vs a vocal/lyrics track.
  instrumental: boolean;
  // Exact lyrics, only present for vocal tracks.
  lyrics?: string;
  // Resolved Suno model id (e.g. "V5_5").
  model: string;
  // kie.ai task that produced the track.
  taskId: string;
  // Agent that generated it (the bucket it landed in).
  agentId: string;
  // When it finished generating (epoch ms).
  generatedAt: number;
  // Per-track facts echoed back by Suno (best-effort — may be absent).
  sunoId?: string;
  tags?: string;
  durationSec?: number;
  // Lineage: the track this one was generated "in the vein of", if any — set
  // when generate_music / the UI form passes `basedOn`. parentAgentId is filled
  // when the named track resolves in the library (cross-agent is allowed). The
  // child→parent edge is the single source of truth; "variations of X" are
  // derived by scanning for children that point back at X.
  parentTitle?: string;
  parentAgentId?: string;
}

// foo.mp3 → foo.meta.json (generation prompt + params).
export function metaPathFor(mp3Abs: string): string {
  return mp3Abs.replace(/\.mp3$/i, ".meta.json");
}

// foo.mp3 → foo.lyrics.json (karaoke transcript).
export function lyricsPathFor(mp3Abs: string): string {
  return mp3Abs.replace(/\.mp3$/i, ".lyrics.json");
}

// foo.mp3 → foo.cover.jpg (album art from Suno's imageUrl). Always saved as
// .jpg + served as image/jpeg — Suno cover art is jpeg.
export function coverPathFor(mp3Abs: string): string {
  return mp3Abs.replace(/\.mp3$/i, ".cover.jpg");
}

// Every sidecar-path deriver for a track. Carry these on rename/move and drop
// them on delete so a track's metadata, lyrics, and cover stay attached. Add a
// new sidecar kind here and the API carries it everywhere for free.
export const SIDECAR_FOR: ReadonlyArray<(mp3Abs: string) => string> = [metaPathFor, lyricsPathFor, coverPathFor];

export function writeMeta(mp3Abs: string, meta: MusicMeta): void {
  writeFileSync(metaPathFor(mp3Abs), JSON.stringify(meta, null, 2), "utf-8");
}

// The generation metadata for a track, or null if none on file / unreadable.
export function readMeta(mp3Abs: string): MusicMeta | null {
  const p = metaPathFor(mp3Abs);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as MusicMeta;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Recursively yield every .mp3 under `dir` (absolute paths). Skips dotfiles and
// the .meta.json / .lyrics.json sidecars (only *.mp3 is matched). Tolerant of a
// missing/unreadable directory so callers don't have to guard.
export function* walkMp3(dir: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkMp3(full);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp3")) {
      yield full;
    }
  }
}
