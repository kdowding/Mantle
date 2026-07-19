// Local-models provisioner — auto-download the llama.cpp `llama-server` binary
// (the one piece a fresh clone can't ship: it's platform- and GPU-specific and
// large). GGUF weights are already automated (src/local/pull.ts); this closes
// the other half so "enable Local models → Set up now" actually yields a usable
// runtime.
//
// llama.cpp publishes self-contained per-platform release zips on GitHub. The
// asset naming embeds the rolling build tag (`llama-bNNNN-bin-win-cuda-…`), so
// we resolve the LATEST release live rather than pinning a tag. Per-asset SHA256
// digests come straight from the GitHub API (the `digest` field) — we verify
// before installing. Two corrections vs the original handoff, learned from the
// live release list:
//   • Windows CUDA ships the CUDA runtime DLLs as a SEPARATE `cudart-…` asset;
//     the main cuda zip does NOT bundle them — both are fetched and merged.
//   • There is NO prebuilt Linux CUDA asset — Linux+NVIDIA resolves to Vulkan
//     (GPU acceleration that works on NVIDIA) instead.

import { existsSync, mkdirSync, cpSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { downloadVerified, extractArchive, findFileRecursive } from "./download.js";
import type { ProvisionOptions, ProvisionProgress, BuildType } from "./types.js";

export type Accel = "cpu" | "cuda" | "vulkan";

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  /** "sha256:<hex>" when GitHub has computed it (all current assets). */
  digest?: string;
}

export interface GithubRelease {
  tag_name: string;
  assets: ReleaseAsset[];
}

export interface AssetRef {
  name: string;
  url: string;
  sha256?: string;
}

export interface LlamaPlan {
  accel: Accel;
  /** Human label for the picked build, e.g. "CUDA 12.4" / "Metal (built in)". */
  label: string;
  primary: AssetRef;
  /** Windows-CUDA only — the separate CUDA-runtime-DLL asset to merge in. */
  cudart?: AssetRef;
}

const LLAMA_RELEASES_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest";

/** Fetch the latest llama.cpp release (tag + assets + per-asset digests). */
export async function fetchLatestLlamaRelease(signal?: AbortSignal): Promise<GithubRelease> {
  const resp = await fetch(LLAMA_RELEASES_API, {
    headers: { "User-Agent": "rev-mantle-provisioner", Accept: "application/vnd.github+json" },
    signal,
  });
  if (!resp.ok) {
    throw new Error(
      `Couldn't reach the llama.cpp releases API (${resp.status}).` +
        (resp.status === 403 ? " GitHub may be rate-limiting — try again shortly." : ""),
    );
  }
  const data = (await resp.json()) as GithubRelease;
  if (!data.tag_name || !Array.isArray(data.assets)) {
    throw new Error("Unexpected GitHub releases response (no tag/assets).");
  }
  return data;
}

/** Default accel for a platform+GPU. Windows+NVIDIA → CUDA; Linux+NVIDIA →
 *  Vulkan (no prebuilt Linux CUDA); macOS → the universal build (Metal baked
 *  in); everything else → CPU. */
export function defaultAccel(platform: NodeJS.Platform, arch: string, hasNvidia: boolean): Accel {
  if (platform === "darwin") return "cpu"; // nominal — the macOS build has Metal compiled in
  if (platform === "win32") return hasNvidia && arch === "x64" ? "cuda" : "cpu";
  if (platform === "linux") return hasNvidia ? "vulkan" : "cpu";
  return "cpu";
}

/** Resolve a build-type override (or "auto") to a concrete accel. */
export function chooseAccel(
  buildType: BuildType,
  platform: NodeJS.Platform,
  arch: string,
  hasNvidia: boolean,
): Accel {
  if (!buildType || buildType === "auto") return defaultAccel(platform, arch, hasNvidia);
  return buildType;
}

function accelLabel(platform: NodeJS.Platform, accel: Accel, cudaVersion: string): string {
  if (platform === "darwin") return "Metal (built in)";
  if (accel === "cuda") return `CUDA ${cudaVersion}`;
  if (accel === "vulkan") return "Vulkan";
  return "CPU";
}

