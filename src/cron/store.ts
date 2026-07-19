import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { CronJob } from "./types.js";

export class CronStore {
  private db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        data TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at_ms INTEGER,
        priority TEXT NOT NULL DEFAULT 'normal',
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_next_run ON jobs(enabled, next_run_at_ms);
      CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent_id);
    `);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  addJob(job: CronJob): void {
    this.db.run(
      `INSERT INTO jobs (id, agent_id, data, enabled, next_run_at_ms, priority, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.agentId,
        JSON.stringify(job),
        job.enabled ? 1 : 0,
        job.state.nextRunAtMs ?? null,
        job.priority,
        job.createdAtMs,
        job.updatedAtMs,
      ],
    );
  }

  getJob(id: string): CronJob | null {
    const row = this.db.query("SELECT data FROM jobs WHERE id = ?").get(id) as { data: string } | null;
    return row ? JSON.parse(row.data) : null;
  }

  updateJob(job: CronJob): void {
    job.updatedAtMs = Date.now();
    this.db.run(
      `UPDATE jobs SET
        data = ?, enabled = ?, next_run_at_ms = ?, priority = ?, updated_at_ms = ?
       WHERE id = ?`,
      [
        JSON.stringify(job),
        job.enabled ? 1 : 0,
        job.state.nextRunAtMs ?? null,
        job.priority,
        job.updatedAtMs,
        job.id,
      ],
    );
  }

  removeJob(id: string): boolean {
    const result = this.db.run("DELETE FROM jobs WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  listJobs(opts?: {
    agentId?: string;
    enabled?: boolean;
    tag?: string;
    limit?: number;
    offset?: number;
  }): CronJob[] {
    const conditions: string[] = [];
    const params: (string | number | null)[] = [];

    if (opts?.agentId) {
      conditions.push("agent_id = ?");
      params.push(opts.agentId);
    }
    if (opts?.enabled !== undefined) {
      conditions.push("enabled = ?");
      params.push(opts.enabled ? 1 : 0);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // LIMIT/OFFSET are BOUND, never interpolated, and OFFSET always rides
    // with a LIMIT (SQLite rejects a bare OFFSET — `?offset=N` without
    // limit used to render invalid SQL → opaque 500). LIMIT -1 = no cap;
    // an explicit limit of 0 is honored (the old truthiness check dropped it).
    let limitClause = "";
    if (opts?.limit !== undefined || opts?.offset !== undefined) {
      limitClause = "LIMIT ? OFFSET ?";
      params.push(opts?.limit !== undefined && opts.limit >= 0 ? opts.limit : -1);
      params.push(opts?.offset !== undefined && opts.offset >= 0 ? opts.offset : 0);
    }

    const rows = this.db.query(
      `SELECT data FROM jobs ${where} ORDER BY created_at_ms DESC ${limitClause}`,
    ).all(...params) as { data: string }[];

    let jobs = rows.map((r) => JSON.parse(r.data) as CronJob);

    // Tag filter is applied post-query since tags are in the JSON blob
    if (opts?.tag) {
      const tag = opts.tag;
      jobs = jobs.filter((j) => j.tags?.includes(tag));
    }

    return jobs;
  }

  getDueJobs(nowMs: number): CronJob[] {
    const rows = this.db.query(
      `SELECT data FROM jobs
       WHERE enabled = 1
         AND next_run_at_ms IS NOT NULL
         AND next_run_at_ms <= ?
         AND (json_extract(data, '$.state.runningAtMs') IS NULL)
       ORDER BY
         CASE json_extract(data, '$.priority')
           WHEN 'critical' THEN 0
           WHEN 'high' THEN 1
           WHEN 'normal' THEN 2
           WHEN 'low' THEN 3
           ELSE 2
         END,
         next_run_at_ms ASC`,
    ).all(nowMs) as { data: string }[];

    return rows.map((r) => JSON.parse(r.data) as CronJob);
  }

  getNextWakeMs(): number | null {
    const row = this.db.query(
      `SELECT MIN(next_run_at_ms) as next FROM jobs
       WHERE enabled = 1
         AND next_run_at_ms IS NOT NULL
         AND (json_extract(data, '$.state.runningAtMs') IS NULL)`,
    ).get() as { next: number | null } | null;

    return row?.next ?? null;
  }

  countJobsByAgent(agentId: string): number {
    const row = this.db.query(
      "SELECT COUNT(*) as count FROM jobs WHERE agent_id = ?",
    ).get(agentId) as { count: number };
    return row.count;
  }

  // ── State Mutations ───────────────────────────────────────────────────────

  // Single-statement json_set, not a read-modify-write of the whole blob —
  // atomic under SQLite, so a concurrent writer (manual trigger racing the
  // scheduler) can't clobber fields it never touched.
  markRunning(id: string, nowMs: number): void {
    this.db.run(
      `UPDATE jobs SET data = json_set(data, '$.state.runningAtMs', ?), updated_at_ms = ? WHERE id = ?`,
      [nowMs, Date.now(), id],
    );
  }

  clearStaleRunning(): number {
    // On startup, clear any jobs that were marked running (crashed mid-run)
    const rows = this.db.query(
      `SELECT data FROM jobs WHERE json_extract(data, '$.state.runningAtMs') IS NOT NULL`,
    ).all() as { data: string }[];

    let cleared = 0;
    for (const row of rows) {
      const job: CronJob = JSON.parse(row.data);
      job.state.runningAtMs = undefined;
      this.updateJob(job);
      cleared++;
    }
    return cleared;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
