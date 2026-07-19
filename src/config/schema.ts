// Legacy flat provider names. New backends are added as (vendor × mode) cells
// in src/agent/providers/catalog.ts; this union only backs the legacy → composite
// id migration (backend-ids.ts) + the ws message provider fields.
export type ProviderName = "claude" | "grok" | "openai-codex" | "grok-build" | "local";

export interface ProviderConfig {
  apiKey: string;
  defaultModel: string;
  models: string[];
}

// OpenAI Codex doesn't take an API key — auth lives in
// .mantle/auth/openai-codex.json (set up via `mantle auth login`). The
// `models` list still matters for the UI's model selector.
export interface OpenAICodexProviderConfig {
  defaultModel: string;
  models: string[];
}

// Grok Build doesn't take an API key either — auth is reused from grok
// build's own login at ~/.grok/auth.json (see src/auth/grok-build.ts).
// Same shape as OpenAICodexProviderConfig; `models` drives the UI selector.
export interface GrokBuildProviderConfig {
  defaultModel: string;
  models: string[];
}

// Local models don't take an API key — inference happens against a
// locally-spawned llama.cpp server (see src/local/manager.ts). The
// `models` list and `defaultModel` are SEEDED from local/registry.json at
// boot so the runtime model-lookup paths (ws / cron) resolve a
// valid id; the live source of truth is the registry, which the REST layer
// reads directly so models pulled while the server is up still surface.
export interface LocalProviderConfig {
  defaultModel: string;
  models: string[];
}

export interface AgentVoiceConfig {
  // Optional per-agent overrides for chatterbox synthesis. Any field left
  // unset falls back to config.voice.defaults. Three knobs (down from six
  // in the turbo era — chatterbox-streaming's generate_stream API doesn't
  // expose top_k/top_p/repetition_penalty/cfm_timesteps; they're baked
  // into the underlying generator).
  //
  //   temperature   — sampling temp. 0.5-0.9 typical, 0.7 default. Lower
  //                   = more deterministic delivery, higher = more varied.
  //   cfgWeight     — classifier-free guidance strength. The accent-
  //                   anchoring knob turbo dropped that we got back here.
  //                   0.0 = no speaker anchoring (model prior leaks, drift
  //                   audible); 0.5 = balanced; 1.0 = strong speaker
  //                   fidelity. Use for fixing accent drift on shorter
  //                   reference clips.
  //   exaggeration  — emotion intensity baked into the cached T3Cond via
  //                   prepare_conditionals. 0.0 = flat / monotone, 0.5 =
  //                   default, 1.0 = highly expressive. Costs nothing at
  //                   synth time — re-prepare only fires when changed.
  temperature?: number;
  cfgWeight?: number;
  exaggeration?: number;
}

export interface AssistAgentConfig {
  // Action keys (e.g. "cron.create") the deck assist may execute WITHOUT a
  // confirm card — the per-agent × per-action trust dial. Default: none, so
  // every structured mutation stages a confirm card. File-content edits are
  // NEVER auto-approved (they always go through the Cursor-style diff review).
  autoApprove?: string[];
}