// Map (platform, arch, accel) → the primary asset basename, or null when that
// build isn't published. macOS ignores accel (one universal build per arch).
function primaryAssetName(
  platform: NodeJS.Platform,
  arch: string,
  accel: Accel,
  tag: string,
  cudaVersion: string,
): string | null {
  if (platform === "darwin") {
    if (arch === "arm64") return `llama-${tag}-bin-macos-arm64.tar.gz`;
    if (arch === "x64") return `llama-${tag}-bin-macos-x64.tar.gz`;
    return null;
  }
  if (platform === "win32") {
    if (arch === "arm64") return accel === "cpu" ? `llama-${tag}-bin-win-cpu-arm64.zip` : null;
    if (arch !== "x64") return null;
    if (accel === "cuda") return `llama-${tag}-bin-win-cuda-${cudaVersion}-x64.zip`;
    if (accel === "vulkan") return `llama-${tag}-bin-win-vulkan-x64.zip`;
    return `llama-${tag}-bin-win-cpu-x64.zip`;
  }
  if (platform === "linux") {
    const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
    if (!a) return null;
    if (accel === "cuda") return null; // no prebuilt Linux CUDA — caller resolves to vulkan
    if (accel === "vulkan") return `llama-${tag}-bin-ubuntu-vulkan-${a}.tar.gz`;
    return `llama-${tag}-bin-ubuntu-${a}.tar.gz`;
  }
  return null;
}

function findAsset(assets: ReleaseAsset[], name: string): AssetRef | null {
  const a = assets.find((x) => x.name === name);
  return a ? { name: a.name, url: a.browser_download_url, sha256: a.digest } : null;
}

function availableHint(assets: ReleaseAsset[]): string {
  const names = assets.map((a) => a.name).filter((n) => /^llama-.*\.(zip|tar\.gz)$/.test(n));
  return names.length ? `Available builds: ${names.join(", ")}.` : "";
}

/**
 * Pure asset planner: given the platform/arch/accel and a release's asset list,
 * pick the primary download (and the cudart sidecar on Windows-CUDA). Throws a
 * clear, instruct-worthy error when the requested build isn't published, so the
 * UI can fall back to "download it yourself from the releases page".
 */
export function resolveLlamaPlan(opts: {
  platform: NodeJS.Platform;
  arch: string;
  accel: Accel;
  tag: string;
  assets: ReleaseAsset[];
  cudaVersion?: string;
}): LlamaPlan {
  const cudaVersion = opts.cudaVersion || "12.4";
  const name = primaryAssetName(opts.platform, opts.arch, opts.accel, opts.tag, cudaVersion);
  if (!name) {
    throw new Error(
      `No ${opts.accel} llama.cpp build is published for ${opts.platform}/${opts.arch}. ${availableHint(opts.assets)}`,
    );
  }
  const primary = findAsset(opts.assets, name);
  if (!primary) {
    throw new Error(`Release ${opts.tag} has no asset "${name}". ${availableHint(opts.assets)}`);
  }
  let cudart: AssetRef | undefined;
  if (opts.platform === "win32" && opts.accel === "cuda") {
    const cudartName = `cudart-llama-bin-win-cuda-${cudaVersion}-x64.zip`;
    const found = findAsset(opts.assets, cudartName);
    if (!found) {
      throw new Error(`CUDA runtime asset "${cudartName}" is missing from release ${opts.tag}. ${availableHint(opts.assets)}`);
    }
    cudart = found;
  }
  return { accel: opts.accel, label: accelLabel(opts.platform, opts.accel, cudaVersion), primary, cudart };
}

export interface LocalBinaryDeps {
  basePath: string;
  /** Absolute path the binary must end up at (config.localModels.binaryPath). */
  binaryPath: string;
  /** Whether an NVIDIA GPU was detected (drives the auto build pick). */
  hasNvidia: boolean;
}

