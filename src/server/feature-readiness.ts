// Feature readiness — the single source of truth for "is this optional feature
// on, and is it actually usable right now". Every gate that should grey-out a
// control (the mic button, the memory-pack toggle, the Call button, the music
// CC/transcribe button, the chatterbox vs xAI speak toggles) reads from ONE
// computed model so enforcement can't drift from what the Connections tab, the
// setup wizard, and the Features panel show.
//
// The computation is PURE: it takes the config plus an already-probed health
// snapshot (the async daemon/sidecar checks happen at the endpoint edge, in
// handleConnectionsApi) so it stays trivially testable and never does I/O.
//
// The model encodes a two-axis distinction that the honest UX depends on:
//   enabled — INTENT: the user turned the feature on (its config flag). For
//             capability-only features with no flag (xAI TTS) this mirrors `ready`.
//   ready   — REALITY: usable THIS INSTANT (flag on AND its key / sidecar /
//             daemon / binary is present and responding).
// A feature can be enabled:true, ready:false — the "on, but not set up yet"
// state that `setupHint` exists to explain (detect+instruct / auto-provision).

import type { MantleConfig } from "../config/schema.js";

export type FeatureId =
  | "memory"
  | "voice"
  | "ttsChatterbox"
  | "ttsXai"
  | "stt"
  | "realtime"
  | "localModels"
  | "music";

// off        — the user hasn't enabled it.
// ready      — enabled and usable right now.
// needs_key  — enabled/desired but missing an API key (set it in Providers).
// needs_setup — enabled but external setup is missing/down (sidecar, daemon, binary).
export type FeatureStatus = "off" | "ready" | "needs_key" | "needs_setup";

export interface FeatureReadiness {
  id: FeatureId;
  label: string;
  enabled: boolean;
  ready: boolean;
  status: FeatureStatus;
  /** Human/agent-facing current-state line. */
  detail: string;
  /** What to do to make it ready — present only when it isn't. */
  setupHint?: string;
}

// Live state the pure computation needs, probed once at the endpoint edge so the
// function below stays I/O-free. Mirrors the probes handleConnectionsApi already
// runs (Englyph /healthz, voice sidecar liveness, local runtime binary + count).
export interface FeatureHealth {
  englyphReachable: boolean;
  voiceAlive: boolean;
  localHasBinary: boolean;
  localModelCount: number;
}