export interface AgentConfig {
  id: string;
  name: string;
  workspace: string;
  // Composite backend id ("xai/api") or a legacy name — the loader normalizes
  // legacy → composite on load (mirrors MantleConfig.defaultProvider), and
  // resolveProviderTurn accepts both.
  defaultProvider?: string;
  defaultModel?: string;
  disabledSkills?: string[];
  enabledSkills?: string[];
  // Tool names this agent may NOT use. A hard per-agent capability gate:
  // disabled tools are stripped from EVERY advertised surface (chat,
  // cron, channel, subagent) at the front door — independent of
  // any per-trigger allow-list. Internal registry.execute calls (memory pack,
  // archivist, recall_* wrapper delegation) bypass it. Mirrors disabledSkills.
  disabledTools?: string[];
  // Deck-assist autonomy (the per-agent × per-action trust dial).
  assist?: AssistAgentConfig;
  avatar?: string;
  accentColor?: string;
  // Per-agent voice synthesis overrides. Resolution: agent.voice.<field>
  // → config.voice.defaults.<field>. Unset = use global defaults.
  voice?: AgentVoiceConfig;
  // Voice reference file basename (e.g. "echo.wav"). When unset, falls
  // back to the legacy convention voices/<agent-id>.wav. Set/changed via
  // the profile-bar voice selector dropdown — any .wav in voices/ can be
  // assigned to any agent.
  voiceFile?: string;
  // xAI TTS voice id used when the user has the xAI voice toggle active
  // instead of the chatterbox toggle. Same catalog as the realtime call
  // mode: eve, ara, rex, sal, leo (or a custom voice id). When unset,
  // falls back to config.realtime.defaultVoice ("ara").
  xaiVoice?: string;
  // Per-agent Englyph data directory. When set, this agent's MCP server
  // is spawned with ENGLYPH_PATH=<englyphPath>, isolating its memory pool
  // from other agents. May start with `~` (expanded to homedir).
  // When unset, defaults to `~/.rev-mantle/englyph-<agentId>` so newly
  // created agents are isolated by construction. Set it explicitly to a shared
  // path if you want several agents to read/write one common memory store.
  englyphPath?: string;
}

export interface SkillsConfig {
  disabled: string[];
}

export interface EnglyphConfig {
  enabled: boolean;
  pythonPath: string;
  // ── Daemon connection ────────────────────────────────────────────
  // Mantle does NOT manage the daemon's lifecycle. It expects an
  // ``englyph-daemon`` process to already be running and just spawns
  // per-agent ``englyph_mcp`` adapters that connect to it. Start the
  // daemon separately (``python -m englyph_daemon`` in another terminal,
  // or as a background service / scheduled task — it's designed to run
  // long-lived). Mantle's boot probes ``/healthz`` and falls through
  // gracefully if the daemon isn't up: agents work, just no memory.
  //
  // Both fields have sensible defaults matching the daemon's out-of-
  // the-box config:
  //   daemonUrl       → http://127.0.0.1:49765
  //   daemonAuthFile  → ~/.englyph/auth.json (the daemon bootstraps it
  //                     on first run; mantle reads the first token from
  //                     it on each adapter spawn)
  daemonUrl?: string;
  daemonAuthFile?: string;
  // How long mantle waits for the daemon's /healthz before giving up
  // and proceeding without englyph. 3s is enough for a warm daemon to
  // respond and short enough that a missing daemon doesn't stall boot.
  daemonProbeTimeoutMs?: number;
}

// xAI Grok Voice Agent (realtime call) configuration. Separate from
// VoiceConfig which governs the chatterbox TTS / whisper STT sidecar
// used by the regular agentic loop. Realtime calls go over a direct
// WebSocket to wss://api.x.ai/v1/realtime — no python sidecar involved.
export interface RealtimeConfig {
  // Master switch. Set false to hide the Call button in the lobby
  // entirely (calls don't work without an xAI API key anyway, so this
  // is the cleaner gate).
  enabled: boolean;
  // xAI model used for realtime sessions. "grok-voice-latest" aliases
  // to whichever flagship voice model is current (grok-voice-think-fast-1.0
  // as of 2025-12-17). Override only if you want to pin a specific model.
  defaultModel: string;
  // Voice used when the user hasn't picked one at call start. Built-ins:
  // eve, ara, rex, sal, leo. Custom voices supported via xAI's Custom
  // Voices API — set the custom voice id here to use it as the default.
  defaultVoice: string;
  // Hard cap on per-call duration in minutes. xAI bills $0.05/min and
  // the exact meter semantics (wall-clock vs audio-content) aren't
  // documented as of 2026-05 — default conservatively. 60 min max =
  // $3.00 worst-case per call. Mantle hard-closes the WS at the cap.
  maxMinutesPerCall: number;
}

