/**
 * Local-model runtime lifecycle. Manages a llama.cpp `llama-server` child
 * process the same way VoiceManager manages the python voice sidecar:
 * Bun.spawn → poll /health → forward stdout/stderr → graceful kill on
 * shutdown. The difference is that llama-server serves exactly ONE model per
 * process, so "switching model" means kill + respawn (single-active-model
 * policy). A keep-warm pool across multiple ports is a deliberate v2.
 *
 * The spawned server speaks the OpenAI-compatible API at
 * `http://<host>:<port>/v1`, which is why LocalProvider can be ~a clone of
 * the Grok provider (an OpenAI SDK pointed at a base URL).
 *
 * Nothing spawns until a local model is actually used (lazy) — selecting a
 * model in the UI calls /api/local/load to warm it; otherwise the provider's
 * preflight loads it on the first message. This keeps VRAM free when you're
 * not using local inference, honoring the "doesn't touch the core" goal.
 */

import { existsSync, statSync } from "fs";
import { isAbsolute, resolve } from "path";
import type { Subprocess } from "bun";
import type { MantleConfig } from "../config/schema.js";
import {
  type LocalModelEntry,
  getModel,
  loadRegistry,
  resolveModelFile,
  resolveModelsDir,
  updateModel,
} from "./registry.js";
import { pullModel, hfModel, recommendSettings, type PullProgress, type Recommendation } from "./pull.js";

/** Run options for one UI-driven download. */
export interface PullEnqueueOpts {
  spec: string;
  idOverride?: string;
  revision?: string;
  noTools?: boolean;
  reasoning?: boolean;
  supportsTools?: boolean;
}

/** A single download in the pull queue (one per enqueued model). */
export interface PullJob {
  id: string;
  spec: string;
  status: "queued" | "active" | "done" | "error";
  progress: PullProgress | null;
  modelId?: string;
  error?: string;
  enqueuedAt: number;
  /** Run opts — internal; the API strips this before sending to the UI. */
  opts: PullEnqueueOpts;
}

export type LocalRuntimeState = "idle" | "loading" | "ready" | "failed";

export type LocalToolMode = "off" | "core" | "all" | "custom";

// Resolved per-model runtime traits (registry entry merged over config
// defaults). Returned by describeModel for LocalProvider.
export interface LocalModelRuntime {
  entry: LocalModelEntry;
  toolMode: LocalToolMode;
  /** Tool names to advertise when toolMode is "custom" (else empty/ignored). */
  allowedTools: string[];
  reasoning: boolean;
  sampling: {
    temperature: number;
    topP: number;
    topK: number;
    minP: number;
    repeatPenalty: number;
    maxTokens: number;
  };
}

export interface LocalRuntimeStatus {
  enabled: boolean;
  hasBinary: boolean;
  binaryPath: string;
  baseUrl: string;
  state: LocalRuntimeState;
  activeModelId: string | null;
  error: string | null;
  defaultModelId: string | null;
  models: LocalModelEntry[];
  /** Total GPU VRAM in bytes (NVIDIA, best-effort). null = not yet probed,
   *  0 = unavailable/no GPU. Powers the browser's per-quant fit hints. */
  vramTotalBytes: number | null;
  /** Context window (tokens) the loaded model is actually running with, read
   *  from llama-server /props (resolves a ctxSize=0 "model max" to a number).
   *  null = nothing loaded / not yet read. Powers the per-turn context-usage
   *  readout in the UI. */
  activeContextTokens: number | null;
}

