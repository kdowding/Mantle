// Regression tests for the index.json integrity work (M1-3): fail-closed
// corrupt handling (preserve + rebuild, never silently wipe), atomic
// helpers, the messageCount resync on replaceMessages, and the channel
// adapter's skipIndex mode.

import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { SessionManager, mutateSessionIndex } from "./session.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mantle-idx-"));
});

const indexPath = () => resolve(dir, "index.json");

function userMsg(text: string) {
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  };
}

describe("index basics", () => {
  test("appendMessage registers + bumps the index (after flush)", async () => {
    const s = new SessionManager("s1", dir);
    await s.appendMessage(userMsg("hello world"));
    await s.flushIndex();
    const index = SessionManager.loadIndex(dir);
    expect(index.sessions).toHaveLength(1);
    expect(index.sessions[0].id).toBe("s1");
    expect(index.sessions[0].messageCount).toBe(1);
    expect(index.sessions[0].title.startsWith("hello world")).toBe(true);
  });

  test("createSessionMeta is idempotent", () => {
    const a = SessionManager.createSessionMeta("pre", dir, { provider: "x", model: "y" });
    const b = SessionManager.createSessionMeta("pre", dir, { provider: "DIFFERENT" });
    expect(a.id).toBe("pre");
    expect(b.provider).toBe("x"); // existing entry returned untouched
    expect(SessionManager.loadIndex(dir).sessions).toHaveLength(1);
  });

  test("mutateSessionIndex skips the write when mutate returns false", () => {
    SessionManager.createSessionMeta("a", dir, {});
    const before = readFileSync(indexPath(), "utf-8");
    mutateSessionIndex(dir, () => false);
    expect(readFileSync(indexPath(), "utf-8")).toBe(before);
  });
});

describe("corrupt index fail-closed (the sidebar-wipe regression)", () => {
  test("torn JSON → .corrupt copy preserved + sessions rebuilt from transcripts", async () => {
    const s = new SessionManager("recoverme", dir);
    await s.appendMessage(userMsg("important conversation"));
    await s.flushIndex();

    // Tear the index the way a crash mid-write would.
    writeFileSync(indexPath(), '{"sessions":[{"id":"recoverme","crea', "utf-8");

    const index = SessionManager.loadIndex(dir);
    // The session is BACK (rebuilt from the .jsonl), not silently wiped.
    expect(index.sessions.some((x) => x.id === "recoverme")).toBe(true);
    // The corrupt original is preserved for manual recovery.
    const backups = readdirSync(dir).filter((f) => f.startsWith("index.json.corrupt-"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  test("a writer after corruption persists the REBUILT index, not a blank", async () => {
    const s = new SessionManager("kept", dir);
    await s.appendMessage(userMsg("must survive"));
    await s.flushIndex();
    writeFileSync(indexPath(), "NOT JSON AT ALL", "utf-8");

    // Any RMW writer heals the file from the rebuild.
    mutateSessionIndex(dir, () => { /* no-op mutate, forces a write */ });
    const onDisk = JSON.parse(readFileSync(indexPath(), "utf-8"));
    expect(onDisk.sessions.some((x: { id: string }) => x.id === "kept")).toBe(true);
  });
});

describe("replaceMessages", () => {
  test("resyncs messageCount (the post-compaction drift regression)", async () => {
    const s = new SessionManager("rs", dir);
    for (let i = 0; i < 6; i++) await s.appendMessage(userMsg(`m${i}`));
    await s.flushIndex();
    expect(SessionManager.loadIndex(dir).sessions[0].messageCount).toBe(6);

    await s.replaceMessages([userMsg("summary"), userMsg("tail")]);
    await s.flushIndex();
    expect(SessionManager.loadIndex(dir).sessions[0].messageCount).toBe(2);
  });
});

describe("skipIndex (channel adapter mode)", () => {
  test("appendMessage writes the JSONL but never creates index.json", async () => {
    const sub = mkdtempSync(join(tmpdir(), "mantle-chan-"));
    const s = new SessionManager("chan-row", sub, { skipIndex: true });
    await s.appendMessage(userMsg("row"));
    await s.flushIndex();
    expect(existsSync(resolve(sub, "chan-row.jsonl"))).toBe(true);
    expect(existsSync(resolve(sub, "index.json"))).toBe(false);
    rmSync(sub, { recursive: true, force: true });
  });
});

describe("deleteSession", () => {
  test("removes the JSONL and the index entry", async () => {
    const s = new SessionManager("gone", dir);
    await s.appendMessage(userMsg("bye"));
    await s.flushIndex();
    expect(SessionManager.deleteSession("gone", dir)).toBe(true);
    expect(existsSync(resolve(dir, "gone.jsonl"))).toBe(false);
    expect(SessionManager.loadIndex(dir).sessions).toHaveLength(0);
  });
});