export interface VoiceConfig {
  // When false, the voice sidecar is never spawned and voice mode in the
  // UI stays disabled. Set false on machines without a GPU / chatterbox
  // install / interest in voice features.
  enabled: boolean;
  // Path to the python interpreter used to run `voice.server`. Defaults
  // to the same .venv as Englyph since they share dependencies.
  pythonPath: string;
  // Loopback host + port for the HTTP sidecar. Loopback only — the sidecar
  // is an internal service, never exposed to the network.
  host: string;
  port: number;
  // How long mantle waits for the sidecar's /health to respond after spawn
  // before giving up. Uvicorn cold-start on Windows is ~3-5s typical.
  startupTimeoutMs: number;
  // Default chatterbox-streaming synthesis params used when the agent
  // doesn't override. The leaner knob set (vs the turbo era) reflects
  // generate_stream's API surface — only these three are tunable at
  // runtime per-call.
  defaults: {
    temperature: number;
    cfgWeight: number;
    exaggeration: number;
  };
  // Per-turn TTS tuning logs (.mantle/voice-logs/<agent>/...) — one file
  // per voice turn with the full chunk/synth/playback timeline. Gold for
  // dialing in a voice, noise once it's dialed. keepLast bounds the
  // per-agent file count (oldest pruned when a new log finalizes).
  turnLogs: {
    enabled: boolean;
    keepLast: number;
  };
}

// Local-model runtime (llama.cpp). Separate from the per-model registry
// (local/registry.json) which holds which models exist + their per-model
// spawn overrides. This block is the global runtime config: where the
// binary + weights live, the loopback endpoint the spawned llama-server
// listens on, and the spawn-knob defaults a model inherits when it doesn't
// override them. Mantle manages the llama-server process lifecycle the same
// way it manages the voice sidecar (spawn → poll /health → graceful kill).
export interface LocalModelsConfig {
  // Master switch. When false the local provider isn't registered and the
  // llama.cpp runtime is never spawned.
  enabled: boolean;
  // Directory (relative to mantle root, or absolute) holding the runtime
  // binary (bin/), downloaded GGUF weights (models/), and registry.json.
  // `mantle pull` writes here.
  modelsDir: string;
  // Path to the llama.cpp server binary (`llama-server[.exe]`). Relative
  // paths resolve against the mantle root. If the binary is missing at
  // boot the provider still registers but emits a clear error on use —
  // mantle boots fine, local inference is just unavailable until you drop
  // the (CUDA) build in place. Get it from github.com/ggml-org/llama.cpp
  // releases (Windows + NVIDIA: the `-bin-win-cuda-x64` build).
  binaryPath: string;
  // Loopback host + port the spawned llama-server listens on. Loopback
  // only — it's an internal service, never network-exposed.
  host: string;
  port: number;
  // How long mantle waits for a freshly-spawned llama-server's /health to
  // report ready. Cold-loading a multi-GB GGUF into VRAM is slow, so this
  // is generous. The provider feeds the agent loop's idle watchdog with
  // keep-alive ticks during the wait so a first-message cold load doesn't
  // trip the 90s stall timeout.
  loadTimeoutMs: number;
  // Auto-unload the active model after this many minutes idle to free
  // VRAM. 0 = keep loaded until a swap or shutdown.
  autoUnloadMinutes: number;
  // llama-server --parallel: number of concurrent request slots. Each slot
  // reserves its own slice of KV cache, so N slots ≈ N× the per-slot
  // context VRAM. Defaults to 1 — a companion harness is mostly a single
  // conversation at a time, so one slot gets the full context and the
  // minimum VRAM footprint. Raise it if chat + cron regularly
  // hit the same local model at once (otherwise the second request queues).
  parallel: number;
  // llama-server --log-verbosity. llama.cpp defaults high (3), which spams
  // per-request slot/prompt-cache/timing lines into mantle's log. 1 keeps
  // warnings + errors + the load summary but drops the per-turn firehose.
  logVerbosity: number;
  // VRAM (bytes) the "recommended settings" feature leaves free as headroom
  // when sizing context against the GPU — a cushion for fluctuation and for a
  // small consumer (e.g. the TTS model) loading after the model. The live
  // recommendation sizes context to fit (free VRAM − this). ~2 GB default.
  reservedVramBytes: number;
  // Per-model setting defaults. A registry entry overrides any of these.
  // Split by when they take effect:
  //   spawn-time (need a model reload): ctxSize, gpuLayers, threads
  //   per-request (apply on the next message): toolMode + all sampling knobs
  defaults: {
    // -c / --ctx-size, in tokens. 0 = use the model's trained context.
    ctxSize: number;
    // -ngl / --n-gpu-layers. -1 = offload everything to GPU (the right
    // default for the CUDA build). 0 = CPU only.
    gpuLayers: number;
    // --threads for the CPU path. 0 = llama.cpp auto.
    threads: number;
    // Which tools to advertise to the model:
    //   "off"  — none (chat-only)
    //   "core" — a curated ~14-tool set (filesystem, bash, web, memory).
    //            The right default: the full mantle tool surface (~76 tools)
    //            overflows llama.cpp's tool-call grammar AND overwhelms
    //            small models.
    //   "all"  — every registered tool (advanced / large models only; can
    //            trip llama.cpp's grammar-size limit).
    toolMode: "off" | "core" | "all";
    // Sampling. Sent per-request to llama-server's OpenAI endpoint, so
    // edits apply on the next message with no reload. -1 / undefined means
    // "let llama.cpp use its own default for this knob".
    temperature: number;
    topP: number;
    topK: number;
    minP: number;
    repeatPenalty: number;
    // Cap on generated tokens per turn. 0 = no cap (model/context bound).
    maxTokens: number;
    // ── Spawn-time (need a model reload) ──
    // KV-cache data type. f16 = full precision (default). q8_0 ≈ FP16
    // quality at ~half the KV memory → more context headroom (matters most
    // for big models / very long context; GQA models save less). q4_0 is
    // more aggressive (fine for chat, iffy for reasoning). Quantizing the V
    // cache requires flash attention, so the manager forces FA on when this
    // isn't f16. → --cache-type-k / --cache-type-v
    kvCacheType: "f16" | "q8_0" | "q4_0";
    // Flash attention. "auto" lets llama.cpp decide (on for modern GPUs),
    // "on"/"off" pin it. Forced on when kvCacheType is quantized. → -fa
    flashAttn: "auto" | "on" | "off";
  };
  // Optional HuggingFace token for `mantle pull` of gated/private repos.
  // Falls back to the HF_TOKEN env var.
  hfToken?: string;
}