export class LocalModelManager {
  private process: Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private state: LocalRuntimeState = "idle";
  private activeModelId: string | null = null;
  private loadError: string | null = null;
  private autoUnloadTimer: ReturnType<typeof setTimeout> | null = null;
  // In-flight provider streams consuming the active model. While > 0 the
  // model is pinned: auto-unload is suppressed and a swap to a DIFFERENT model
  // is refused — tearing llama-server down mid-stream corrupts the live turn.
  private activeGenerations = 0;
  // Async mutex: serializes ensureModelLoaded so two concurrent turns can't
  // race two spawns of the same (or different) model.
  private loadLock: Promise<void> = Promise.resolve();
  // UI-driven download queue. Jobs drain sequentially (downloads are
  // bandwidth-bound — parallelism wouldn't help and muddies progress). The UI
  // polls getPullQueue() and renders a tray; finished jobs are kept (pruned)
  // so recent outcomes stay visible.
  private pullQueue: PullJob[] = [];
  private pullDraining = false;
  private pullJobSeq = 0;
  // Total VRAM (bytes). null = not yet probed, 0 = unavailable.
  private vramBytes: number | null = null;
  // Context window (tokens) the loaded model runs with, from llama-server
  // /props. null when nothing is loaded.
  private activeContextTokens: number | null = null;
  private readonly modelsDirAbs: string;

  constructor(
    private readonly basePath: string,
    private readonly config: MantleConfig,
  ) {
    this.modelsDirAbs = resolveModelsDir(basePath, config.localModels.modelsDir);
  }

  // ── Static facts ─────────────────────────────────────────────────────
  isEnabled(): boolean {
    return this.config.localModels.enabled;
  }

  baseUrl(): string {
    return `http://${this.config.localModels.host}:${this.config.localModels.port}`;
  }

  binaryPathAbs(): string {
    const p = this.config.localModels.binaryPath;
    return isAbsolute(p) ? p : resolve(this.basePath, p);
  }

  hasBinary(): boolean {
    return existsSync(this.binaryPathAbs());
  }

  isAlive(): boolean {
    return this.process !== null && !this.process.killed && this.process.exitCode === null;
  }

  isModelReady(modelId: string): boolean {
    return this.state === "ready" && this.activeModelId === modelId && this.isAlive();
  }

  // ── Registry views (read live from disk so a model pulled while the
  //    server is up shows up without a restart) ─────────────────────────
  listModels(): LocalModelEntry[] {
    return loadRegistry(this.modelsDirAbs).models;
  }

  listModelIds(): string[] {
    return this.listModels().map((m) => m.id);
  }

  getDefaultModelId(): string | null {
    const reg = loadRegistry(this.modelsDirAbs);
    return reg.defaultModelId ?? reg.models[0]?.id ?? null;
  }

  /**
   * Effective runtime traits for a model — registry entry merged over
   * config.localModels.defaults. LocalProvider uses this to decide which
   * tools to advertise, what sampling to send, and whether to run the
   * inline <think> splitter. Returns null if the model isn't registered.
   */
  describeModel(modelId: string): LocalModelRuntime | null {
    const entry = getModel(loadRegistry(this.modelsDirAbs), modelId);
    if (!entry) return null;
    const d = this.config.localModels.defaults;
    // toolMode resolution: explicit entry.toolMode wins; else the legacy
    // supportsTools:false maps to "off"; else the config default.
    const toolMode: LocalToolMode =
      entry.toolMode ?? (entry.supportsTools === false ? "off" : d.toolMode);
    return {
      entry,
      toolMode,
      allowedTools: entry.allowedTools ?? [],
      reasoning: entry.reasoning ?? false,
      sampling: {
        temperature: entry.temperature ?? d.temperature,
        topP: entry.topP ?? d.topP,
        topK: entry.topK ?? d.topK,
        minP: entry.minP ?? d.minP,
        repeatPenalty: entry.repeatPenalty ?? d.repeatPenalty,
        maxTokens: entry.maxTokens ?? d.maxTokens,
      },
    };
  }

  // ── Pull queue (download models from HuggingFace, UI-driven) ─────────
  isPulling(): boolean {
    return this.pullQueue.some((j) => j.status === "queued" || j.status === "active");
  }

  getPullQueue(): PullJob[] {
    return this.pullQueue;
  }

  /**
   * Enqueue a model pull. Jobs drain sequentially in the background; the UI
   * polls getPullQueue() for live progress + outcomes. Returns the new job id,
   * or an error when local models are disabled.
   */
  enqueuePull(opts: PullEnqueueOpts): { jobId?: string; error?: string } {
    if (!this.isEnabled()) return { error: "Local models are disabled." };
    const id = `pull-${Date.now()}-${++this.pullJobSeq}`;
    this.pullQueue.push({
      id,
      spec: opts.spec,
      status: "queued",
      progress: null,
      enqueuedAt: Date.now(),
      opts,
    });
    void this._drainQueue();
    return { jobId: id };
  }

