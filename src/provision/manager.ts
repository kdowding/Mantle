// ProvisionManager — the job queue + orchestration behind the "Set up now"
// button. One job per feature at a time; runs in the background; the UI polls
// getJobs() for live progress (the same polled-tray pattern as the local-model
// pull queue). Owns the post-install activation each feature needs:
//   • localModels — none. hasBinary() is a live existsSync, so the readiness
//     model flips to ready as soon as the binary lands; no restart.
//   • voice — hot-start the sidecar (VoiceManager.start()), and short-circuit
//     the whole install when a working venv is already present.

import { resolve } from "path";
import { existsSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import type { LocalModelManager } from "../local/manager.js";
import type { VoiceManager } from "../voice/manager.js";
import {
  type ProvisionFeature,
  type ProvisionJob,
  type ProvisionOptions,
  type ProvisionProgress,
} from "./types.js";
import { provisionLocalBinary, localBinaryFallback } from "./llama-binary.js";
import { provisionVoice, voiceFallback } from "./voice.js";

export interface ProvisionManagerDeps {
  basePath: string;
  config: MantleConfig;
  localModelManager?: LocalModelManager;
  voiceManager?: VoiceManager;
}

export class ProvisionManager {
  private jobs: ProvisionJob[] = [];
  private active = new Set<ProvisionFeature>();
  private seq = 0;

  constructor(private readonly deps: ProvisionManagerDeps) {}

  isProvisioning(feature?: ProvisionFeature): boolean {
    return feature ? this.active.has(feature) : this.active.size > 0;
  }

  /** All tracked jobs (active + the most recent finished one per feature). The
   *  shape is already wire-safe (no internal-only fields). */
  getJobs(): ProvisionJob[] {
    return this.jobs;
  }

  /**
   * Kick off provisioning for a feature. Rejects if one is already running for
   * it. Returns the new job id; the work runs in the background and the caller
   * polls getJobs().
   */
  start(feature: ProvisionFeature, opts: ProvisionOptions = {}): { jobId?: string; error?: string } {
    if (this.active.has(feature)) {
      return { error: `${feature} is already being set up.` };
    }
    // Drop the prior finished job for this feature so the tray shows just one.
    this.jobs = this.jobs.filter((j) => j.feature !== feature);
    const id = `prov-${feature}-${Date.now()}-${++this.seq}`;
    const job: ProvisionJob = {
      id,
      feature,
      status: "active",
      progress: { phase: "resolving", message: "Starting…" },
      startedAt: Date.now(),
    };
    this.jobs.push(job);
    this.active.add(feature);
    void this._run(job, opts);
    return { jobId: id };
  }

  private async _run(job: ProvisionJob, opts: ProvisionOptions): Promise<void> {
    const onProgress = (p: ProvisionProgress): void => {
      job.progress = p;
    };
    try {
      if (job.feature === "localModels") {
        await this._provisionLocal(opts, onProgress);
      } else {
        await this._provisionVoice(onProgress);
      }
      job.status = "done";
      // Preserve the provisioner's terminal message but normalize the phase.
      job.progress = { phase: "done", message: job.progress?.message ?? "Done." };
      console.log(`[MANTLE:provision] ${job.feature} provisioned`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fallback = job.feature === "localModels" ? localBinaryFallback(this._binaryPath()) : voiceFallback();
      job.status = "error";
      job.error = msg;
      job.fallbackCommands = fallback;
      job.progress = { phase: "error", error: msg, message: msg.split("\n")[0], fallbackCommands: fallback };
      console.warn(`[MANTLE:provision] ${job.feature} failed: ${msg.split("\n")[0]}`);
    } finally {
      this.active.delete(job.feature);
    }
  }

  private _binaryPath(): string {
    return this.deps.localModelManager?.binaryPathAbs() ?? resolve(this.deps.basePath, "local/bin/llama-server.exe");
  }

  private async _provisionLocal(opts: ProvisionOptions, onProgress: (p: ProvisionProgress) => void): Promise<void> {
    const lm = this.deps.localModelManager;
    if (!lm) throw new Error("Local model manager unavailable.");
    // Detect the GPU (memoized) so the auto build pick is informed.
    await lm.detectVram().catch(() => {});
    const hasNvidia = (lm.status().vramTotalBytes ?? 0) > 0;
    await provisionLocalBinary({ basePath: this.deps.basePath, binaryPath: lm.binaryPathAbs(), hasNvidia }, opts, onProgress);
    // hasBinary() is a live existsSync — the readiness model picks it up with no
    // restart. Nothing else to activate.
  }

  private _venvPython(): string {
    const p = this.deps.config.voice.pythonPath;
    return p.startsWith(".") ? resolve(this.deps.basePath, p) : p;
  }

  private async _provisionVoice(onProgress: (p: ProvisionProgress) => void): Promise<void> {
    const vm = this.deps.voiceManager;
    const venvPython = this._venvPython();

    // Fast path: a venv is already present (e.g. voice was toggled on after boot,
    // or a prior install). Try to just start the sidecar — no multi-GB reinstall.
    if (existsSync(venvPython) && vm) {
      onProgress({ phase: "starting", message: "Found an existing voice environment — starting the sidecar…" });
      const ok = await vm.start();
      if (ok) {
        onProgress({ phase: "done", message: "Voice sidecar started." });
        return;
      }
      onProgress({ phase: "resolving", message: "Existing environment didn't start — rebuilding it…" });
    }

    await provisionVoice({ basePath: this.deps.basePath, venvPython }, onProgress);

    // Hot-start the freshly-built sidecar so voice is usable without a restart.
    if (vm) {
      const ok = await vm.start();
      if (!ok) {
        throw new Error(
          "Voice environment built, but the sidecar didn't come up — check the [voice] lines in the server log, then retry.",
        );
      }
      onProgress({ phase: "done", message: "Voice sidecar installed and running." });
    } else {
      onProgress({
        phase: "done",
        message: "Voice environment built. Restart mantle to start the sidecar.",
      });
    }
  }
}
