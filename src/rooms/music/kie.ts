// Thin client for kie.ai's Suno music API. There is no official/public Suno
// API as of 2026-05; kie.ai is a third-party proxy. Two calls matter: kick off
// a generation (returns a taskId) and poll task status until the tracks land.
//
// Request rules (from docs.kie.ai/suno-api/generate-music):
//   customMode:false → only `prompt` (≤500 chars); style/title ignored, lyrics
//                      auto-written from the concept.
//   customMode:true  → `style` + `title` always required; if instrumental:false
//                      then `prompt` is sung as the EXACT lyrics.
//   `callBackUrl` is required (URI) even though we poll — a placeholder is fine
//   (a failed callback surfaces as CALLBACK_EXCEPTION, which doesn't block audio).

import { safeFetch, readResponseCapped } from "../../tools/core/net-guard.js";

// Accepted model ids (docs.kie.ai). V5_5 is current as of 2026-05.
export const KIE_MODELS = ["V5_5", "V5", "V4_5ALL", "V4_5PLUS", "V4_5", "V4"] as const;

// API responses are small JSON envelopes — cap well above any legitimate
// payload so a misbehaving proxy can't balloon memory via an unbounded
// .json() read.
const MAX_API_RESPONSE_BYTES = 1024 * 1024;

async function readJsonCapped(res: Response): Promise<Record<string, unknown>> {
  const { bytes, capped } = await readResponseCapped(res, MAX_API_RESPONSE_BYTES);
  if (capped) throw new Error("kie.ai response exceeded 1MB — refusing to parse");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export interface SunoTrack {
  id?: string;
  audioUrl?: string;
  streamAudioUrl?: string;
  imageUrl?: string;
  title?: string;
  tags?: string;
  duration?: number;
}

export type KieTaskState =
  | { status: "pending" }
  | { status: "complete"; tracks: SunoTrack[] }
  | { status: "failed"; reason: string };

export interface GenerateParams {
  // Style/genre descriptors (custom mode). Required by kie.ai in custom mode.
  style: string;
  // Track title (custom mode). Required by kie.ai in custom mode.
  title: string;
  // Instrumental (no vocals) vs vocal track.
  instrumental: boolean;
  // Exact lyrics, used only when customMode && !instrumental.
  lyrics?: string;
  // Suno model id; defaults to config.music.defaultModel.
  model?: string;
  // Custom mode (agent controls style+title). Defaults true. Set false for a
  // single free-form concept prompt with auto-written everything.
  customMode?: boolean;
  // Concept prompt used only when customMode === false.
  prompt?: string;
}

// Statuses that mean the task is dead — stop polling. CALLBACK_EXCEPTION is
// deliberately NOT here: it only means kie.ai couldn't reach our placeholder
// callback URL; the audio still generates and shows up under SUCCESS.
const FAILURE_STATUSES = new Set([
  "CREATE_TASK_FAILED",
  "GENERATE_AUDIO_FAILED",
  "SENSITIVE_WORD_ERROR",
]);

export class KieClient {
  constructor(
    private apiKey: string,
    private baseUrl: string,
    private defaultModel: string,
  ) {}

  async generate(params: GenerateParams, signal?: AbortSignal): Promise<{ taskId: string }> {
    const customMode = params.customMode ?? true;
    const instrumental = params.instrumental;
    const model = (params.model || this.defaultModel).trim();

    // In custom mode, `prompt` IS the lyrics field — so a prose placeholder
    // here gets SUNG, even with instrumental:true. The reliable vocal-kill for
    // Suno V5 is the structural tag `[Instrumental]` as the only lyrics content
    // (it reads as an instruction, not a style hint); instrumental:true +
    // "instrumental" in the style are belt-and-suspenders on top of it.
    const prompt = customMode
      ? instrumental
        ? "[Instrumental]"
        : (params.lyrics ?? "")
      : (params.prompt ?? params.style ?? "");

    const body: Record<string, unknown> = {
      prompt,
      customMode,
      instrumental,
      model,
      // Required by the API. We poll for completion rather than expose a public
      // webhook, so this never has to resolve.
      callBackUrl: "https://example.com/mantle-music-callback",
    };
    if (customMode) {
      body.style = params.style;
      body.title = params.title;
    }

    // safeFetch: SSRF-guarded (the base URL is config-supplied but the same
    // hardening posture as web_fetch applies — block loopback/RFC1918 +
    // re-validate each redirect hop) and the body read is capped.
    const res = await safeFetch(`${this.baseUrl}/generate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    const json = (await readJsonCapped(res)) as {
      code?: number;
      msg?: string;
      data?: { taskId?: string };
    };
    if (!res.ok || json.code !== 200 || !json.data?.taskId) {
      throw new Error(json.msg || `kie.ai generate failed (HTTP ${res.status})`);
    }
    return { taskId: json.data.taskId };
  }

  async check(taskId: string, signal?: AbortSignal): Promise<KieTaskState> {
    const url = `${this.baseUrl}/generate/record-info?taskId=${encodeURIComponent(taskId)}`;
    const res = await safeFetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal,
    });
    const json = (await readJsonCapped(res)) as {
      code?: number;
      data?: { status?: string; response?: { sunoData?: SunoTrack[] } };
    };
    // Transient API hiccup → report pending so the caller retries (bounded by
    // the manager's overall timeout).
    if (!res.ok || json.code !== 200 || !json.data) {
      return { status: "pending" };
    }
    const status = json.data.status ?? "PENDING";
    const tracks = json.data.response?.sunoData ?? [];
    if (status === "SUCCESS" && tracks.length > 0) {
      return { status: "complete", tracks };
    }
    if (FAILURE_STATUSES.has(status)) {
      return { status: "failed", reason: status };
    }
    // PENDING / TEXT_SUCCESS / FIRST_SUCCESS / CALLBACK_EXCEPTION → keep waiting.
    return { status: "pending" };
  }
}