// Music generation (Suno via kie.ai). There is no official/public Suno API as
// of 2026-05 — kie.ai is the third-party route. Boot-tolerant: with no key,
// generation is disabled but the player still serves any mp3s already on disk
// under .mantle/music/<agentId>/.
export interface MusicConfig {
  // Master switch. When false the generate_music tool isn't registered and
  // POST /api/music/generate refuses; the rest of the player still works.
  enabled: boolean;
  // kie.ai API key. The KIE_API_KEY env var overrides this. Empty = no
  // generation (the tool returns a clear "not configured" error).
  apiKey: string;
  // kie.ai API base — the Suno endpoints (generate, generate/record-info)
  // hang off this.
  baseUrl: string;
  // Suno model id passed to kie.ai. V5_5 is current as of 2026-05; older ids
  // (V5, V4_5, V4, V3_5) are selectable per-call via the tool's `model` arg.
  defaultModel: string;
  // Background poll cadence for in-flight generations (ms). kie.ai yields a
  // preview in ~20s and the full track in a few minutes, so 10s is plenty.
  pollIntervalMs: number;
  // Give up on a task after this many minutes (kie.ai stuck/failed) — the
  // pending entry is dropped with a log so the poller doesn't spin forever.
  maxPollMinutes: number;
}

export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

// Per-integration app credentials — the USER's OWN registered OAuth app
// (client id/secret) for OAuth integrations like Gmail/Outlook. PAT
// integrations (GitHub) need none. Tokens are NOT stored here — they live in
// the IntegrationBroker store (.mantle/auth/integrations/). Keyed by
// integration id in config.integrations.
export interface IntegrationCredentials {
  clientId?: string;
  clientSecret?: string;
  enabled?: boolean;
}

