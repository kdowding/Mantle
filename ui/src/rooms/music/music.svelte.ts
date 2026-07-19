// Music room — state + audio engine + library REST + WS registration. Port of
// ui/music.js (the vanilla player). Plays mp3s served from
// /api/music/stream/<agentId>/<path>, organized as a global library subdivided
// by the agent that generated each track. Tracks appear silently when the
// background poller finishes a generation and broadcasts `music_changed`;
// the room claims music_* off the ws.ts seam.
//
// Reactive state lives in `music`; the <audio> element + Web Audio analyser
// graph and the decoded-peaks cache are module-level NON-reactive (the rAF
// drawing loop in NowPlaying reads them through getters each frame).
import { lsGet, lsSet } from '../../lib/storage';
import { onWsEvent } from '../../lib/ws';
import type { LyricsData } from './lyrics';
import { computePeaks, VIZ_MODES, type VizMode } from './viz';

export interface Song {
  title: string;
  filename: string; // posix-style path relative to the agent bucket
  url: string;
  created_at: number;
  folder: string; // parent folder within the bucket ("" = root)
  hasLyrics: boolean;
  hasPrompt: boolean;
  hasCover: boolean;
  parentTitle?: string; // lineage: the track this one was generated "in the vein of"
  parentAgentId?: string;
  agentId: string; // stamped client-side from the tray bucket
}

export interface FolderNode {
  name: string;
  path: string; // relative to the agent bucket ("" = root)
  fileCount: number;
  totalFiles: number;
  children: FolderNode[];
  hasSubfolders: boolean;
}

export interface GenJob {
  agentId: string;
  title: string;
  taskId?: string;
}

export interface MusicAgent {
  id: string;
  name: string;
  accentColor?: string;
}

// A track's saved generation recipe (<stem>.meta.json). Only generated tracks
// have one; uploads 404.
export interface TrackMeta {
  model?: string;
  instrumental?: boolean;
  durationSec?: number;
  generatedAt?: string | number;
  style?: string;
  tags?: string;
  lyrics?: string;
  parentTitle?: string;
  parentAgentId?: string;
}

const LS = {
  volume: 'mantle-music-volume',
  repeat: 'mantle-music-repeat',
  loopAll: 'mantle-music-loop-all',
  shuffle: 'mantle-music-shuffle',
  scope: 'mantle-music-scope',
  open: 'mantle-music-open',
  expanded: 'mantle-music-expanded',
  viz: 'mantle-music-viz',
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.8));
}

// Same wire format as the vanilla UI (an array of `key` open / `"!"+key`
// collapsed overrides), so the user's expansion state carries over the cutover.
function loadExpanded(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  try {
    const arr = JSON.parse(lsGet(LS.expanded) ?? '[]') as unknown;
    if (Array.isArray(arr)) {
      for (const k of arr) {
        if (typeof k !== 'string') continue;
        if (k.startsWith('!')) out[k.slice(1)] = false;
        else out[k] = true;
      }
    }
  } catch { /* fresh default */ }
  return out;
}

function saveExpanded(): void {
  const entries = Object.entries(music.expanded).map(([k, open]) => (open ? k : `!${k}`));
  lsSet(LS.expanded, JSON.stringify(entries));
}

function loadViz(): VizMode {
  const v = lsGet(LS.viz) ?? 'bars';
  return (VIZ_MODES as readonly string[]).includes(v) ? (v as VizMode) : 'bars';
}

