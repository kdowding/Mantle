// Voice provisioner — stand up the `.venv-streaming` Python sidecar that hosts
// chatterbox-streaming TTS + faster-whisper STT. This is the fragile tier: it
// downloads a managed Python and a multi-GB torch wheel, so it's best-effort
// with a printed-commands fallback the moment anything fails (the detect+instruct
// floor). Python is sourced via uv (one static binary, managed standalone Python)
// rather than a vendored embeddable — cross-platform, on-demand, clean.
//
// uv handles the hard part of torch: `--torch-backend=auto` queries the GPU and
// picks the matching CUDA (or CPU) wheel index, so we don't hand-resolve cuXXX.
//
// IMPORTANT: this only BUILDS the venv. Hot-starting the sidecar afterward is the
// manager's job (it owns the VoiceManager) — keeps this module dependency-light
// and unit-reasonable.

import { existsSync, mkdirSync, chmodSync } from "fs";
import { resolve } from "path";
import { downloadVerified, extractArchive, findFileRecursive, runCommand } from "./download.js";
import type { ProvisionProgress } from "./types.js";

// Pinned Python for the venv. chatterbox-streaming + torch 2.5+ support 3.9–3.12;
// 3.11 is the safe, widely-wheeled middle.
const VENV_PYTHON_VERSION = "3.11";

// The voice sidecar's runtime deps, split so torch/torchaudio install FIRST via
// uv's backend selector (otherwise a transitive pull would grab the default CPU
// wheel). chatterbox-streaming provides the `chatterbox` module the sidecar
// imports — NOT the turbo-era `chatterbox-tts`.
const TORCH_DEPS = ["torch", "torchaudio"];
const VOICE_DEPS = [
  "chatterbox-streaming",
  "faster-whisper",
  "fastapi>=0.115",
  "uvicorn[standard]",
  "pydantic>=2",
  "numpy",
  "librosa",
  "silero-vad",
];

const UV_RELEASES_API = "https://api.github.com/repos/astral-sh/uv/releases/latest";

interface GithubAsset {
  name: string;
  browser_download_url: string;
  digest?: string;
}

/** uv release asset basename for this platform/arch (Rust target triple). */
function uvAssetName(platform: NodeJS.Platform, arch: string): string | null {
  const a = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (!a) return null;
  if (platform === "win32") return `uv-${a}-pc-windows-msvc.zip`;
  if (platform === "darwin") return `uv-${a}-apple-darwin.tar.gz`;
  if (platform === "linux") return `uv-${a}-unknown-linux-gnu.tar.gz`;
  return null;
}

/**
 * Ensure a usable `uv` binary, returning its absolute path. Prefers a previously
 * downloaded copy under the cache, then downloads the latest release for this
 * platform (verified by SHA256) and extracts it. (We manage our own copy rather
 * than running uv's PATH-mutating install script — contained + removable.)
 */
async function ensureUv(
  cacheDir: string,
  onProgress: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const exe = process.platform === "win32" ? "uv.exe" : "uv";
  const cached = findFileRecursive(cacheDir, exe);
  if (cached) return cached;

  onProgress({ phase: "resolving", step: "uv", message: "Fetching the uv installer…" });
  const resp = await fetch(UV_RELEASES_API, {
    headers: { "User-Agent": "rev-mantle-provisioner", Accept: "application/vnd.github+json" },
    signal,
  });
  if (!resp.ok) throw new Error(`Couldn't reach the uv releases API (${resp.status}).`);
  const release = (await resp.json()) as { tag_name: string; assets: GithubAsset[] };
  const name = uvAssetName(process.platform, process.arch);
  if (!name) throw new Error(`No uv build for ${process.platform}/${process.arch}.`);
  const asset = release.assets.find((x) => x.name === name);
  if (!asset) throw new Error(`uv release ${release.tag_name} has no asset "${name}".`);

  mkdirSync(cacheDir, { recursive: true });
  const archive = resolve(cacheDir, name);
  onProgress({ phase: "downloading", step: "uv", message: `Downloading ${name}` });
  await downloadVerified(asset.browser_download_url, archive, { sha256: asset.digest, signal }, (p) =>
    onProgress({ phase: "downloading", step: "uv", message: `Downloading uv`, ...p }),
  );
  onProgress({ phase: "extracting", step: "uv", message: "Unpacking uv…" });
  await extractArchive(archive, cacheDir, signal);

  const uv = findFileRecursive(cacheDir, exe);
  if (!uv) throw new Error("uv binary not found after extraction.");
  if (process.platform !== "win32") {
    try {
      chmodSync(uv, 0o755);
    } catch {
      /* tar usually preserves the bit */
    }
  }
  return uv;
}