  // Process queued jobs one at a time. Idempotent — a second caller while a
  // drain is running is a no-op; the running loop picks up newly-queued jobs.
  private async _drainQueue(): Promise<void> {
    if (this.pullDraining) return;
    this.pullDraining = true;
    const hfToken =
      this.config.localModels.hfToken ||
      process.env.HF_TOKEN ||
      process.env.HUGGING_FACE_HUB_TOKEN ||
      undefined;
    try {
      for (;;) {
        const job = this.pullQueue.find((j) => j.status === "queued");
        if (!job) break;
        job.status = "active";
        job.progress = { phase: "resolving", spec: job.spec, message: "starting…" };
        try {
          const res = await pullModel(
            {
              modelsDirAbs: this.modelsDirAbs,
              hfToken,
              spec: job.opts.spec,
              idOverride: job.opts.idOverride,
              revision: job.opts.revision,
              noTools: job.opts.noTools,
              reasoning: job.opts.reasoning,
              supportsTools: job.opts.supportsTools,
            },
            (p) => {
              job.progress = p;
            },
          );
          job.status = "done";
          job.modelId = res.modelId;
          job.progress = {
            phase: "done",
            spec: job.spec,
            modelId: res.modelId,
            totalBytes: res.bytes,
            receivedBytes: res.bytes,
          };
          console.log(`[MANTLE:local] pulled "${res.modelId}" (${res.bytes} bytes) via UI`);
          // Size the fresh model to the GPU (balanced 32K ceiling) so it
          // arrives usable instead of stuck on the global ctx default.
          await this._applyRecommendedOnDownload(res.modelId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          job.status = "error";
          job.error = msg;
          job.progress = { phase: "error", spec: job.spec, error: msg };
          console.warn(`[MANTLE:local] pull failed for "${job.spec}": ${msg}`);
        }
        this._prunePullQueue();
      }
    } finally {
      this.pullDraining = false;
    }
  }

  // Bound the queue: keep all queued/active jobs + the most recent 6 finished.
  private _prunePullQueue(): void {
    const finished = this.pullQueue.filter((j) => j.status === "done" || j.status === "error");
    if (finished.length <= 6) return;
    const drop = new Set(finished.slice(0, finished.length - 6).map((j) => j.id));
    this.pullQueue = this.pullQueue.filter((j) => !drop.has(j.id));
  }

  status(): LocalRuntimeStatus {
    const reg = loadRegistry(this.modelsDirAbs);
    return {
      enabled: this.isEnabled(),
      hasBinary: this.hasBinary(),
      binaryPath: this.binaryPathAbs(),
      baseUrl: this.baseUrl(),
      state: this.state,
      activeModelId: this.activeModelId,
      error: this.loadError,
      defaultModelId: reg.defaultModelId ?? reg.models[0]?.id ?? null,
      models: reg.models,
      vramTotalBytes: this.vramBytes,
      activeContextTokens: this.activeContextTokens,
    };
  }

  // Best-effort total VRAM detection (NVIDIA) so the model browser can show
  // per-quant "fits your GPU" hints. Memoized; sets 0 when unavailable (no
  // GPU / nvidia-smi missing) so the UI just omits the hint.
  async detectVram(): Promise<void> {
    if (this.vramBytes !== null) return;
    for (const cmd of ["nvidia-smi", "C:\\Windows\\System32\\nvidia-smi.exe"]) {
      try {
        const proc = Bun.spawn([cmd, "--query-gpu=memory.total", "--format=csv,noheader,nounits"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const mib = parseInt(out.trim().split(/\r?\n/)[0]?.trim() ?? "", 10);
        if (Number.isFinite(mib) && mib > 0) {
          this.vramBytes = mib * 1024 * 1024;
          console.log(`[MANTLE:local] detected ${(this.vramBytes / 1e9).toFixed(1)} GB VRAM`);
          return;
        }
      } catch {
        /* try next candidate */
      }
    }
    this.vramBytes = 0; // unavailable
  }

  /** Live free VRAM (bytes) via nvidia-smi memory.free. null when unavailable.
   *  NOT memoized — free VRAM changes as models/apps load and unload, which is
   *  the whole point: it already nets out Windows + the voice models if loaded,
   *  so the recommender sizes context against what's actually free right now. */
  async queryFreeVramBytes(): Promise<number | null> {
    for (const cmd of ["nvidia-smi", "C:\\Windows\\System32\\nvidia-smi.exe"]) {
      try {
        const proc = Bun.spawn([cmd, "--query-gpu=memory.free", "--format=csv,noheader,nounits"], {
          stdout: "pipe",
          stderr: "ignore",
        });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        const mib = parseInt(out.trim().split(/\r?\n/)[0]?.trim() ?? "", 10);
        if (Number.isFinite(mib) && mib >= 0) return mib * 1024 * 1024;
      } catch {
        /* try next candidate */
      }
    }
    return null;
  }

  private hfToken(): string | undefined {
    return (
      this.config.localModels.hfToken ||
      process.env.HF_TOKEN ||
      process.env.HUGGING_FACE_HUB_TOKEN ||
      undefined
    );
  }

  /**
   * Recommend spawn settings for an installed model, sized to current VRAM.
   * Resolves param count + trained context from the source repo's GGUF
   * metadata (best-effort HF fetch — no local persistence needed), measures
   * live free VRAM, and runs recommendSettings. `opts.ceilingTokens` caps the
   * context (the download default passes ~32K for a balanced baseline; the
   * live "Set recommended" button passes none). Returns null if the model
   * isn't registered.
   */
  async recommendForModel(
    modelId: string,
    opts?: { ceilingTokens?: number },
  ): Promise<(Recommendation & { freeBytes: number | null; totalBytes: number | null }) | null> {
    const entry = getModel(loadRegistry(this.modelsDirAbs), modelId);
    if (!entry) return null;

    // Weights: prefer the recorded sum-of-parts; else stat the primary file.
    let weightsBytes = entry.sizeBytes ?? 0;
    if (!weightsBytes) {
      try {
        weightsBytes = statSync(resolveModelFile(this.modelsDirAbs, entry)).size;
      } catch {
        /* leave 0 — recommendSettings still returns a capped context */
      }
    }

    // Param count + trained context from the source repo's GGUF metadata.
    let paramCount: number | undefined;
    let trainedContext: number | undefined;
    if (entry.source) {
      try {
        const detail = await hfModel(entry.source, this.hfToken());
        paramCount = detail.gguf?.paramCount;
        trainedContext = detail.gguf?.contextLength;
      } catch {
        /* HF unreachable / repo gone — degrade gracefully */
      }
    }

    const freeBytes = await this.queryFreeVramBytes();
    const totalBytes = this.vramBytes; // detected at boot (may be null)
    const cushionBytes = this.config.localModels.reservedVramBytes ?? 2_000_000_000;

    const rec = recommendSettings({
      weightsBytes,
      paramCount,
      trainedContext,
      freeBytes: freeBytes ?? 0,
      totalBytes: totalBytes ?? undefined,
      cushionBytes,
      ceilingTokens: opts?.ceilingTokens,
      quant: entry.quant,
      idOrSource: entry.source || entry.id,
    });
    return { ...rec, freeBytes, totalBytes };
  }

  /** Persist GPU-sized context/KV settings on a freshly-pulled model so it
   *  arrives usable. Best-effort — never throws into the pull flow (the model
   *  is already downloaded + registered; this is just tuning). */
  private async _applyRecommendedOnDownload(modelId: string): Promise<void> {
    try {
      const rec = await this.recommendForModel(modelId, { ceilingTokens: 32768 });
      if (rec && rec.ctxSize) {
        updateModel(this.modelsDirAbs, modelId, {
          ctxSize: rec.ctxSize,
          kvCacheType: rec.kvCacheType,
          flashAttn: rec.flashAttn,
        });
        console.log(`[MANTLE:local] auto-configured "${modelId}": ${rec.rationale}`);
      }
    } catch (err) {
      console.warn(
        `[MANTLE:local] couldn't auto-configure "${modelId}": ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ── Load / swap ──────────────────────────────────────────────────────
  /**
   * Ensure `modelId` is the live, healthy model — spawning (and first
   * swapping out any other active model) if needed. Resolves once
   * llama-server reports healthy; rejects with a descriptive error
   * otherwise. Fast no-op when the model is already warm. Serialized so
   * concurrent callers don't double-spawn. `opts.signal` aborts the wait
   * (the agent loop passes its composed /stop + idle signal).
   */
  async ensureModelLoaded(modelId: string, opts?: { signal?: AbortSignal; pin?: boolean }): Promise<void> {
    // Lock-free fast path for non-pinning callers (manual Load, API preflight):
    // a warm model needs no work. A pinning caller (a streaming turn) must NOT
    // take this shortcut — its pin has to be established under the load lock so
    // a concurrent swap, whose _doLoad runs under that same lock, is serialized
    // behind the pin and sees activeGenerations > 0 (and so refuses to kill the
    // server we're about to stream against).
    if (!opts?.pin && this.isModelReady(modelId)) {
      this.touch();
      return;
    }
    const prev = this.loadLock;
    let release!: () => void;
    this.loadLock = new Promise<void>((r) => (release = r));
    try {
      await prev.catch(() => {});
      // Re-check after acquiring the lock — a prior caller may have just
      // loaded exactly this model.
      if (!this.isModelReady(modelId)) {
        await this._doLoad(modelId, opts?.signal);
      }
      this.touch();
      // Pin while still holding the lock so the swap guard in _doLoad sees it.
      // The caller owns the matching endGeneration() (LocalProvider's finally).
      if (opts?.pin) this.beginGeneration();
    } finally {
      release();
    }
  }

  private async _doLoad(modelId: string, signal?: AbortSignal): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error("Local models are disabled (config.localModels.enabled=false).");
    }
    if (!this.hasBinary()) {
      throw new Error(
        `llama.cpp server not found at ${this.binaryPathAbs()}. Download the build for your platform/GPU (Windows+NVIDIA: llama.cpp's -bin-win-cuda-x64 release) and place llama-server.exe there, or set localModels.binaryPath.`,
      );
    }
    const entry = getModel(loadRegistry(this.modelsDirAbs), modelId);
    if (!entry) {
      throw new Error(`Local model "${modelId}" is not in the registry. Run \`mantle pull <hf-link>\` first.`);
    }
    const gguf = resolveModelFile(this.modelsDirAbs, entry);
    if (!existsSync(gguf)) {
      throw new Error(`GGUF weights missing for "${modelId}": ${gguf}`);
    }

    // Refuse a swap that would kill a model still serving an in-flight stream
    // — tearing llama-server down mid-generation corrupts that turn. Reaching
    // here means modelId isn't the ready model (ensureModelLoaded's fast-path
    // returns early when it is), so this is a genuine swap. Explicit unload /
    // shutdown call _kill directly and are intentionally NOT gated.
    if (this.activeGenerations > 0 && this.activeModelId && this.activeModelId !== modelId) {
      throw new Error(
        `Local model "${this.activeModelId}" is busy serving ${this.activeGenerations} active ` +
          `request(s) — can't switch to "${modelId}" until it finishes.`,
      );
    }

    // Single active model — tear down whatever's loaded first.
    await this._kill();

    this.state = "loading";
    this.loadError = null;
    this.activeModelId = modelId;

    const d = this.config.localModels.defaults;
    const ctx = entry.ctxSize ?? d.ctxSize;
    const nglRaw = entry.gpuLayers ?? d.gpuLayers;
    const ngl = nglRaw < 0 ? 999 : nglRaw; // -1 → offload all layers
    const threads = entry.threads ?? d.threads;

    const parallel = this.config.localModels.parallel > 0 ? this.config.localModels.parallel : 1;
    const args = [
      "-m", gguf,
      "--host", this.config.localModels.host,
      "--port", String(this.config.localModels.port),
      "-c", String(ctx),
      "-ngl", String(ngl),
      // Concurrent request slots — each reserves its own KV-cache slice.
      "--parallel", String(parallel),
      // Quiet the per-request slot/prompt-cache/timing firehose (llama.cpp
      // defaults to a chatty verbosity 3).
      "--log-verbosity", String(this.config.localModels.logVerbosity),
      // --jinja activates the model's own chat template, which is what makes
      // OpenAI-style tool calls work for tool-aware models.
      "--jinja",
    ];
    if (threads > 0) args.push("--threads", String(threads));
    if (entry.chatTemplate) args.push("--chat-template", entry.chatTemplate);

    // KV-cache quantization + flash attention. Quantizing the V cache
    // requires FA (llama.cpp constraint), so force it on whenever the KV
    // type isn't f16. "auto" is llama.cpp's own default — omit the flag in
    // that case to keep the spawn line minimal / behavior unchanged.
    const kvType = entry.kvCacheType ?? d.kvCacheType;
    let fa = entry.flashAttn ?? d.flashAttn;
    if (kvType && kvType !== "f16") {
      args.push("--cache-type-k", kvType, "--cache-type-v", kvType);
      fa = "on";
    }
    if (fa && fa !== "auto") args.push("--flash-attn", fa);

    console.log(
      `[MANTLE:local] spawning llama-server for "${modelId}" (ctx=${ctx}, ngl=${ngl}${threads > 0 ? `, threads=${threads}` : ""})`,
    );

    let proc: Subprocess<"ignore", "pipe", "pipe">;
    try {
      proc = Bun.spawn({
        cmd: [this.binaryPathAbs(), ...args],
        cwd: this.basePath,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      });
    } catch (err) {
      this.state = "failed";
      this.activeModelId = null;
      this.loadError = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to spawn llama-server: ${this.loadError}`);
    }
    this.process = proc;
    this._pipe(proc.stdout, "stdout");
    this._pipe(proc.stderr, "stderr");

    // Detect an early exit (bad binary / GPU mismatch / OOM) so the health
    // wait fails fast instead of grinding to the full timeout.
    proc.exited
      .then((code) => {
        if (this.process !== proc) return; // we intentionally replaced/killed it
        console.warn(`[MANTLE:local] llama-server exited unexpectedly (code=${code})`);
        this.process = null;
        this.state = "failed";
        this.loadError = `llama-server exited (code ${code})`;
      })
      .catch(() => {});

    try {
      await this._waitForHealth(signal);
    } catch (err) {
      this.loadError = err instanceof Error ? err.message : String(err);
      await this._kill();
      this.state = "failed";
      throw err;
    }

    this.state = "ready";
    await this._queryActiveContext();
    console.log(
      `[MANTLE:local] "${modelId}" ready at ${this.baseUrl()} (ctx ${this.activeContextTokens ?? "?"})`,
    );
    this._scheduleAutoUnload();
  }

  private async _waitForHealth(signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.config.localModels.loadTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("aborted");
      if (!this.isAlive()) {
        throw new Error(
          this.loadError ??
            "llama-server exited during load — check the model file and that the binary matches your GPU/driver.",
        );
      }
      try {
        const r = await fetch(`${this.baseUrl()}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          // llama-server returns {"status":"ok"} when ready, 503
          // {"status":"loading model"} while warming.
          const body = (await r.json().catch(() => ({}))) as { status?: string };
          if (!body.status || body.status === "ok") return;
        }
      } catch {
        // not up yet / connection refused — keep polling
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      `llama-server did not become healthy within ${Math.round(this.config.localModels.loadTimeoutMs / 1000)}s`,
    );
  }

  // Read the context window the server is actually running with from /props.
  // Resolves a ctxSize=0 ("model max") entry to a real number, and reflects
  // any clamp llama.cpp applied. Best-effort — leaves activeContextTokens null
  // on failure (the UI just omits the denominator).
  private async _queryActiveContext(): Promise<void> {
    this.activeContextTokens = null;
    try {
      const r = await fetch(`${this.baseUrl()}/props`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) return;
      const j = (await r.json()) as { default_generation_settings?: { n_ctx?: number }; n_ctx?: number };
      const n = j.default_generation_settings?.n_ctx ?? j.n_ctx;
      if (typeof n === "number" && n > 0) this.activeContextTokens = n;
    } catch {
      /* best effort — /props unsupported or server busy */
    }
  }

  // ── Teardown ─────────────────────────────────────────────────────────
  /** Public unload — frees VRAM, leaves the runtime idle. */
  async unload(): Promise<void> {
    await this._kill();
  }

  /** Final shutdown (called from the server's graceful shutdown). */
  async stop(): Promise<void> {
    if (this.autoUnloadTimer) {
      clearTimeout(this.autoUnloadTimer);
      this.autoUnloadTimer = null;
    }
    await this._kill();
  }

  private async _kill(): Promise<void> {
    // A stale idle timer armed for the PREVIOUS model must not survive the
    // kill — it would fire mid-cold-load of the next model and tear it down.
    if (this.autoUnloadTimer) {
      clearTimeout(this.autoUnloadTimer);
      this.autoUnloadTimer = null;
    }
    const proc = this.process;
    // Mark stopped FIRST so the .exited handler treats this as intentional.
    this.process = null;
    this.activeModelId = null;
    this.activeContextTokens = null;
    this.state = "idle";
    if (!proc) return;
    try {
      proc.kill();
      await Promise.race([proc.exited, new Promise((r) => setTimeout(r, 3000))]);
      if (proc.exitCode === null) {
        try {
          proc.kill("SIGKILL" as never);
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* best effort */
    }
  }

  // ── Active-generation tracking ───────────────────────────────────────
  // LocalProvider brackets each streaming turn with begin/endGeneration so the
  // manager knows the model is in use: auto-unload is suppressed and a swap to
  // a different model is refused (see _doLoad) until every stream finishes.
  beginGeneration(): void {
    this.activeGenerations++;
    // Don't let the idle timer fire mid-stream.
    if (this.autoUnloadTimer) {
      clearTimeout(this.autoUnloadTimer);
      this.autoUnloadTimer = null;
    }
  }

  endGeneration(): void {
    if (this.activeGenerations > 0) this.activeGenerations--;
    // Re-arm idle auto-unload once the last stream drains.
    if (this.activeGenerations === 0) this._scheduleAutoUnload();
  }

  hasActiveGenerations(): boolean {
    return this.activeGenerations > 0;
  }

  // ── Idle auto-unload ─────────────────────────────────────────────────
  private touch(): void {
    this._scheduleAutoUnload();
  }

  private _scheduleAutoUnload(): void {
    if (this.autoUnloadTimer) {
      clearTimeout(this.autoUnloadTimer);
      this.autoUnloadTimer = null;
    }
    // Never arm the idle timer while a stream is actively consuming the model
    // (a concurrent same-model turn's touch() must not re-arm it either).
    if (this.activeGenerations > 0) return;
    const minutes = this.config.localModels.autoUnloadMinutes;
    if (!minutes || minutes <= 0) return;
    this.autoUnloadTimer = setTimeout(() => {
      this.autoUnloadTimer = null;
      // Re-check at fire time — a load/stream may have started since this
      // was armed (belt-and-braces on top of _kill clearing the timer).
      if (this.state !== "ready" || this.activeGenerations > 0) return;
      const id = this.activeModelId;
      console.log(`[MANTLE:local] auto-unloading "${id}" after ${minutes}m idle`);
      this.unload().catch(() => {});
    }, minutes * 60_000);
  }

  // Forward llama-server's stdout/stderr to mantle's logs with a prefix so
  // load progress + errors are attributable in the console window.
  private async _pipe(stream: ReadableStream<Uint8Array>, label: string): Promise<void> {
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) console.log(`[local:${label}] ${line}`);
        }
      }
    } catch {
      /* stream closed on shutdown */
    }
  }
}
