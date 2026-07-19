// The llama-server asset planner is pure (platform/arch/accel + a release's
// asset list → the download plan), so the drift-prone part — does the naming
// scheme still match GitHub, do Windows-CUDA's two-asset and Linux's no-CUDA
// quirks resolve right — is unit-testable without touching the network.

import { describe, test, expect } from "bun:test";
import { resolveLlamaPlan, defaultAccel, chooseAccel, type ReleaseAsset } from "./llama-binary.js";

const TAG = "b9672";

// A trimmed copy of the real b9672 asset list (the relevant rows), with a fake
// digest on each so the planner's sha256 plumbing is exercised.
const ASSETS: ReleaseAsset[] = [
  "llama-b9672-bin-win-cpu-x64.zip",
  "llama-b9672-bin-win-cpu-arm64.zip",
  "llama-b9672-bin-win-cuda-12.4-x64.zip",
  "llama-b9672-bin-win-cuda-13.3-x64.zip",
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
  "cudart-llama-bin-win-cuda-13.3-x64.zip",
  "llama-b9672-bin-win-vulkan-x64.zip",
  "llama-b9672-bin-macos-arm64.tar.gz",
  "llama-b9672-bin-macos-x64.tar.gz",
  "llama-b9672-bin-ubuntu-x64.tar.gz",
  "llama-b9672-bin-ubuntu-arm64.tar.gz",
  "llama-b9672-bin-ubuntu-vulkan-x64.tar.gz",
].map((name) => ({
  name,
  browser_download_url: `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${name}`,
  digest: `sha256:${"a".repeat(64)}`,
}));

const plan = (platform: NodeJS.Platform, arch: string, accel: "cpu" | "cuda" | "vulkan", cudaVersion?: string) =>
  resolveLlamaPlan({ platform, arch, accel, tag: TAG, assets: ASSETS, cudaVersion });

describe("resolveLlamaPlan", () => {
  test("Windows + CUDA picks the main zip AND the cudart sidecar", () => {
    const p = plan("win32", "x64", "cuda");
    expect(p.primary.name).toBe("llama-b9672-bin-win-cuda-12.4-x64.zip");
    expect(p.cudart?.name).toBe("cudart-llama-bin-win-cuda-12.4-x64.zip");
    expect(p.label).toBe("CUDA 12.4");
    expect(p.primary.sha256).toMatch(/^sha256:/);
  });

  test("Windows + CUDA honors a 13.3 override on both assets", () => {
    const p = plan("win32", "x64", "cuda", "13.3");
    expect(p.primary.name).toBe("llama-b9672-bin-win-cuda-13.3-x64.zip");
    expect(p.cudart?.name).toBe("cudart-llama-bin-win-cuda-13.3-x64.zip");
  });

  test("Windows + CPU picks the cpu zip, no cudart", () => {
    const p = plan("win32", "x64", "cpu");
    expect(p.primary.name).toBe("llama-b9672-bin-win-cpu-x64.zip");
    expect(p.cudart).toBeUndefined();
  });

  test("Windows + Vulkan picks the vulkan zip", () => {
    expect(plan("win32", "x64", "vulkan").primary.name).toBe("llama-b9672-bin-win-vulkan-x64.zip");
  });

  test("macOS arm64 picks the universal arm64 build regardless of accel", () => {
    expect(plan("darwin", "arm64", "cpu").primary.name).toBe("llama-b9672-bin-macos-arm64.tar.gz");
    // accel is nominal on macOS — cuda request still lands on the same build
    expect(plan("darwin", "arm64", "cuda").primary.name).toBe("llama-b9672-bin-macos-arm64.tar.gz");
    expect(plan("darwin", "arm64", "cpu").label).toBe("Metal (built in)");
  });

  test("Linux x64 CPU + Vulkan resolve; Linux CUDA is unavailable", () => {
    expect(plan("linux", "x64", "cpu").primary.name).toBe("llama-b9672-bin-ubuntu-x64.tar.gz");
    expect(plan("linux", "x64", "vulkan").primary.name).toBe("llama-b9672-bin-ubuntu-vulkan-x64.tar.gz");
    // No prebuilt Linux CUDA — the planner refuses rather than guessing.
    expect(() => plan("linux", "x64", "cuda")).toThrow(/No cuda llama\.cpp build/);
  });

  test("a missing asset throws with the available builds listed", () => {
    const sparse: ReleaseAsset[] = [
      { name: "llama-b9672-bin-win-cpu-x64.zip", browser_download_url: "u", digest: "sha256:x" },
    ];
    expect(() => resolveLlamaPlan({ platform: "win32", arch: "x64", accel: "cuda", tag: TAG, assets: sparse })).toThrow(
      /no asset|Available builds/,
    );
  });
});

describe("accel selection", () => {
  test("defaultAccel: Windows+NVIDIA→cuda, no-GPU→cpu", () => {
    expect(defaultAccel("win32", "x64", true)).toBe("cuda");
    expect(defaultAccel("win32", "x64", false)).toBe("cpu");
  });

  test("defaultAccel: Linux+NVIDIA→vulkan (no prebuilt CUDA), no-GPU→cpu", () => {
    expect(defaultAccel("linux", "x64", true)).toBe("vulkan");
    expect(defaultAccel("linux", "x64", false)).toBe("cpu");
  });

  test("defaultAccel: macOS→cpu sentinel (Metal is in the build)", () => {
    expect(defaultAccel("darwin", "arm64", true)).toBe("cpu");
  });

  test("chooseAccel: explicit override wins over auto-detection", () => {
    expect(chooseAccel("cpu", "win32", "x64", true)).toBe("cpu"); // force CPU on a CUDA box
    expect(chooseAccel("vulkan", "win32", "x64", true)).toBe("vulkan");
    expect(chooseAccel("auto", "win32", "x64", true)).toBe("cuda");
  });
});
