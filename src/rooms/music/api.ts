import { join, relative, sep } from "path";
import {
  existsSync,
  statSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
} from "fs";
import type { MantleConfig } from "../../config/schema.js";
import type { MusicManager } from "./manager.js";
import type { VoiceManager } from "../../voice/manager.js";
import { sanitizeSegment, sanitizeFilename, resolveUnder, uniquePath } from "./paths.js";
import { metaPathFor, lyricsPathFor, coverPathFor, walkMp3, readMeta, SIDECAR_FOR } from "./metadata.js";

// ── /api/music/* — backs the music player ────────────────────────────────────
// Storage is one global tree at .mantle/music/<agentId>/<nested folders>/*.mp3.
// The top-level dir per agent is the "bucket" the player groups by; everything
// below is free-form user organization (create/rename/delete folders + move
// tracks). Generation is owned by MusicManager; this layer is the library +
// streaming surface. Every agent/user-supplied path is traversal-guarded under
// the music root.

interface Song {
  title: string;
  filename: string; // posix-style path relative to the agent bucket
  url: string;
  created_at: number; // epoch ms (file mtime)
  folder: string; // posix-style parent folder within the bucket ("" = root)
  hasLyrics: boolean; // a <stem>.lyrics.json karaoke transcript sits beside it
  hasPrompt: boolean; // a <stem>.meta.json generation record sits beside it
  hasCover: boolean; // a <stem>.cover.jpg album-art sidecar sits beside it
  parentTitle?: string; // lineage: the track this one was generated "in the vein of"
  parentAgentId?: string; // …and that parent's bucket, if it resolved
}

interface FolderNode {
  name: string;
  path: string; // posix-style, relative to the agent bucket ("" = root)
  fileCount: number; // direct .mp3 count
  totalFiles: number; // recursive .mp3 count
  children: FolderNode[];
  hasSubfolders: boolean;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const toPosix = (p: string): string => p.split(sep).join("/");

// Sidecars (foo.meta.json / foo.lyrics.json) travel with a track on
// rename/move/delete so they stay "attached". walkMp3 only scans *.mp3, so the
// sidecars never show up as tracks. Both helpers live in ../music/metadata.

// Split "<agentId>/<nested>/<file>" off a route prefix, decoding each segment.
function splitAgentRest(path: string, prefix: string): { agentId: string; rest: string } | null {
  if (!path.startsWith(prefix)) return null;
  const segs = path
    .slice(prefix.length)
    .split("/")
    .filter(Boolean)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  if (segs.length === 0) return null;
  const [agentId, ...rest] = segs;
  return { agentId: agentId!, rest: rest.join("/") };
}

// Resolve <agentId>/<rest> under the music root, rejecting traversal segments.
// Returns the absolute path or null if it escapes / is malformed.
function safePath(root: string, agentId: string, rest: string): string | null {
  const bucket = sanitizeSegment(agentId);
  const relSegs = rest ? rest.split("/").filter(Boolean) : [];
  if (relSegs.some((s) => s === ".." || s === ".")) return null;
  const rel = relSegs.length ? join(bucket, ...relSegs) : bucket;
  return resolveUnder(root, rel);
}

function buildFolderTree(dir: string, relPath = ""): FolderNode {
  const node: FolderNode = {
    name: relPath === "" ? "root" : relPath.split("/").pop()!,
    path: relPath,
    fileCount: 0,
    totalFiles: 0,
    children: [],
    hasSubfolders: false,
  };
  const subdirs: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) subdirs.push(entry.name);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp3")) node.fileCount++;
  }
  node.totalFiles = node.fileCount;
  for (const sub of subdirs.sort((a, b) => a.localeCompare(b))) {
    const childRel = relPath ? `${relPath}/${sub}` : sub;
    const child = buildFolderTree(join(dir, sub), childRel);
    node.children.push(child);
    node.totalFiles += child.totalFiles;
    node.hasSubfolders = true;
  }
  return node;
}