export const music = $state({
  // tray
  library: {} as Record<string, Song[]>,
  folderHierarchy: {} as Record<string, FolderNode>,
  agents: [] as MusicAgent[],
  generating: [] as GenJob[],
  canGenerate: false,
  loaded: false,

  // playback
  current: null as Song | null,
  isPlaying: false,
  progress: 0,
  duration: 0,
  activeBucket: null as string | null, // agent bucket the current queue is scoped to

  // prefs (persisted, same keys as the vanilla player)
  volume: clamp01(parseFloat(lsGet(LS.volume) ?? '0.8') || 0.8),
  repeat: lsGet(LS.repeat) === 'true',
  loopAll: lsGet(LS.loopAll) === 'true', // no UI toggle (parity) — honored by handleEnded
  shuffle: lsGet(LS.shuffle) === 'true',
  scope: (lsGet(LS.scope) === 'current' ? 'current' : 'all') as 'all' | 'current',
  vizMode: loadViz(),

  // ui
  open: lsGet(LS.open) === 'true',
  expanded: loadExpanded(), // bucket/folder overrides; absent = the node's default
  search: '',
  genFormOpen: false,
  dragged: null as { agentId: string; filename: string } | null,
  transcribing: {} as Record<string, boolean>, // trKey → karaoke transcribe in flight
  toast: '',

  // inspect panels (one of each; opening replaces)
  lyricsPanel: null as { song: Song; data: LyricsData } | null,
  promptPanel: null as { song: Song; meta: TrackMeta } | null,
});

// ── Audio engine (module-level; the analyser graph needs a user gesture) ────
let audio: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;

function initAudio(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = music.volume;
  audio.addEventListener('timeupdate', () => { music.progress = audio!.currentTime || 0; });
  audio.addEventListener('loadedmetadata', () => { music.duration = audio!.duration || 0; });
  audio.addEventListener('play', () => { music.isPlaying = true; });
  audio.addEventListener('pause', () => { music.isPlaying = false; });
  audio.addEventListener('ended', handleEnded);
  audio.addEventListener('error', () => { music.isPlaying = false; });
  return audio;
}

// Web Audio graph for the visualizer — built on first play (user gesture).
function ensureGraph(): void {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return;
  }
  if (!audio) return;
  try {
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -10;
    const sourceNode = audioCtx.createMediaElementSource(audio);
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  } catch (err) {
    console.warn('[music] Web Audio setup failed:', err);
  }
}

// Per-frame reads for the rAF loops (never reactive).
export function getAnalyser(): AnalyserNode | null { return analyser; }
export function getAudioTime(): number { return audio?.currentTime ?? 0; }

// ── Peaks (decoded waveform bars for the scrubber) ───────────────────────────
// Decoding the whole mp3 is the cost; cache per track so re-selecting is instant.
const peaksCache = new Map<string, number[]>();
let currentPeaks: number[] | null = null;

export function getCurrentPeaks(): number[] | null { return currentPeaks; }

async function loadPeaks(song: Song): Promise<void> {
  const key = trKey(song);
  if (peaksCache.has(key)) { currentPeaks = peaksCache.get(key)!; return; }
  currentPeaks = null; // placeholder until the decode lands
  try {
    if (!audioCtx) ensureGraph();
    if (!audioCtx) return;
    const buf = await (await fetch(song.url)).arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(buf);
    const peaks = computePeaks(decoded, 140);
    peaksCache.set(key, peaks);
    if (music.current && sameSong(music.current, song)) currentPeaks = peaks;
  } catch (err) {
    console.warn('[music] peak decode failed:', err);
  }
}

// ── Queue + transport ────────────────────────────────────────────────────────
export function sameSong(a: Song | null, b: Song | null): boolean {
  return !!a && !!b && a.agentId === b.agentId && a.filename === b.filename;
}

export function trKey(song: Song): string {
  return `${song.agentId} ${song.filename}`;
}

// Respect the search filter so next/prev walk what the user actually sees.
export function searchQuery(): string {
  return music.search.trim().toLowerCase();
}

export function filterList(songs: Song[]): Song[] {
  const q = searchQuery();
  if (!q) return songs;
  return songs.filter((s) => s.title.toLowerCase().includes(q));
}