export interface SessionConfig {
  /** Compaction fires when a turn's live context reaches this FRACTION of the
   *  active model's resolved context window (0.6 = at 60% full). Per-model, so
   *  it tracks each window instead of a fixed token count that reads as a
   *  different % on every model (120k is 60% of a 200k window but 44% of 272k). */
  compactionFraction: number;
  maxUploadSizeMB: number;
  // Cap for files an agent attaches via attach_local_file /
  // attach_url_file. Separate from maxUploadSizeMB because user uploads
  // come over the wire (smaller is friendlier) but agent attachments
  // are reading off the host or fetching from URLs (where 10MB would
  // be too tight for "send me the report.pdf" type asks).
  agentAttachmentMaxSizeMB: number;
  /** Context-window size (tokens) per cloud model id — the "capable" ceiling
   *  the chat context gauge fills toward. The provider APIs don't report this,
   *  so it's a user-maintained lookup: VERIFY/ADJUST per your models. Local
   *  models ignore this (they use their live runtime context instead). */
  modelContextWindows: Record<string, number>;
  /** Fallback context window (tokens) for any cloud model not in the map. */
  defaultContextWindow: number;
}

export interface AuthConfig {
  // Gate /api/*, the /ws upgrade, and uploads behind a login cookie.
  // Default true. Override with config.server.auth.enabled=false or the
  // MANTLE_AUTH_DISABLED=1 env var for pure-loopback dev.
  enabled: boolean;
}

export interface TlsConfig {
  // PEM cert + private-key paths (absolute, or relative to basePath). When set,
  // Bun terminates TLS and the server speaks HTTPS, and the session cookie
  // gains its Secure flag. Absent → plain HTTP (fine for loopback dev or a
  // Tailscale-only reach, where WireGuard already encrypts the hop).
  //
  // Getting a trusted cert: `mkcert` for a LAN + tailnet multi-SAN cert
  // (install its root CA on each client device), or `tailscale cert` for a
  // publicly-trusted <machine>.<tailnet>.ts.net cert. A trusted cert is what
  // unlocks the browser "secure context" the mic/WebRTC need off localhost.
  certPath: string;
  keyPath: string;
}

export interface ServerConfig {
  port: number;
  host: string;
  auth: AuthConfig;
  // Optional HTTPS. A configured-but-missing cert is a fatal boot error, never
  // a silent downgrade to HTTP. See TlsConfig.
  tls?: TlsConfig;
}

export interface FilesystemToolConfig {
  // Absolute (or basePath-relative) roots the filesystem tools + attach_local_file
  // may read/write. Empty/absent → defaults at boot to the PARENT of basePath
  // (your projects folder), so cross-project work keeps working while the home
  // dir, ssh keys, and system files stay out of reach. `.mantle/auth` and
  // `.mantle/config.json` are ALWAYS denied regardless of this list.
  allowedRoots?: string[];
  // Directory basenames pruned during recursive glob_files/grep_files walks.
  // Absent → a built-in default (node_modules, .git, .venv, dist, __pycache__,
  // …; see DEFAULT_IGNORE_DIRS in tools/core/filesystem.ts). Set [] to walk
  // everything. Scoping a tool's `path` directly into an ignored dir still
  // searches it — only nested occurrences are pruned.
  ignoreDirs?: string[];
}

export interface ToolsConfig {
  filesystem?: FilesystemToolConfig;
}

export interface CronRunLogConfig {
  maxBytes: number;
  keepLines: number;
}

export interface CronEnglyphGlobalConfig {
  defaultStoreOutcome: boolean;
}

export interface CronGlobalConfig {
  enabled: boolean;
  maxJobsPerAgent: number;
  defaultSessionTarget: "isolated" | "persistent";
  defaultPriority: "low" | "normal" | "high" | "critical";
  autoDisableAfterErrors: number;
  scheduleErrorThreshold: number;
  runLog: CronRunLogConfig;
  englyph: CronEnglyphGlobalConfig;
}

