// Provisioner types — the shared vocabulary for the "Set up now" flow that
// installs the external runtimes a heavy feature needs (the llama-server binary
// for local models, the .venv-streaming Python sidecar for voice). Mirrors the
// local-pull job model (src/local/manager.ts PullJob) so the UI can reuse the
// same polled-tray pattern: enqueue a job, poll its progress, surface the
// outcome.
//
// Design floor (memory project_lean_install_posture): every provisioner is
// "tiered auto-WITH-fallback" — it attempts the automatic install, but on any
// failure it returns the EXACT manual commands (fallbackCommands) so the user
// is never stranded. detect+instruct is the floor, never a dead end.

// The heavy features that have an auto-provisioner. (englyph is detect+instruct
// only — no pip target until the englyph package ships — so it's deliberately
// absent here; realtime/music need only an API key, no runtime to install.)
export type ProvisionFeature = "localModels" | "voice";

export const PROVISIONABLE_FEATURES: readonly ProvisionFeature[] = ["localModels", "voice"];

export function isProvisionable(v: unknown): v is ProvisionFeature {
  return typeof v === "string" && (PROVISIONABLE_FEATURES as readonly string[]).includes(v);
}

// Optional build-type override for the local binary. "auto" picks CPU vs CUDA
// vs Vulkan from the detected GPU; the rest force a specific build (the manual
// escape hatch the handoff calls for, e.g. a CUDA box that wants the CPU build,
// or a Linux+NVIDIA box that prefers Vulkan over a hand-built CUDA).
export type BuildType = "auto" | "cpu" | "cuda" | "vulkan";

export interface ProvisionOptions {
  /** Local-binary build override. Ignored for voice. */
  buildType?: BuildType;
  /** Windows CUDA toolkit version to fetch (default "12.4" — broader driver
   *  compatibility than 13.x). Ignored unless the resolved build is CUDA. */
  cudaVersion?: string;
}

export type ProvisionPhase =
  | "resolving" // looking up the release / checking what's already present
  | "downloading" // pulling an asset (carries byte progress)
  | "verifying" // checksum check
  | "extracting" // unzip / untar into place
  | "installing" // running uv / pip (voice)
  | "starting" // hot-starting the subsystem after install
  | "done"
  | "error";

export interface ProvisionProgress {
  phase: ProvisionPhase;
  /** Human/agent-facing one-line status. */
  message?: string;
  /** Sub-step label, e.g. an asset name ("cudart") or a pip group ("torch"). */
  step?: string;
  stepIndex?: number;
  stepCount?: number;
  receivedBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  error?: string;
  /** On failure: the exact commands to run by hand (the detect+instruct floor). */
  fallbackCommands?: string[];
}

export interface ProvisionJob {
  id: string;
  feature: ProvisionFeature;
  status: "queued" | "active" | "done" | "error";
  progress: ProvisionProgress | null;
  error?: string;
  /** Mirrors progress.fallbackCommands once the job ends in error, so the tray
   *  can show the manual steps after the live progress clears. */
  fallbackCommands?: string[];
  startedAt: number;
}