/** The manual fallback commands, surfaced when the auto-download fails. */
export function localBinaryFallback(binaryPath: string): string[] {
  return [
    "# Download the llama.cpp release build for your platform/GPU from:",
    "#   https://github.com/ggml-org/llama.cpp/releases/latest",
    "# Windows+NVIDIA: the llama-*-bin-win-cuda-12.4-x64.zip AND the matching",
    "#   cudart-llama-bin-win-cuda-12.4-x64.zip (both, extracted together).",
    `# Then place llama-server(.exe) + its DLLs at: ${dirname(binaryPath)}`,
  ];
}

/**
 * Resolve + download + verify + extract the llama-server binary into the
 * configured bin directory. Streams progress. Throws on failure (the manager
 * wraps the throw into a job error carrying localBinaryFallback()).
 */
export async function provisionLocalBinary(
  deps: LocalBinaryDeps,
  opts: ProvisionOptions,
  onProgress: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const platform = process.platform;
  const arch = process.arch;
  const binDir = dirname(deps.binaryPath);

  onProgress({ phase: "resolving", message: "Looking up the latest llama.cpp release…" });
  const release = await fetchLatestLlamaRelease(signal);

  const accel = chooseAccel(opts.buildType ?? "auto", platform, arch, deps.hasNvidia);
  const cudaVersion = opts.cudaVersion || "12.4";
  const plan = resolveLlamaPlan({ platform, arch, accel, tag: release.tag_name, assets: release.assets, cudaVersion });
  onProgress({
    phase: "resolving",
    message: `llama.cpp ${release.tag_name} · ${plan.label} build for ${platform}/${arch}`,
  });

  const staging = resolve(deps.basePath, ".mantle/cache/provision", `llama-${release.tag_name}`);
  mkdirSync(staging, { recursive: true });

  const downloads = [plan.primary, ...(plan.cudart ? [plan.cudart] : [])];
  for (let i = 0; i < downloads.length; i++) {
    const a = downloads[i];
    const dest = resolve(staging, a.name);
    await downloadVerified(a.url, dest, { sha256: a.sha256, signal }, (p) =>
      onProgress({
        phase: "downloading",
        step: a.name,
        stepIndex: i + 1,
        stepCount: downloads.length,
        message: `Downloading ${a.name}`,
        ...p,
      }),
    );
    onProgress({
      phase: "verifying",
      step: a.name,
      stepIndex: i + 1,
      stepCount: downloads.length,
      message: a.sha256 ? `Verified ${a.name} (SHA256 OK)` : `Downloaded ${a.name}`,
    });
  }

  onProgress({ phase: "extracting", message: "Unpacking the runtime…" });
  const mainOut = resolve(staging, "main");
  rmSync(mainOut, { recursive: true, force: true });
  await extractArchive(resolve(staging, plan.primary.name), mainOut, signal);

  const exeName = platform === "win32" ? "llama-server.exe" : "llama-server";
  const foundExe = findFileRecursive(mainOut, exeName);
  if (!foundExe) {
    throw new Error(`The extracted archive contained no ${exeName} — the release layout may have changed.`);
  }
  const srcDir = dirname(foundExe);
  mkdirSync(binDir, { recursive: true });
  // Copy the whole bin dir (server + the other llama tools + ggml/llama shared
  // libs that sit alongside) into the target — the same "drop the build here"
  // a manual install does.
  cpSync(srcDir, binDir, { recursive: true });

  if (plan.cudart) {
    onProgress({ phase: "extracting", step: "cudart", message: "Merging the CUDA runtime DLLs…" });
    const cudartOut = resolve(staging, "cudart");
    rmSync(cudartOut, { recursive: true, force: true });
    await extractArchive(resolve(staging, plan.cudart.name), cudartOut, signal);
    cpSync(cudartOut, binDir, { recursive: true });
  }

  if (!existsSync(deps.binaryPath)) {
    throw new Error(`Install finished but ${deps.binaryPath} is still missing — check the bin directory.`);
  }

  // Best-effort staging cleanup (multi-hundred-MB archives we no longer need).
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    /* leave it — non-fatal */
  }

  onProgress({
    phase: "done",
    message: `llama-server installed (${plan.label}). Pull a GGUF model to start running it locally.`,
  });
}