export interface MantleConfig {
  providers: {
    claude: ProviderConfig;
    grok: ProviderConfig;
    openai: ProviderConfig;
    "openai-codex": OpenAICodexProviderConfig;
    "grok-build": GrokBuildProviderConfig;
    local: LocalProviderConfig;
  };
  // Composite backend id ("xai/api") or a legacy name — the loader normalizes
  // legacy → composite on load, and resolveProviderTurn accepts both.
  defaultProvider: string;
  agents: AgentConfig[];
  defaultAgent: string;
  // Bumped when a DEFAULT changes behavior in a way existing (omitting) configs
  // must be migrated past. A config FILE lacking this predates lean-default
  // features → loadConfig runs the preserve-old-behavior migration once, then
  // stamps it; saveConfig stamps it on every write so fresh/lean configs are
  // never mistaken for pre-lean ones.
  configVersion: number;
  /** The user's own profile — how agents should address them. Seeds {{user}} in
   * scaffolded workspace files; the create-time "owner" override wins when given. */
  user?: { name: string };
  globalSkillsDir: string;
  skills: SkillsConfig;
  englyph: EnglyphConfig;
  mcp: {
    servers: McpServerEntry[];
  };
  session: SessionConfig;
  server: ServerConfig;
  tools?: ToolsConfig;
  cron: CronGlobalConfig;
  voice: VoiceConfig;
  realtime: RealtimeConfig;
  localModels: LocalModelsConfig;
  music: MusicConfig;
  // External-service connectors (GitHub, Gmail, …). Per-id app credentials for
  // OAuth integrations (the user's OWN OAuth app) live here; tokens never do —
  // those go in the IntegrationBroker store (.mantle/auth/integrations/).
  integrations: Record<string, IntegrationCredentials>;

  // Resolved at load time
  basePath: string;

  // Deprecated — kept for backward compat, migrated to agents[] in loader
  workspace?: string;
}

// Config schema version — bump when a DEFAULT changes behavior in a way that an
// existing config OMITTING the key must be migrated past (see loadConfig's
// preserve-old-behavior migration). v1: lean-default features — voice / englyph /
// realtime / localModels / music default OFF; a pre-v1 config that omits them is
// migrated to ON so an upgrade never silently drops a feature the user had.
export const CONFIG_VERSION = 1;

// The heavy, optional subsystems that default OFF on a lean install and are the
// user-toggleable set (setup wizard, Features panel, PUT /api/config/features)
// AND the set migrated forward for pre-lean configs. ONE source so the migration,
// the toggle endpoint, and the readiness model can't drift. These are config-flag
// names; the readiness model surfaces `englyph` to users as "memory". (`cron` is
// deliberately NOT here — it's zero-setup, defaults on, and isn't an opt-in extra.)
export const HEAVY_FEATURES = ["voice", "englyph", "realtime", "localModels", "music"] as const;
export type HeavyFeature = (typeof HEAVY_FEATURES)[number];