function buildQueue(): Song[] {
  if (music.scope === 'current' && music.activeBucket && music.library[music.activeBucket]) {
    return filterList(music.library[music.activeBucket]);
  }
  return Object.keys(music.library)
    .sort()
    .flatMap((aid) => filterList(music.library[aid] ?? []));
}

export function playSong(song: Song): void {
  const a = initAudio();
  ensureGraph();
  a.src = song.url;
  a.load();
  a.play().catch(() => {});
  music.current = song;
  music.activeBucket = song.agentId;
  music.progress = 0;
  music.duration = 0;
  void loadPeaks(song);
}

export function togglePlay(): void {
  if (!audio || !music.current) {
    const q = buildQueue();
    if (q[0]) playSong(q[0]);
    return;
  }
  if (audio.paused) { ensureGraph(); audio.play().catch(() => {}); }
  else audio.pause();
}

function handleEnded(): void {
  if (music.repeat && audio) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (music.loopAll || music.shuffle) { nextSong(); return; }
  music.isPlaying = false;
}

export function nextSong(): void {
  const q = buildQueue();
  if (!q.length) return;
  if (music.shuffle) { playSong(q[Math.floor(Math.random() * q.length)]); return; }
  const i = music.current ? q.findIndex((s) => sameSong(s, music.current)) : -1;
  playSong(q[(i + 1) % q.length]);
}

export function prevSong(): void {
  if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
  const q = buildQueue();
  if (!q.length) return;
  const i = music.current ? q.findIndex((s) => sameSong(s, music.current)) : 0;
  playSong(q[(i - 1 + q.length) % q.length]);
}

export function seekTo(ratio: number): void {
  if (audio && music.duration) audio.currentTime = clamp01(ratio) * music.duration;
}

export function setVolume(v: number): void {
  music.volume = clamp01(v);
  if (audio) audio.volume = music.volume;
  lsSet(LS.volume, String(music.volume));
}

export function toggleShuffle(): void { music.shuffle = !music.shuffle; lsSet(LS.shuffle, String(music.shuffle)); }
export function toggleRepeat(): void { music.repeat = !music.repeat; lsSet(LS.repeat, String(music.repeat)); }
export function toggleScope(): void { music.scope = music.scope === 'all' ? 'current' : 'all'; lsSet(LS.scope, music.scope); }

export function cycleViz(): void {
  const i = VIZ_MODES.indexOf(music.vizMode);
  music.vizMode = VIZ_MODES[(i + 1) % VIZ_MODES.length];
  lsSet(LS.viz, music.vizMode);
}

export function setOpen(open: boolean): void {
  music.open = open;
  lsSet(LS.open, String(open));
  if (open && !music.loaded) void fetchTray();
}

// ── Expansion (buckets default open, folders default closed) ────────────────
export function bucketKey(aid: string): string { return `${aid} `; }
export function folderKey(aid: string, path: string): string { return `${aid} ${path}`; }

export function isExpanded(key: string, defaultOpen: boolean): boolean {
  return music.expanded[key] ?? defaultOpen;
}

export function setExpanded(key: string, open: boolean, defaultOpen: boolean): void {
  if (open === defaultOpen) delete music.expanded[key];
  else music.expanded[key] = open;
  saveExpanded();
}

// ── Tray + helpers ───────────────────────────────────────────────────────────
export function agentName(aid: string): string {
  return music.agents.find((a) => a.id === aid)?.name ?? aid;
}

export function agentAccent(aid: string): string {
  return music.agents.find((a) => a.id === aid)?.accentColor ?? '';
}