export function computeFeatureReadiness(config: MantleConfig, health: FeatureHealth): FeatureReadiness[] {
  const grokKey = !!config.providers.grok.apiKey;
  const out: FeatureReadiness[] = [];

  // ── Memory (Englyph) — gates the memory-pack toggle + the recall tools ──
  {
    const enabled = config.englyph.enabled;
    if (!enabled) {
      out.push({ id: "memory", label: "Memory (Englyph)", enabled, ready: false, status: "off",
        detail: "Off — agents have no framed recall across sessions.",
        setupHint: "Enable memory to give agents recall across sessions." });
    } else if (health.englyphReachable) {
      out.push({ id: "memory", label: "Memory (Englyph)", enabled, ready: true, status: "ready",
        detail: "Englyph daemon reachable." });
    } else {
      out.push({ id: "memory", label: "Memory (Englyph)", enabled, ready: false, status: "needs_setup",
        detail: "On, but the Englyph daemon isn't responding.",
        setupHint: "Start the Englyph daemon separately (python -m englyph_daemon, port 49765) — mantle connects automatically once it responds. See the README's Englyph setup." });
    }
  }

  // ── Voice sidecar — the .venv-streaming host for BOTH chatterbox TTS and
  //    Whisper STT. Its readiness is the prerequisite the two capabilities below
  //    inherit (they load on demand inside this one process). ──
  const voiceEnabled = config.voice.enabled;
  const voiceReady = voiceEnabled && health.voiceAlive;
  if (!voiceEnabled) {
    out.push({ id: "voice", label: "Voice sidecar", enabled: voiceEnabled, ready: false, status: "off",
      detail: "Off — no speech in or out.",
      setupHint: "Enable voice to set up the local speech sidecar." });
  } else if (health.voiceAlive) {
    out.push({ id: "voice", label: "Voice sidecar", enabled: voiceEnabled, ready: true, status: "ready",
      detail: "Sidecar running." });
  } else {
    out.push({ id: "voice", label: "Voice sidecar", enabled: voiceEnabled, ready: false, status: "needs_setup",
      detail: "On, but the sidecar isn't running.",
      setupHint: "Set up the voice sidecar (.venv-streaming) — auto-provision available." });
  }

  // ── Chatterbox TTS (speech-out) — lives in the voice sidecar ──
  out.push(voiceCapability("ttsChatterbox", "Speech out (chatterbox)", voiceEnabled, voiceReady,
    "Local text-to-speech available.", "the agent's spoken replies"));

  // ── Whisper STT (speech-recognition) — powers BOTH the mic AND music lyric
  //    extraction. If this is off, the mic disables and music skips lyrics. ──
  out.push(voiceCapability("stt", "Speech recognition (Whisper)", voiceEnabled, voiceReady,
    "Mic input and song-lyric extraction available.", "the mic and music lyrics"));

  // ── xAI hosted TTS (speech-out) — key-gated, NO sidecar (hosted HTTP) ──
  out.push({
    id: "ttsXai", label: "Speech out (xAI hosted)",
    enabled: grokKey, ready: grokKey, status: grokKey ? "ready" : "needs_key",
    detail: grokKey ? "Hosted text-to-speech available (no sidecar needed)."
                    : "Needs a Grok API key.",
    setupHint: grokKey ? undefined : "Add your xAI (Grok) API key in Providers.",
  });

  // ── Realtime calls — flag AND Grok key ──
  {
    const enabled = config.realtime.enabled;
    if (!enabled) {
      out.push({ id: "realtime", label: "Realtime calls", enabled, ready: false, status: "off",
        detail: "Off.", setupHint: "Enable realtime calls for live voice conversations." });
    } else if (grokKey) {
      out.push({ id: "realtime", label: "Realtime calls", enabled, ready: true, status: "ready",
        detail: "Live voice calls available." });
    } else {
      out.push({ id: "realtime", label: "Realtime calls", enabled, ready: false, status: "needs_key",
        detail: "On, but needs a Grok API key.",
        setupHint: "Add your xAI (Grok) API key in Providers." });
    }
  }

  // ── Local models — flag, then the user-supplied binary, then ≥1 pulled model ──
  {
    const enabled = config.localModels.enabled;
    if (!enabled) {
      out.push({ id: "localModels", label: "Local models", enabled, ready: false, status: "off",
        detail: "Off.", setupHint: "Enable local models to run GGUF models via llama.cpp." });
    } else if (!health.localHasBinary) {
      out.push({ id: "localModels", label: "Local models", enabled, ready: false, status: "needs_setup",
        detail: "On, but the llama-server binary is missing.",
        setupHint: "Provision the local runtime — auto-download available." });
    } else if (health.localModelCount === 0) {
      out.push({ id: "localModels", label: "Local models", enabled, ready: false, status: "needs_setup",
        detail: "Binary present, but no models pulled yet.",
        setupHint: "Pull a GGUF model to run locally." });
    } else {
      out.push({ id: "localModels", label: "Local models", enabled, ready: true, status: "ready",
        detail: `${health.localModelCount} model(s) registered.` });
    }
  }

  // ── Music — NOTE: `ready` here means GENERATION-ready (needs a kie.ai key).
  //    The PLAYER itself works the moment music is enabled (upload your own), so
  //    gate any player control on `enabled`, never on `ready`. ──
  {
    const enabled = config.music.enabled;
    const musicKey = !!config.music.apiKey;
    if (!enabled) {
      out.push({ id: "music", label: "Music", enabled, ready: false, status: "off",
        detail: "Off.", setupHint: "Enable music to play and generate songs." });
    } else if (musicKey) {
      out.push({ id: "music", label: "Music", enabled, ready: true, status: "ready",
        detail: "Generation + player available." });
    } else {
      out.push({ id: "music", label: "Music", enabled, ready: false, status: "needs_key",
        detail: "On — player works (upload your own); generation needs a kie.ai key.",
        setupHint: "Add a kie.ai API key in Providers to generate songs." });
    }
  }

  return out;
}

// chatterbox TTS and Whisper STT are two capabilities of the one voice sidecar:
// each is off when voice is off, ready when the sidecar is alive, and otherwise
// "on but the sidecar isn't running" (same setup path as the voice host).
function voiceCapability(
  id: FeatureId,
  label: string,
  voiceEnabled: boolean,
  voiceReady: boolean,
  readyDetail: string,
  role: string,
): FeatureReadiness {
  if (!voiceEnabled) {
    return { id, label, enabled: false, ready: false, status: "off",
      detail: `Off — powers ${role} when the voice sidecar is on.` };
  }
  if (voiceReady) {
    return { id, label, enabled: true, ready: true, status: "ready", detail: readyDetail };
  }
  return { id, label, enabled: true, ready: false, status: "needs_setup",
    detail: "On, but the voice sidecar isn't running.",
    setupHint: "Set up the voice sidecar (.venv-streaming) — auto-provision available." };
}