export const DEFAULT_CONFIG: MantleConfig = {
  configVersion: CONFIG_VERSION,
  providers: {
    claude: {
      apiKey: "",
      defaultModel: "claude-sonnet-4-6",
      models: [
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "claude-haiku-4-5-20251001",
      ],
    },
    grok: {
      apiKey: "",
      // grok-4.5 is xAI's flagship ("the most intelligent and fastest model
      // we've built", 2026-07 docs) — 500k context, configurable reasoning
      // via `reasoning_effort` (low/medium/high; reasoning can't be disabled,
      // and an OMITTED param defaults to HIGH, so the provider always sends
      // an explicit value — see grok.ts REASONING_EFFORT_FLOOR). grok-4.3
      // keeps the fuller none/low/medium/high surface. The split-out
      // *-reasoning / *-non-reasoning models in earlier 4.x lines are
      // distinct model ids — pick the variant directly via the UI's model
      // dropdown rather than via the thinking toggle.
      defaultModel: "grok-4.5",
      models: [
        "grok-4.5",
        "grok-4.3",
        "grok-4.20-0309-reasoning",
        "grok-4.20-0309-non-reasoning",
        "grok-4-1-fast-reasoning",
        "grok-4-1-fast-non-reasoning",
      ],
    },
    openai: {
      // ChatGPT API (api.openai.com, Chat Completions) — the API-key
      // counterpart to the openai-codex subscription backend. Needs
      // OPENAI_API_KEY; surfaces in the picker as ChatGPT · API. API-side
      // reasoning support for the 5.6 models is unverified without a key, so
      // openai.ts's existing effort mapping remains unchanged.
      apiKey: "",
      defaultModel: "gpt-5.6-terra",
      models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4", "gpt-5.4-mini"],
    },
    "openai-codex": {
      // Verified 2026-07-17 against the client-version-filtered
      // `chatgpt.com/backend-api/codex/models?client_version=9.9.9` catalog.
      // The 5.6 trio supports low/medium/high/xhigh/max/ultra (Mantle ignores
      // orchestration-only ultra); gpt-5.4, mini, and spark support through
      // xhigh. Context is 272k except spark at 128k. Fast mode advertises the
      // `priority` service tier on the 5.6 trio and gpt-5.4 (plus gpt-5.5 if
      // hand-added), not mini/spark. gpt-5.5, gpt-5.3-codex, and gpt-5.2 are
      // retired from this list.
      defaultModel: "gpt-5.6-terra",
      models: [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex-spark",
      ],
    },
    "grok-build": {
      // No API key — auth is reused from grok build's login at
      // ~/.grok/auth.json (src/auth/grok-build.ts). The 2026-05-14 capture
      // showed a single model id "grok-build" (512k context) served from
      // cli-chat-proxy.grok.com/v1; the 2026-07 lineup adds grok-4.5 (500k)
      // behind the same proxy — the provider passes the id through as both
      // the body `model` and the x-grok-model-override header. "grok-build"
      // stays the default: it's the proxy's own alias, tracking whatever
      // the subscription serves by default.
      defaultModel: "grok-build",
      models: ["grok-build", "grok-4.5"],
    },
    // Seeded from local/registry.json at boot (see src/index.ts). Empty
    // until the user runs `mantle pull <hf-link>`.
    local: {
      defaultModel: "",
      models: [],
    },
  },
  defaultProvider: "xai/api",
  agents: [],
  defaultAgent: "",
  user: { name: "" },
  globalSkillsDir: "./skills",
  skills: {
    disabled: [],
  },
  basePath: ".",
  englyph: {
    // Off by default — Englyph (the memory daemon) is an external sidecar that
    // must be installed + running separately. A fresh clone stays a lean chat
    // harness with no memory probe at boot; opt in once the daemon is set up.
    enabled: false,
    pythonPath: process.platform === "win32" ? "./.venv/Scripts/python.exe" : "./.venv/bin/python",
    daemonProbeTimeoutMs: 3000,
  },
  mcp: {
    servers: [],
  },
  integrations: {},
  session: {
    // ~60% of a 200k window — compaction holds off until the conversation is
    // genuinely deep (was 80k/40%; bumped 2026-06-12).
    compactionFraction: 0.6,
    maxUploadSizeMB: 10,
    agentAttachmentMaxSizeMB: 50,
    // Seeded at a conservative default — VERIFY/ADJUST per provider docs (the
    // APIs don't report context size). Keys are model ids; misses fall back to
    // defaultContextWindow. Powers the chat context gauge's "window" ceiling
    // for the PRE-turn frame; once a turn lands, message_end carries the
    // authoritative window resolved server-side (resolveContextWindow, which
    // also covers local models + the Codex/API gpt-5.x window split). Local
    // model windows are merged in live at /api/config from the registry.
    defaultContextWindow: 200000,
    modelContextWindows: {
      "claude-opus-4-8": 200000,
      "claude-sonnet-4-6": 200000,
      "claude-haiku-4-5-20251001": 200000,
      "grok-4.5": 500000,
      "grok-4.3": 256000,
      "grok-4.20-0309-reasoning": 256000,
      "grok-4.20-0309-non-reasoning": 256000,
      "grok-4-1-fast-reasoning": 256000,
      "grok-4-1-fast-non-reasoning": 256000,
      "grok-build": 512000,
      // API-side windows: documented assumption mirroring gpt-5.5's 400k.
      // The openai-codex provider bypasses this map for its smaller windows.
      "gpt-5.6-sol": 400000,
      "gpt-5.6-terra": 400000,
      "gpt-5.6-luna": 400000,
      "gpt-5.5": 400000,
      "gpt-5.4": 400000,
      "gpt-5.4-mini": 400000,
    },
  },
  server: {
    port: 3333,
    // Loopback by default — the app is reachable only from the local machine
    // out of the box. Binding to all interfaces ("0.0.0.0") exposes it to the
    // LAN/network: only do that deliberately, with auth ON and TLS configured
    // (a plain-HTTP non-loopback bind leaks the session cookie on the wire).
    // First-run account setup is additionally restricted to loopback clients
    // (see auth-gate) so a network bind can't be claimed by the first stranger
    // to connect.
    host: "127.0.0.1",
    auth: { enabled: true },
  },
  cron: {
    enabled: true,
    maxJobsPerAgent: 20,
    defaultSessionTarget: "isolated",
    defaultPriority: "normal",
    autoDisableAfterErrors: 5,
    scheduleErrorThreshold: 3,
    runLog: {
      maxBytes: 2_000_000,
      keepLines: 2_000,
    },
    englyph: {
      defaultStoreOutcome: false,
    },
  },
  voice: {
    // Off by default — the TTS/STT sidecar needs a Python venv (.venv-streaming)
    // that a fresh clone doesn't have, so no sidecar spawn at boot until opted in.
    enabled: false,
    // The TTS/STT sidecar runs out of a Python venv at .venv-streaming/. The
    // interpreter lives under Scripts/ on Windows, bin/ on POSIX — pick by
    // platform so a non-Windows install points at a real path by default
    // (override in config.json if your venv lives elsewhere). Voice is optional;
    // when this path doesn't exist the sidecar simply isn't started.
    pythonPath:
      process.platform === "win32"
        ? "./.venv-streaming/Scripts/python.exe"
        : "./.venv-streaming/bin/python",
    host: "127.0.0.1",
    port: 7333,
    startupTimeoutMs: 30_000,
    defaults: {
      temperature: 0.7,
      // 1.0 = full speaker fidelity. Empirically the most reliable default
      // for production: high CFG constrains the model from producing the
      // hallucinated sigh/yawn/scream tails that low CFG (0.5) freedom
      // allows, AND it pins voice character to the reference clip
      // (suppresses accent drift). Trade is less prosodic variation —
      // dial down per-agent if you want a more dynamic persona.
      cfgWeight: 1.0,
      exaggeration: 0.5,
    },
    turnLogs: {
      enabled: true,
      keepLast: 200,
    },
  },
  realtime: {
    // Off by default — realtime voice calls need an xAI key and bill per minute.
    // Opt in once a Grok key is set so the Call affordance isn't a dead button.
    enabled: false,
    defaultModel: "grok-voice-latest",
    defaultVoice: "ara",
    maxMinutesPerCall: 60,
  },
  localModels: {
    // Off by default — local inference needs a user-supplied llama-server binary
    // (not bundled) plus a GGUF model. Opt in after dropping the binary in.
    enabled: false,
    modelsDir: "./local",
    // The binary isn't bundled (platform- and driver-specific, and large) —
    // auto-provision drops the right build here, or drop one in by hand
    // (Windows: llama-server.exe + its DLLs) or point this elsewhere.
    binaryPath: process.platform === "win32" ? "./local/bin/llama-server.exe" : "./local/bin/llama-server",
    host: "127.0.0.1",
    port: 8080,
    loadTimeoutMs: 300_000,
    autoUnloadMinutes: 0,
    parallel: 1,
    logVerbosity: 1,
    reservedVramBytes: 2_000_000_000,
    defaults: {
      ctxSize: 8192,
      // Offload everything to the GPU — the CUDA build's whole point.
      gpuLayers: -1,
      threads: 0,
      // Curated subset by default — the full ~76-tool surface overflows
      // llama.cpp's tool-call grammar and overwhelms small models.
      toolMode: "core",
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      minP: 0.05,
      repeatPenalty: 1.1,
      maxTokens: 0,
      kvCacheType: "f16",
      flashAttn: "auto",
    },
  },
  music: {
    // Off by default — music generation needs a kie.ai key and bills per song.
    // Opt in once the key is set.
    enabled: false,
    apiKey: "",
    baseUrl: "https://api.kie.ai/api/v1",
    defaultModel: "V5_5",
    pollIntervalMs: 10_000,
    maxPollMinutes: 12,
  },
};