export function streamPath(agentId: string, rel: string): string {
  return `${encodeURIComponent(agentId)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function coverUrl(song: Song): string {
  return `/api/music/cover/${streamPath(song.agentId, song.filename)}`;
}

export function downloadUrl(song: Song): string {
  return `/api/music/download/${streamPath(song.agentId, song.filename)}`;
}

export function fmtTime(s: number): string {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

interface TrayPayload {
  success?: boolean;
  music?: Record<string, Omit<Song, 'agentId'>[]>;
  folderHierarchy?: Record<string, FolderNode>;
  agents?: MusicAgent[];
  generating?: GenJob[];
  canGenerate?: boolean;
}

export async function fetchTray(): Promise<boolean> {
  try {
    const res = await fetch('/api/music/tray', { headers: { Accept: 'application/json' } });
    if (!res.ok) return false;
    const data = (await res.json()) as TrayPayload;
    if (!data || !data.success) return false;
    // Don't clobber a populated library with an empty payload from a blip.
    const hadMusic = Object.keys(music.library).length > 0;
    const incomingEmpty = !data.music || Object.keys(data.music).length === 0;
    if (!(hadMusic && incomingEmpty)) {
      // Stamp each song with its agent bucket for queue/playback bookkeeping.
      const lib: Record<string, Song[]> = {};
      for (const [aid, songs] of Object.entries(data.music ?? {})) {
        lib[aid] = (songs ?? []).map((s) => ({ ...s, agentId: aid }));
      }
      music.library = lib;
      music.folderHierarchy = data.folderHierarchy ?? {};
    }
    music.agents = Array.isArray(data.agents) ? data.agents : [];
    music.generating = Array.isArray(data.generating) ? data.generating : [];
    music.canGenerate = !!data.canGenerate;
    music.loaded = true;
    reconcileCurrent();
    return true;
  } catch (err) {
    console.warn('[music] tray fetch failed:', err);
    return false;
  }
}

// If the current track vanished (deleted/moved), keep the object so the
// now-playing strip still shows it; playback continues off the live <audio>.
// Moved: re-link by title so the active highlight still lands.
function reconcileCurrent(): void {
  if (!music.current) return;
  const list = music.library[music.current.agentId];
  if (list && list.some((s) => sameSong(s, music.current))) return;
  if (list) {
    const byTitle = list.find((s) => s.title === music.current!.title);
    if (byTitle) music.current = { ...byTitle };
  }
}

// ── REST mutations (each refetches the tray; errors → toast) ────────────────
let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function showError(msg: string): void {
  music.toast = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { music.toast = ''; }, 4200);
}

async function api<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `${method} ${url} → ${res.status}`);
  return json;
}

async function mutate(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    await fetchTray();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

export function deleteTrack(song: Song): Promise<void> {
  return mutate(() => api('DELETE', `/api/music/track/${streamPath(song.agentId, song.filename)}`));
}
export function renameTrack(song: Song, name: string): Promise<void> {
  return mutate(() => api('PATCH', `/api/music/track/${streamPath(song.agentId, song.filename)}`, { name }));
}
export function moveTrack(agentId: string, source: string, target: string): Promise<void> {
  return mutate(() => api('PATCH', '/api/music/move', { agentId, source, target }));
}
export function createFolder(agentId: string, parent: string, name: string): Promise<void> {
  return mutate(() => api('POST', '/api/music/folders', { agentId, parent, name }));
}
export function renameFolder(agentId: string, folderPath: string, name: string): Promise<void> {
  return mutate(() => api('PATCH', `/api/music/folders/${streamPath(agentId, folderPath)}`, { name }));
}
export function deleteFolder(agentId: string, folderPath: string): Promise<void> {
  return mutate(() => api('DELETE', `/api/music/folders/${streamPath(agentId, folderPath)}`));
}

// ── Upload (mp3s straight into a bucket/folder, like a generated track) ─────
// One persistent, DOM-attached file input (MusicRail registers it) — a
// per-click createElement('input') has ~30s file-dialog lag in Chromium on
// Windows.
let uploadInputEl: HTMLInputElement | null = null;
let uploadTarget: { agentId: string; folder: string } | null = null;

export function registerUploadInput(el: HTMLInputElement | null): void {
  uploadInputEl = el;
}

export function triggerUpload(agentId: string, folder: string): void {
  if (!uploadInputEl) return;
  uploadTarget = { agentId, folder };
  uploadInputEl.value = ''; // reset so re-picking the same file still fires change
  uploadInputEl.click();
}

export async function onUploadPicked(): Promise<void> {
  const files = [...(uploadInputEl?.files ?? [])];
  if (!files.length || !uploadTarget) return;
  const { agentId, folder } = uploadTarget;
  for (const f of files) {
    try {
      const fd = new FormData();
      fd.append('agentId', agentId);
      fd.append('folder', folder);
      fd.append('file', f);
      const res = await fetch('/api/music/upload', { method: 'POST', body: fd });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? `upload failed (${res.status})`);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  }
  await fetchTray();
}

// ── Generation ───────────────────────────────────────────────────────────────
export interface GenerateParams {
  agentId: string;
  title: string;
  style: string;
  instrumental: boolean;
  lyrics?: string;
  basedOn?: string;
  basedOnAgentId?: string;
}

// Throws on failure — the form surfaces the message inline.
export async function generateTrack(params: GenerateParams): Promise<void> {
  await api('POST', '/api/music/generate', params);
  await fetchTray();
}

// ── Karaoke + prompt inspect panels ──────────────────────────────────────────
export async function transcribeTrack(song: Song): Promise<void> {
  const key = trKey(song);
  music.transcribing[key] = true;
  try {
    const res = await api<{ lyrics?: LyricsData }>('POST', `/api/music/transcribe/${streamPath(song.agentId, song.filename)}`);
    delete music.transcribing[key];
    await fetchTray(); // refresh hasLyrics on the tray
    if (res.lyrics) music.lyricsPanel = { song, data: res.lyrics }; // open for review
  } catch (err) {
    delete music.transcribing[key];
    showError(err instanceof Error ? err.message : String(err));
  }
}

export async function viewLyrics(song: Song): Promise<void> {
  try {
    const res = await api<{ lyrics: LyricsData }>('GET', `/api/music/lyrics/${streamPath(song.agentId, song.filename)}`);
    music.lyricsPanel = { song, data: res.lyrics };
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

export async function viewPrompt(song: Song): Promise<void> {
  try {
    const res = await api<{ meta: TrackMeta }>('GET', `/api/music/meta/${streamPath(song.agentId, song.filename)}`);
    if (res.meta) music.promptPanel = { song, meta: res.meta };
  } catch {
    showError('No generation prompt saved for this track.');
  }
}

// Tracks generated "in the vein of" `song` — the tray's child→parent edges.
export function childrenOf(song: Song): Song[] {
  const t = song.title.toLowerCase();
  const out: Song[] = [];
  for (const list of Object.values(music.library)) {
    for (const s of list ?? []) {
      if (s.parentTitle && s.parentTitle.toLowerCase() === t &&
          (!s.parentAgentId || s.parentAgentId === song.agentId) &&
          !(s.agentId === song.agentId && s.filename === song.filename)) {
        out.push(s);
      }
    }
  }
  return out;
}

// Open the prompt panel for another track in the lineage (walks the tree).
export function jumpToTrack(agentId: string, title: string): void {
  const inAgent = (music.library[agentId] ?? []).find((s) => s.title === title);
  const song = inAgent ?? Object.values(music.library).flat().find((s) => s.title === title);
  if (song) void viewPrompt(song);
  else showError(`"${title}" not found - it may have been renamed or removed.`);
}

// ── WS registration (music_changed / music_error broadcasts) ────────────────
let refetchPending = false;

export function registerMusicWs(): () => void {
  return onWsEvent('music_', (ev) => {
    if (ev.type === 'music_error') {
      console.warn(`[music] generation failed for ${String(ev.agentId)}: ${String(ev.reason)}`);
    }
    if (refetchPending) return;
    refetchPending = true;
    setTimeout(() => {
      refetchPending = false;
      void fetchTray();
    }, 400);
  });
}