// Range-aware audio serving so the player can seek (HTTP 206 partial content).
function serveAudio(filePath: string, req: Request, downloadName?: string): Response {
  const size = statSync(filePath).size;
  const file = Bun.file(filePath);
  const headers: Record<string, string> = {
    "Content-Type": "audio/mpeg",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  if (downloadName) {
    headers["Content-Disposition"] = `attachment; filename="${downloadName.replace(/["\r\n]/g, "")}"`;
  }

  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  // `bytes=-` (both groups empty) is malformed — fall through to a full 200.
  if (m && (m[1] || m[2])) {
    let start: number;
    let end: number;
    if (!m[1]) {
      // Suffix range `bytes=-N` = the LAST N bytes (RFC 7233), not the first.
      const suffixLen = parseInt(m[2], 10);
      if (!Number.isFinite(suffixLen) || suffixLen === 0) {
        return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
      }
      start = Math.max(0, size - suffixLen);
      end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
    }
    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(file, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}

export async function handleMusicApi(
  req: Request,
  url: URL,
  config: MantleConfig,
  musicManager: MusicManager | undefined,
  voiceManager: VoiceManager | undefined,
  // WS broadcast, injected by the room (rooms never import src/server).
  broadcast: (msg: Record<string, unknown>) => void,
): Promise<Response> {
  const method = req.method;
  const path = url.pathname;
  const root = musicManager?.root ?? join(config.basePath, ".mantle", "music");
  mkdirSync(root, { recursive: true });

  // Bucket-creating routes (folder create, move, generate, upload) must name
  // a REAL agent — otherwise any authed caller mints arbitrary directories
  // under .mantle/music/. Read routes stay open (they 404 on missing files,
  // and may legitimately serve a since-removed agent's leftover bucket).
  const knownAgent = (id: string): boolean => config.agents.some((a) => a.id === id);

  // GET /api/music/tray — full library: songs + folder tree per agent bucket,
  // agent display metadata, and any in-flight generations.
  if (path === "/api/music/tray" && method === "GET") {
    const music: Record<string, Song[]> = {};
    const folderHierarchy: Record<string, FolderNode> = {};
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const agentId = entry.name;
      const dir = join(root, agentId);
      folderHierarchy[agentId] = buildFolderTree(dir);
      const songs: Song[] = [];
      for (const file of walkMp3(dir)) {
        const rel = toPosix(relative(dir, file));
        const slash = rel.lastIndexOf("/");
        const folder = slash === -1 ? "" : rel.slice(0, slash);
        const stem = (slash === -1 ? rel : rel.slice(slash + 1)).replace(/\.mp3$/i, "");
        const meta = readMeta(file); // also yields lineage (parentTitle/parentAgentId) for the UI
        songs.push({
          title: stem,
          filename: rel,
          url: `/api/music/stream/${encodeURIComponent(agentId)}/${rel.split("/").map(encodeURIComponent).join("/")}`,
          created_at: Math.floor(statSync(file).mtimeMs),
          folder,
          hasLyrics: existsSync(lyricsPathFor(file)),
          hasPrompt: !!meta,
          hasCover: existsSync(coverPathFor(file)),
          parentTitle: meta?.parentTitle,
          parentAgentId: meta?.parentAgentId,
        });
      }
      songs.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
      music[agentId] = songs;
    }
    return json({
      success: true,
      music,
      folderHierarchy,
      agents: config.agents.map((a) => ({ id: a.id, name: a.name, accentColor: a.accentColor ?? null })),
      generating: musicManager?.generating() ?? [],
      canGenerate: !!musicManager?.isEnabled(),
    });
  }

  // GET /api/music/stream/<agentId>/<path> — playback (range-aware).
  const stream = splitAgentRest(path, "/api/music/stream/");
  if (stream && method === "GET") {
    const abs = safePath(root, stream.agentId, stream.rest);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return json({ error: "Track not found" }, 404);
    return serveAudio(abs, req);
  }

  // GET /api/music/download/<agentId>/<path> — same bytes, attachment headers.
  const download = splitAgentRest(path, "/api/music/download/");
  if (download && method === "GET") {
    const abs = safePath(root, download.agentId, download.rest);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) return json({ error: "Track not found" }, 404);
    const name = abs.slice(abs.lastIndexOf(sep) + 1);
    return serveAudio(abs, req, name);
  }

  // DELETE /api/music/track/<agentId>/<path> — remove a track.
  const track = splitAgentRest(path, "/api/music/track/");
  if (track && method === "DELETE") {
    const abs = safePath(root, track.agentId, track.rest);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile() || !abs.toLowerCase().endsWith(".mp3")) {
      return json({ error: "Track not found or not an mp3" }, 404);
    }
    unlinkSync(abs);
    for (const sidecar of SIDECAR_FOR) { // drop the meta/lyrics/cover sidecars too
      const p = sidecar(abs);
      if (existsSync(p)) unlinkSync(p);
    }
    broadcast({ type: "music_changed", agentId: sanitizeSegment(track.agentId) });
    return json({ success: true });
  }

  // PATCH /api/music/track/<agentId>/<path> — rename a track. Body: { name }.
  // A track's display title IS its .mp3 stem (no metadata), so renaming = a
  // rename-in-place: keep the folder + extension, swap the stem. Mirrors the
  // folder-rename handler.
  const trackRename = splitAgentRest(path, "/api/music/track/");
  if (trackRename && method === "PATCH") {
    if (!trackRename.rest) return json({ error: "No track specified" }, 400);
    const abs = safePath(root, trackRename.agentId, trackRename.rest);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile() || !abs.toLowerCase().endsWith(".mp3")) {
      return json({ error: "Track not found or not an mp3" }, 404);
    }
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    const raw = (body.name ?? "").trim().replace(/\.mp3$/i, "").trim();
    if (!raw) return json({ error: "name is required" }, 400);
    const newStem = sanitizeFilename(raw);
    const parentRel = trackRename.rest.includes("/") ? trackRename.rest.slice(0, trackRename.rest.lastIndexOf("/")) : "";
    const destRel = parentRel ? `${parentRel}/${newStem}.mp3` : `${newStem}.mp3`;
    const dest = safePath(root, trackRename.agentId, destRel);
    if (!dest) return json({ error: "Invalid name" }, 400);
    if (existsSync(dest) && dest !== abs) return json({ error: "A track with that name already exists" }, 409);
    renameSync(abs, dest);
    for (const sidecar of SIDECAR_FOR) { // carry the meta/lyrics/cover sidecars
      const s = sidecar(abs);
      if (existsSync(s)) renameSync(s, sidecar(dest));
    }
    broadcast({ type: "music_changed", agentId: sanitizeSegment(trackRename.agentId) });
    return json({ success: true, path: toPosix(relative(join(root, sanitizeSegment(trackRename.agentId)), dest)) });
  }

  // POST /api/music/transcribe/<agentId>/<path> — karaoke transcription via the
  // voice sidecar's Whisper. Loads STT on demand if cold, REUSES it if the mic
  // or a prior transcribe already warmed it, and never auto-unloads (the mic
  // toggle owns turning STT off). Saves the word-timestamped transcript as a
  // <stem>.lyrics.json sidecar beside the mp3 and broadcasts so the tray flips
  // hasLyrics. Synchronous (a few–30s); the UI shows a transcribing state.
  const transcribeReq = splitAgentRest(path, "/api/music/transcribe/");
  if (transcribeReq && method === "POST") {
    const abs = safePath(root, transcribeReq.agentId, transcribeReq.rest);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile() || !abs.toLowerCase().endsWith(".mp3")) {
      return json({ error: "Track not found or not an mp3" }, 404);
    }
    if (!voiceManager || !voiceManager.isEnabled()) {
      return json({ error: "Voice features are disabled — can't transcribe (config.voice.enabled=false)." }, 503);
    }
    if (!voiceManager.isAlive()) {
      return json({ error: "Voice sidecar isn't running — can't transcribe. Check mantle logs." }, 503);
    }
    const client = voiceManager.getClient();
    try {
      // Load Whisper (STT) if it's cold; reuse it if warm. Don't pull TTS into VRAM.
      const st = await client.status();
      if (st.stt !== "loaded") {
        await client.load({ stt: true, tts: false });
        const after = await client.waitForLoaded({ needs: ["stt"] });
        if (after.stt !== "loaded") {
          return json({ error: `Whisper failed to load: ${after.stt_error ?? after.stt}` }, 502);
        }
      }
      const transcript = await client.transcribeSong({ path: abs });
      const payload = { ...transcript, model: "large-v3-turbo", transcribedAt: Date.now() };
      writeFileSync(lyricsPathFor(abs), JSON.stringify(payload, null, 2), "utf-8");
      broadcast({ type: "music_changed", agentId: sanitizeSegment(transcribeReq.agentId) });
      return json({ success: true, lyrics: payload });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // GET /api/music/lyrics/<agentId>/<path> — the saved karaoke transcript JSON.
  const lyricsReq = splitAgentRest(path, "/api/music/lyrics/");
  if (lyricsReq && method === "GET") {
    const abs = safePath(root, lyricsReq.agentId, lyricsReq.rest);
    if (!abs || !abs.toLowerCase().endsWith(".mp3")) return json({ error: "Bad track path" }, 400);
    const lp = lyricsPathFor(abs);
    if (!existsSync(lp)) return json({ error: "No lyrics for this track" }, 404);
    try {
      return json({ success: true, lyrics: JSON.parse(readFileSync(lp, "utf-8")) });
    } catch {
      return json({ error: "Lyrics file unreadable" }, 500);
    }
  }

  // GET /api/music/meta/<agentId>/<path> — the saved generation record (the
  // style prompt + params the track was made from). 404 when none is on file
  // (an uploaded track, or one made before prompts were saved). Backs the
  // player's prompt panel; the read tools go through MusicManager.library().
  const metaReq = splitAgentRest(path, "/api/music/meta/");
  if (metaReq && method === "GET") {
    const abs = safePath(root, metaReq.agentId, metaReq.rest);
    if (!abs || !abs.toLowerCase().endsWith(".mp3")) return json({ error: "Bad track path" }, 400);
    const mp = metaPathFor(abs);
    if (!existsSync(mp)) return json({ error: "No generation prompt on file for this track" }, 404);
    try {
      return json({ success: true, meta: JSON.parse(readFileSync(mp, "utf-8")) });
    } catch {
      return json({ error: "Metadata file unreadable" }, 500);
    }
  }

  // GET /api/music/cover/<agentId>/<path> — album art (Suno's imageUrl), saved
  // as a .cover.jpg sidecar. 404 when none on file (uploaded/old track, or a
  // generation Suno returned no art for). Served as image/jpeg.
  const coverReq = splitAgentRest(path, "/api/music/cover/");
  if (coverReq && method === "GET") {
    const abs = safePath(root, coverReq.agentId, coverReq.rest);
    if (!abs || !abs.toLowerCase().endsWith(".mp3")) return json({ error: "Bad track path" }, 400);
    const cp = coverPathFor(abs);
    if (!existsSync(cp)) return json({ error: "No cover for this track" }, 404);
    return new Response(Bun.file(cp), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // POST /api/music/folders — create a folder. Body: { agentId, parent?, name }.
  if (path === "/api/music/folders" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { agentId?: string; parent?: string; name?: string };
    const agentId = (body.agentId ?? "").trim();
    const name = sanitizeSegment(body.name ?? "");
    if (!agentId) return json({ error: "agentId is required" }, 400);
    if (!knownAgent(agentId)) return json({ error: `Unknown agent: ${agentId}` }, 400);
    if (!name) return json({ error: "name is required" }, 400);
    const parentRel = (body.parent ?? "").trim();
    const targetRel = parentRel ? `${parentRel}/${name}` : name;
    const abs = safePath(root, agentId, targetRel);
    if (!abs) return json({ error: "Invalid path" }, 400);
    if (existsSync(abs)) return json({ error: "Folder already exists" }, 409);
    mkdirSync(abs, { recursive: true });
    broadcast({ type: "music_changed", agentId: sanitizeSegment(agentId) });
    return json({ success: true, path: toPosix(relative(join(root, sanitizeSegment(agentId)), abs)) });
  }

  // DELETE /api/music/folders/<agentId>/<path> — remove a folder (recursive).
  const folderDel = splitAgentRest(path, "/api/music/folders/");
  if (folderDel && method === "DELETE") {
    const abs = safePath(root, folderDel.agentId, folderDel.rest);
    if (!abs || !existsSync(abs) || !statSync(abs).isDirectory()) return json({ error: "Folder not found" }, 404);
    // Guard against nuking a whole agent bucket via an empty rest.
    if (!folderDel.rest) return json({ error: "Refusing to delete the agent bucket root" }, 400);
    rmSync(abs, { recursive: true, force: true });
    broadcast({ type: "music_changed", agentId: sanitizeSegment(folderDel.agentId) });
    return json({ success: true });
  }

  // PATCH /api/music/folders/<agentId>/<path> — rename a folder. Body: { name }.
  const folderRename = splitAgentRest(path, "/api/music/folders/");
  if (folderRename && method === "PATCH") {
    if (!folderRename.rest) return json({ error: "No folder specified" }, 400);
    const body = (await req.json().catch(() => ({}))) as { name?: string };
    const newName = sanitizeSegment(body.name ?? "");
    if (!newName) return json({ error: "name is required" }, 400);
    const abs = safePath(root, folderRename.agentId, folderRename.rest);
    if (!abs || !existsSync(abs) || !statSync(abs).isDirectory()) return json({ error: "Folder not found" }, 404);
    const parentRel = folderRename.rest.includes("/") ? folderRename.rest.slice(0, folderRename.rest.lastIndexOf("/")) : "";
    const destRel = parentRel ? `${parentRel}/${newName}` : newName;
    const dest = safePath(root, folderRename.agentId, destRel);
    if (!dest) return json({ error: "Invalid name" }, 400);
    if (existsSync(dest) && dest !== abs) return json({ error: "A folder with that name already exists" }, 409);
    renameSync(abs, dest);
    broadcast({ type: "music_changed", agentId: sanitizeSegment(folderRename.agentId) });
    return json({ success: true, path: toPosix(relative(join(root, sanitizeSegment(folderRename.agentId)), dest)) });
  }

  // PATCH /api/music/move — move a track/folder. Body: { agentId, source, target }.
  // source = rel path within the bucket; target = destination folder ("" = root).
  if (path === "/api/music/move" && method === "PATCH") {
    const body = (await req.json().catch(() => ({}))) as { agentId?: string; source?: string; target?: string };
    const agentId = (body.agentId ?? "").trim();
    const source = (body.source ?? "").trim();
    if (!agentId || !source) return json({ error: "agentId and source are required" }, 400);
    if (!knownAgent(agentId)) return json({ error: `Unknown agent: ${agentId}` }, 400);
    const srcAbs = safePath(root, agentId, source);
    if (!srcAbs || !existsSync(srcAbs)) return json({ error: "Source not found" }, 404);
    const targetRel = (body.target ?? "").trim();
    const targetDir = safePath(root, agentId, targetRel);
    if (!targetDir) return json({ error: "Invalid target" }, 400);
    mkdirSync(targetDir, { recursive: true });
    const base = srcAbs.slice(srcAbs.lastIndexOf(sep) + 1);
    let destAbs = join(targetDir, base);
    if (destAbs === srcAbs) return json({ success: true, path: toPosix(relative(join(root, sanitizeSegment(agentId)), destAbs)) });
    // Conflict resolution: append _1, _2, ... before any extension.
    if (existsSync(destAbs)) {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      let n = 1;
      while (existsSync(destAbs)) {
        destAbs = join(targetDir, `${stem}_${n}${ext}`);
        n++;
      }
    }
    renameSync(srcAbs, destAbs);
    if (srcAbs.toLowerCase().endsWith(".mp3")) { // carry the meta/lyrics/cover sidecars
      for (const sidecar of SIDECAR_FOR) {
        const s = sidecar(srcAbs);
        if (existsSync(s)) renameSync(s, sidecar(destAbs));
      }
    }
    broadcast({ type: "music_changed", agentId: sanitizeSegment(agentId) });
    return json({ success: true, path: toPosix(relative(join(root, sanitizeSegment(agentId)), destAbs)) });
  }

  // POST /api/music/generate — kick off a generation from the UI. Body:
  // { agentId, style, title, instrumental?, lyrics?, model? }.
  if (path === "/api/music/generate" && method === "POST") {
    if (!musicManager?.isEnabled()) {
      return json({ error: "Music generation isn't configured (set KIE_API_KEY)." }, 503);
    }
    const body = (await req.json().catch(() => ({}))) as {
      agentId?: string;
      style?: string;
      title?: string;
      instrumental?: boolean;
      lyrics?: string;
      model?: string;
      basedOn?: string;
      basedOnAgentId?: string;
    };
    const agentId = (body.agentId ?? "").trim();
    const style = (body.style ?? "").trim();
    const title = (body.title ?? "").trim();
    if (!agentId) return json({ error: "agentId is required" }, 400);
    if (!knownAgent(agentId)) return json({ error: `Unknown agent: ${agentId}` }, 400);
    if (!style) return json({ error: "style is required" }, 400);
    if (!title) return json({ error: "title is required" }, 400);
    const instrumental = body.instrumental === undefined ? true : !!body.instrumental;
    if (!instrumental && !body.lyrics) return json({ error: "lyrics required for a vocal track" }, 400);
    try {
      const { taskId } = await musicManager.generate({
        agentId,
        style,
        title,
        instrumental,
        lyrics: body.lyrics,
        model: body.model,
        basedOn: body.basedOn,
        basedOnAgentId: body.basedOnAgentId,
      });
      return json({ success: true, taskId });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // POST /api/music/upload — drop an mp3 straight into a bucket/folder, as if
  // it had been generated there. Multipart form: { agentId, folder?, file }.
  if (path === "/api/music/upload" && method === "POST") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "Expected multipart form data" }, 400);
    }
    const agentId = String(form.get("agentId") ?? "").trim();
    const folder = String(form.get("folder") ?? "").trim();
    const file = form.get("file");
    if (!agentId) return json({ error: "agentId is required" }, 400);
    if (!knownAgent(agentId)) return json({ error: `Unknown agent: ${agentId}` }, 400);
    if (!(file instanceof File)) return json({ error: "file is required" }, 400);
    const name = file.name || "upload.mp3";
    const isMp3 = name.toLowerCase().endsWith(".mp3") || file.type === "audio/mpeg" || file.type === "audio/mp3";
    if (!isMp3) return json({ error: "Only .mp3 files are supported" }, 415);
    const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
    if (file.size > MAX_UPLOAD_BYTES) return json({ error: "File too large (50MB max)" }, 413);
    const targetDir = safePath(root, agentId, folder);
    if (!targetDir) return json({ error: "Invalid folder" }, 400);
    mkdirSync(targetDir, { recursive: true });
    const stem = sanitizeFilename(name.replace(/\.mp3$/i, ""));
    const dest = uniquePath(targetDir, stem, ".mp3");
    try {
      writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
    broadcast({ type: "music_changed", agentId: sanitizeSegment(agentId) });
    return json({ success: true, path: toPosix(relative(join(root, sanitizeSegment(agentId)), dest)) });
  }

  return json({ error: `Unknown music route: ${method} ${path}` }, 404);
}
