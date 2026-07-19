// Voice sidecar lifecycle. Spawns the python FastAPI server on mantle
// startup (cheap idle process — models aren't loaded until the user
// toggles voice mode), forwards its stdout/stderr to mantle's logs with
// a [voice] prefix, and shuts it down on SIGINT/SIGTERM.
//
// Mirrors the EnglyphManager spawn pattern but uses Bun.spawn directly
// instead of going through MCP stdio — the sidecar is an HTTP server,
// not an MCP tool source.
import { resolve } from "path";
import { existsSync, readdirSync } from "fs";
import type { Subprocess } from "bun";
import type { MantleConfig } from "../config/schema.js";
import { VoiceClient } from "./client.js";

export class VoiceManager {
  private process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private readonly client: VoiceClient;
  private startPromise: Promise<boolean> | null = null;

  constructor(
    private readonly basePath: string,
    private readonly config: MantleConfig,
  ) {
    this.client = new VoiceClient(`http://${config.voice.host}:${config.voice.port}`);
  }

  // Read the flag LIVE off the (mutated-in-place) config, not a value captured at
  // construction — so a runtime toggle (PUT /api/config/features) or the voice
  // provisioner's hot-start both see voice.enabled flip without a restart.
  isEnabled(): boolean {
    return this.config.voice.enabled;
  }

  getClient(): VoiceClient {
    return this.client;
  }

  // Mantle's project root. Exposed so other voice components (e.g. the
  // per-turn TTS log writer) can resolve their state directories under
  // .mantle/ without having to plumb basePath separately.
  getBasePath(): string {
    return this.basePath;
  }

  isAlive(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null;
  }

  // Spawn the sidecar and wait for /health to respond. Idempotent —
  // concurrent callers share the same start promise. Returns true on
  // success, false on failure (logged but not thrown so mantle keeps
  // booting without voice if the sidecar refuses to start).
  async start(): Promise<boolean> {
    if (!this.isEnabled()) {
      console.log("[MANTLE:voice] disabled (config.voice.enabled=false)");
      return false;
    }
    if (this.isAlive()) return true;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this._doStart();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async _doStart(): Promise<boolean> {
    const pythonPath = this.config.voice.pythonPath.startsWith(".")
      ? resolve(this.basePath, this.config.voice.pythonPath)
      : this.config.voice.pythonPath;

    // Voice is OPTIONAL. The common fresh-clone case is no Python venv set up
    // yet (the default pythonPath points at one that doesn't exist), so don't
    // attempt a spawn that ENOENTs with an alarming-looking error — note it
    // calmly and run without voice until the user wires up the sidecar.
    if (!existsSync(pythonPath)) {
      console.log(
        `[MANTLE:voice] sidecar not started — no Python interpreter at ${pythonPath}. ` +
          `Voice is optional; create the venv (see the README) or set voice.enabled=false to silence this.`,
      );
      return false;
    }

    console.log(
      `[MANTLE:voice] spawning sidecar (${pythonPath} -m voice.server, port ${this.config.voice.port})`,
    );

    try {
      this.process = Bun.spawn({
        cmd: [pythonPath, "-m", "voice.server"],
        cwd: this.basePath,
        env: {
          ...process.env,
          MANTLE_VOICE_HOST: this.config.voice.host,
          MANTLE_VOICE_PORT: String(this.config.voice.port),
          // Ensure python doesn't buffer stdout — we forward live to mantle's logs
          PYTHONUNBUFFERED: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      console.error(`[MANTLE:voice] spawn failed: ${err instanceof Error ? err.message : err}`);
      this.process = null;
      return false;
    }

    // Forward stdout/stderr to mantle's logs with a prefix so log lines from
    // the python process are clearly attributable.
    this._pipe(this.process.stdout, "stdout");
    this._pipe(this.process.stderr, "stderr");

    // Watch for unexpected exit so users see why voice features stopped working
    // mid-session. We don't auto-restart in v1 — if it crashes the user can
    // restart mantle. Log only.
    this.process.exited.then((code) => {
      // null process means we intentionally killed it via stop()
      if (this.process === null) return;
      console.warn(`[MANTLE:voice] sidecar exited unexpectedly (code=${code})`);
      this.process = null;
    }).catch(() => { /* shutdown race */ });

    // Poll /health until the FastAPI app responds or we time out
    const ready = await this._waitForHealth();
    if (!ready) {
      console.error(
        `[MANTLE:voice] sidecar /health didn't respond within ${this.config.voice.startupTimeoutMs}ms — killing process`,
      );
      await this.stop();
      return false;
    }

    console.log(`[MANTLE:voice] sidecar ready at ${this.client["baseUrl"]} (models lazy-load on toggle)`);
    return true;
  }

  private async _waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.config.voice.startupTimeoutMs;
    const pollMs = 250;
    while (Date.now() < deadline) {
      if (!this.isAlive()) return false; // process died during startup
      if (await this.client.health()) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }

  private _pipe(stream: ReadableStream<Uint8Array> | null, label: string): void {
    if (!stream) return;
    (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trimEnd();
            buf = buf.slice(idx + 1);
            if (line) console.log(`[voice:${label}] ${line}`);
          }
        }
        if (buf.trim()) console.log(`[voice:${label}] ${buf.trim()}`);
      } catch {
        // stream closed during shutdown
      }
    })();
  }

  // Resolve the absolute path to an agent's voice reference file.
  //
  // Resolution order:
  //   1. `voiceFile` override (just a basename like "echo.wav") — set via
  //      the profile-bar voice selector and persisted on AgentConfig.
  //   2. Legacy convention `voices/<agent-id>.wav` — used when the agent
  //      has no override OR the override points at a missing file (so a
  //      stale config doesn't brick voice).
  //
  // Returns null if neither resolves — callers (UI toggle, synth) use
  // null to gate availability.
  resolveVoiceRef(agentId: string, voiceFile?: string | null): string | null {
    if (voiceFile) {
      // Strip any path separators — voiceFile is supposed to be a basename.
      // Defensive; the API and UI both send basenames, but a malformed
      // config shouldn't traverse the filesystem.
      const safe = voiceFile.replace(/[/\\]/g, "");
      const overridePath = resolve(this.basePath, "voices", safe);
      if (existsSync(overridePath)) return overridePath;
    }
    const fallback = resolve(this.basePath, "voices", `${agentId}.wav`);
    return existsSync(fallback) ? fallback : null;
  }

  // Enumerate every .wav file in voices/. Used by the UI dropdown to
  // populate the voice selector. Returns basenames (e.g. "echo.wav"),
  // sorted alphabetically. Missing voices/ dir → empty list.
  listAvailableVoices(): string[] {
    const dir = resolve(this.basePath, "voices");
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith(".wav"))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  }

  async stop(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    this.process = null; // mark stopped so the .exited handler is a no-op
    try {
      proc.kill();
      // Brief grace period for clean shutdown then force
      await Promise.race([
        proc.exited,
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      if (proc.exitCode === null) {
        try { proc.kill("SIGKILL" as any); } catch { /* already dead */ }
      }
    } catch {
      // best effort
    }
    console.log("[MANTLE:voice] sidecar stopped");
  }
}
