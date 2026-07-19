import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, statSync, readdirSync, unlinkSync } from "fs";
import { dirname } from "path";
import type { CronRunLogEntry } from "./types.js";

// Error/summary strings come from provider failures and model output —
// both unbounded. Cap them at append so a single pathological run can't
// bloat a log line into the megabytes (the pruner keeps line COUNT
// bounded; these keep line SIZE bounded).
const MAX_ERROR_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 1_000;

export class CronRunLog {
  private baseDir: string;
  private maxBytes: number;
  private keepLines: number;
  // Parsed-entry cache keyed by file path, invalidated by mtime+size.
  // readAll() re-read + re-parsed EVERY job's JSONL on every API hit;
  // run logs only change on append, so stat-checking is almost always a
  // cache hit. Entries are stored oldest-first and treated as immutable.
  private parseCache = new Map<string, { mtimeMs: number; size: number; entries: CronRunLogEntry[] }>();

  constructor(baseDir: string, maxBytes: number = 2_000_000, keepLines: number = 2_000) {
    this.baseDir = baseDir;
    this.maxBytes = maxBytes;
    this.keepLines = keepLines;

    if (!existsSync(baseDir)) {
      mkdirSync(baseDir, { recursive: true });
    }
  }

  private logPath(jobId: string): string {
    return `${this.baseDir}/${jobId}.jsonl`;
  }

  append(entry: CronRunLogEntry): void {
    const filePath = this.logPath(entry.jobId);
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const bounded: CronRunLogEntry = {
      ...entry,
      error: entry.error && entry.error.length > MAX_ERROR_CHARS
        ? entry.error.slice(0, MAX_ERROR_CHARS) + "…[truncated]"
        : entry.error,
      summary: entry.summary && entry.summary.length > MAX_SUMMARY_CHARS
        ? entry.summary.slice(0, MAX_SUMMARY_CHARS) + "…[truncated]"
        : entry.summary,
    };
    appendFileSync(filePath, JSON.stringify(bounded) + "\n", "utf-8");

    // Prune if needed
    this.pruneIfNeeded(filePath);
  }

  // Load a job's entries (oldest-first) through the stat cache. The
  // returned array is the CACHED array — callers must copy before
  // mutating (read() does).
  private loadEntries(filePath: string): CronRunLogEntry[] {
    if (!existsSync(filePath)) return [];
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return [];
    }
    const cached = this.parseCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.entries;
    }

    const raw = readFileSync(filePath, "utf-8");
    const entries: CronRunLogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
    this.parseCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
    return entries;
  }

  read(jobId: string, opts?: { limit?: number; offset?: number; status?: string }): CronRunLogEntry[] {
    // Copy before reversing — loadEntries hands out the cached array.
    let entries = [...this.loadEntries(this.logPath(jobId))].reverse();

    if (opts?.status) {
      entries = entries.filter((e) => e.status === opts.status);
    }

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return entries.slice(offset, offset + limit);
  }

  readAll(opts?: { limit?: number; offset?: number; status?: string; agentId?: string }): CronRunLogEntry[] {
    if (!existsSync(this.baseDir)) return [];

    // Read all .jsonl files in the directory (stat-cached per file).
    const files = readdirSync(this.baseDir) as string[];
    let allEntries: CronRunLogEntry[] = [];

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      allEntries.push(...this.loadEntries(`${this.baseDir}/${file}`));
    }

    // Filter by agentId
    if (opts?.agentId) {
      allEntries = allEntries.filter((e) => e.agentId === opts.agentId);
    }

    // Filter by status
    if (opts?.status) {
      allEntries = allEntries.filter((e) => e.status === opts.status);
    }

    // Sort newest first
    allEntries.sort((a, b) => b.ts - a.ts);

    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return allEntries.slice(offset, offset + limit);
  }

  private pruneIfNeeded(filePath: string): void {
    try {
      const stat = statSync(filePath);
      if (stat.size <= this.maxBytes) return;

      const raw = readFileSync(filePath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());

      // Two independent budgets, both enforced (the old code required
      // BOTH to be exceeded, so ≤keepLines of huge lines never pruned):
      // keep at most keepLines, then keep dropping the oldest until the
      // byte budget holds too.
      let kept = lines.length > this.keepLines ? lines.slice(-this.keepLines) : lines;
      let bytes = kept.reduce((sum, l) => sum + l.length + 1, 0);
      while (bytes > this.maxBytes && kept.length > 1) {
        bytes -= kept[0]!.length + 1;
        kept = kept.slice(1);
      }
      writeFileSync(filePath, kept.join("\n") + "\n", "utf-8");
    } catch {
      // Best-effort pruning
    }
  }

  removeJobLog(jobId: string): void {
    const filePath = this.logPath(jobId);
    this.parseCache.delete(filePath);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
      }
    } catch {
      // Best effort
    }
  }
}