export interface VoiceDeps {
  basePath: string;
  /** Absolute path to the venv's python (config.voice.pythonPath resolved). */
  venvPython: string;
}

/** The exact manual commands, surfaced when the auto-install fails. */
export function voiceFallback(): string[] {
  const venvBin =
    process.platform === "win32" ? ".venv-streaming\\Scripts\\python.exe" : ".venv-streaming/bin/python";
  return [
    "# Install uv (https://docs.astral.sh/uv/):",
    process.platform === "win32"
      ? '#   powershell -c "irm https://astral.sh/uv/install.ps1 | iex"'
      : "#   curl -LsSf https://astral.sh/uv/install.sh | sh",
    "# Then, from the mantle project root:",
    `uv venv .venv-streaming --python ${VENV_PYTHON_VERSION}`,
    `uv pip install --python ${venvBin} ${TORCH_DEPS.join(" ")} --torch-backend=auto`,
    `uv pip install --python ${venvBin} ${VOICE_DEPS.map((d) => (d.includes(">") || d.includes("[") ? `"${d}"` : d)).join(" ")}`,
  ];
}

// uv prints download/resolve progress on its OWN cadence; map a few of its lines
// to coarse phases so the UI shows movement during the long torch pull.
function phaseForUvLine(line: string): ProvisionProgress["phase"] | null {
  if (/Downloading|Fetching|Resolved|Prepared/.test(line)) return "installing";
  return null;
}

/**
 * Build the `.venv-streaming` voice environment via uv: ensure uv → install a
 * managed Python → create the venv → install torch (GPU-aware) → install the
 * voice deps. Streams progress; throws on the first hard failure (the manager
 * attaches voiceFallback() to the job). Does NOT start the sidecar — the manager
 * hot-starts it after this resolves.
 */
export async function provisionVoice(
  deps: VoiceDeps,
  onProgress: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const cacheDir = resolve(deps.basePath, ".mantle/cache/provision/uv");
  const venvDir = resolve(deps.basePath, ".venv-streaming");

  const uv = await ensureUv(cacheDir, onProgress, signal);

  const run = async (args: string[], label: string): Promise<void> => {
    onProgress({ phase: "installing", step: label, message: `uv ${args[0]} — ${label}` });
    const res = await runCommand([uv, ...args], {
      cwd: deps.basePath,
      // Keep uv's package cache inside the project so the whole footprint is
      // contained + removable (and a re-provision is fast).
      env: { UV_CACHE_DIR: resolve(deps.basePath, ".mantle/cache/uv"), UV_NO_PROGRESS: "1" },
      signal,
      onLine: (line) => {
        const ph = phaseForUvLine(line);
        if (ph) onProgress({ phase: ph, step: label, message: line.slice(0, 160) });
      },
    });
    if (res.code !== 0) {
      throw new Error(`uv ${args[0]} (${label}) failed (exit ${res.code}):\n${res.tail.slice(-600)}`);
    }
  };

  // 1. Managed Python (uv downloads the standalone build if absent).
  onProgress({ phase: "installing", step: "python", message: `Installing managed Python ${VENV_PYTHON_VERSION}…` });
  await run(["python", "install", VENV_PYTHON_VERSION], "python");

  // 2. The venv.
  onProgress({ phase: "installing", step: "venv", message: "Creating .venv-streaming…" });
  await run(["venv", venvDir, "--python", VENV_PYTHON_VERSION], "venv");

  // 3. torch + torchaudio with GPU-aware backend selection (the big download).
  onProgress({ phase: "installing", step: "torch", message: "Installing torch (GPU-aware — this is the large one)…" });
  await run(["pip", "install", "--python", deps.venvPython, ...TORCH_DEPS, "--torch-backend=auto"], "torch");

  // 4. The voice stack.
  onProgress({ phase: "installing", step: "deps", message: "Installing the voice stack (chatterbox + whisper)…" });
  await run(["pip", "install", "--python", deps.venvPython, ...VOICE_DEPS], "deps");

  if (!existsSync(deps.venvPython)) {
    throw new Error(`Install finished but ${deps.venvPython} is missing — the venv didn't materialize.`);
  }

  onProgress({ phase: "starting", message: "Voice environment ready — starting the sidecar…" });
}
