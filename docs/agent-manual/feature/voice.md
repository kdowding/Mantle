# Helping the user with voice

A usage guide for an agent helping its user with mantle's voice features. This is loaded on demand (via `mantle_guide`); the always-loaded manual (`docs/agent-manual/MANTLE.md`) only points here. Read this when the user wants to hear you speak, talk to you by mic, switch or tune a voice, or troubleshoot why audio isn't working.

Everything here describes how voice *works* and how to *help the user operate it* — it does not change who you are. Settings that touch real money (the hosted TTS backend) or rewrite a persisted voice config are the user's call to confirm; see [Confirmation](#what-needs-the-users-confirmation).

---

## What voice is, and the one rule that matters

Mantle has two voice directions, and they are **two independent switches** — never one unified "voice mode" toggle:

- **TTS-out** (text-to-speech): the agent's typed reply is *spoken aloud*. This is the "you talk" direction.
- **Mic-in** (speech-to-text): the user *speaks*, the browser captures and endpoints the utterance, and it's transcribed into the chat box as if typed. This is the "they talk" direction.

These are orthogonal. A user can have you speak while they type; type to you while listening; speak to you in silence; or run both at once. **Never propose collapsing them into a single control, and never assume turning one on implies the other.** If a user says "turn on voice," clarify which direction — most often they mean hearing you (TTS-out), but don't guess silently.

A third, separate thing is a **realtime call** (the lobby Call button) — a live phone-call-style conversation routed straight to xAI's Grok Voice Agent. That is *not* the TTS/mic loop described here; it's a different subsystem (conversational only, no tools, billed per minute) and has its own guide. When the user is in the normal chat surface, "voice" means the two toggles above.

### Why TTS-out and mic-in are independent under the hood

Both are served by one local **python voice sidecar** (a small FastAPI server, loopback only), but they're *different models* loaded *separately*:

- TTS-out uses **chatterbox** (a voice-cloning speech model) — unless the user picks the hosted xAI backend, which skips the sidecar entirely.
- Mic-in uses **faster-whisper** for transcription.

The sidecar loads TTS and STT engines on demand, and **STT defaults to NOT loading** — TTS-only sessions never pull the whisper model into memory. So the two directions genuinely don't share state; that's the mechanical reason the toggles stay separate.

---

## TTS-out: the two backends

When the agent speaks, the user chooses **one of two synthesis backends** in the profile bar — two mutually-exclusive toggles, "Chatterbox" or "xAI":

### 1. Chatterbox (local sidecar)

The python sidecar runs a local voice-cloning model on the user's GPU. It **clones a reference voice clip** (see [voice files](#voice-files-the-reference-clip)) so each agent can have a distinct, custom voice, and it **streams audio sub-chunk by sub-chunk** as it generates — so the user starts hearing the reply a second or two into generation rather than after the whole thing synthesizes.

- **Strengths**: custom per-agent voices (clone any clip), no per-character cost, low latency via streaming, expressive (the cloned voice carries its own character and an `exaggeration` knob dials emotional intensity), three live tuning knobs.
- **Costs / needs**: a GPU, the `.venv-streaming` python environment installed, and the sidecar process alive. Competes with local LLMs for VRAM. Can occasionally hallucinate a multi-second "sigh/yawn" tail (guarded against — see gotchas).

### 2. xAI hosted TTS

Hits xAI's hosted text-to-speech REST API directly (`POST https://api.x.ai/v1/tts`), authenticated with the **same `XAI_API_KEY`** as the Grok provider. No sidecar, no GPU, no local model. Returns one mp3 per sentence-chunk.

- **Strengths**: zero local setup — works on any machine with a Grok key, no GPU, no VRAM contention, no overshoot artifacts.
- **Costs / needs**: a paid xAI API key, and it's **metered per character** (xAI's announced rate was on the order of ~$4 per million characters — treat it as approximate and check xAI's current pricing). Voice choice is limited to xAI's fixed catalog — **eve, ara, rex, sal, leo** (or a custom xAI voice id) — you cannot clone an arbitrary clip. **No sub-chunk streaming** (each sentence comes back as one blob; mantle still pipelines whole sentences so it stays responsive, but a single long sentence has no intra-sentence streaming).

### Picking between them

- No GPU, or want it to "just work" on a laptop → **xAI** (needs a Grok key; costs per character).
- Want a unique cloned voice, no per-use cost, and have a GPU → **Chatterbox**.
- Running local LLMs and tight on VRAM → lean **xAI** to avoid the contention, or expect to manage which model is resident.

Switching backend is a per-conversation UI toggle and doesn't rewrite config — but **enabling xAI starts spending money**, so flag that the first time (see [Confirmation](#what-needs-the-users-confirmation)).

---

## Mic-in (speech-to-text)

When mic-in is on, the **browser** runs voice-activity detection locally, decides when the user has finished an utterance, and sends the finished clip to the sidecar's whisper model for transcription. The transcript lands in the chat input. Because the browser already endpointed the speech, mantle does **not** re-run VAD on the server side.

Two things to know when helping with mic-in:

- **STT is off by default and loads on first use.** The whisper model isn't resident until mic-in is actually engaged, so the very first transcription after enabling has a one-time model-load delay. After that it's warm.
- **The mic needs a secure context.** Browsers only grant microphone/WebRTC access over `localhost` or HTTPS. If the user reaches mantle over plain HTTP on a LAN/Tailscale address (not localhost), the browser will block the mic — they need TLS configured (a trusted cert via `mkcert` or `tailscale cert`). This is a browser rule, not a mantle setting.

Mic-in uses the local sidecar regardless of which **TTS** backend is selected — the xAI-vs-chatterbox choice is purely about *output*. (xAI hosted TTS does not provide the input/transcription path.)

---

## Voice files: the reference clip

This applies to **chatterbox only** (xAI uses its fixed catalog, not clips).

Each agent speaks in the voice of a `.wav` **reference clip** living in the repo's `voices/` directory. Resolution per agent:

1. The agent's selected **voice file** override (a basename like `echo.wav`), set via the profile-bar voice selector and persisted on the agent's config; falling back to
2. the legacy convention `voices/<agent-id>.wav`; and if neither file exists,
3. chatterbox TTS is simply unavailable for that agent (a clear "no voice file" signal, not a crash).

Any `.wav` in `voices/` can be assigned to any agent — the selector lists whatever's there. To **give an agent a new voice**, the user drops a clean reference clip into `voices/` and picks it in the selector. A short, clean, single-speaker clip clones best; very short clips are more prone to accent drift (which the `cfgWeight` knob counteracts — see tuning).

For the **xAI** backend, the analogous selection is the agent's **xAI voice id** (one of eve/ara/rex/sal/leo, or a custom xAI voice id); unset falls back to the global default voice (`ara`).

---

## The per-agent chatterbox knobs (tuning)

Chatterbox exposes exactly **three** runtime knobs. They resolve **per field**: an agent's own override wins, otherwise the global default applies. (The older "turbo-era" knobs — top_k, top_p, repetition_penalty, cfm_timesteps — are gone; the current streaming model doesn't expose them. If the user asks for those, explain they're baked in now and not tunable.)

| Knob | Range / default | What it does |
|---|---|---|
| **temperature** | ~0.5–0.9, default **0.7** | Sampling randomness. Lower = more deterministic, steadier delivery; higher = more varied. |
| **cfgWeight** | 0.0–1.0, default **1.0** | Classifier-free guidance — how strongly the model is anchored to the reference clip. 0.0 = no anchoring (voice character drifts, model prior leaks, and low values *invite* the hallucinated sigh/yawn tails); 1.0 = strong fidelity to the clip and suppresses those tails. **This is the accent-drift and tail-suppression lever.** The trade at 1.0 is less prosodic variation. |
| **exaggeration** | 0.0–1.0, default **0.5** | Emotion intensity. 0.0 = flat/monotone, 1.0 = highly expressive. Costs nothing at synth time (only re-prepared when the value changes). |

Guidance to pass on:

- **Accent drifting / voice doesn't sound like the clip** → raise `cfgWeight` toward 1.0 (especially on shorter reference clips).
- **Random sighs/yawns/long noise tails** → raise `cfgWeight` (low CFG freedom is what produces them). There are also automatic guards (below), but the knob is the real fix.
- **Voice sounds robotic / monotone** → raise `exaggeration`, and/or lower `cfgWeight` *slightly* (accepting some drift risk) for more dynamic prosody.
- **Delivery feels random / unstable run-to-run** → lower `temperature`.

The default `cfgWeight` of **1.0** is deliberately high — it's the most reliable production setting because it suppresses hallucinated tails and pins voice character. Dial it *down* per agent only when you want a more dynamic, less anchored persona and can tolerate the drift.

These knobs **do not apply to xAI** — that backend doesn't expose them. If the user is on xAI and asks to tune temperature/expressiveness, tell them those controls only exist on chatterbox.

### Previewing before saving

There's a non-persisting **preview** path (the tuning UI): synthesize a sample line with candidate knob values and listen, *without* changing the agent's saved config. Preview uses the slider values against the global defaults (it shows what the sliders alone would sound like, not the already-merged agent result). Encourage A/B-ing in preview, then **save** only the values the user likes — saving rewrites the agent's persisted voice config, so confirm intent.

---

## Seeing the current voice state

Before changing anything, read the current state. The pieces and where they come from:

- **Is voice even available?** The voice sidecar must be *enabled* in config and *alive* (running). If voice is disabled in config, the sidecar is never spawned and the whole feature is dark. If it's enabled but the process died, voice routes report the sidecar isn't running — point the user at the mantle logs (lines are prefixed `[voice:...]` / `[Mantle:voice]`).
- **Live sidecar status** (engine load states, devices, sample rate) and, alongside it, a **per-agent voice-file availability map** (which agents have a resolvable clip), the **per-agent selected voice file**, and the **list of available `.wav`s** in `voices/` — all surfaced by the voice status route the UI reads. The systems deck's **Connections** view also shows the live voice-subsystem state (whether voice is enabled in config and whether the sidecar process is alive).
- **An agent's effective knobs** — the global defaults plus that agent's overrides — are exposed by the per-agent voice config route the tuning modal reads.
- **xAI backend viability** is simply: is a Grok API key configured? No key → the xAI TTS toggle can't deliver.

When the user asks "what's my voice setup," assemble: sidecar enabled + alive? → which TTS backend is selected? → for chatterbox, which clip + what knobs? for xAI, which voice id + is the Grok key present? → is STT loaded (only matters if they're using the mic)?

You don't need to transcribe the exact route names or response fields — describe *what* to look at; the live UI and the status/connections surfaces are the source of truth, and the underlying field set may shift.

---

## Doing common operations

These are user-facing UI actions in the running app — your job is usually to *guide*, confirm intent, and interpret results, not to poke endpoints directly.

- **Hear the agent speak (turn on TTS-out)** — toggle voice-out on in the profile bar for the conversation. The reply will stream as audio. (If the user requested voice but the server can't deliver — sidecar down or no clip — the UI falls back to plain text streaming and signals that voice was unavailable; explain *why* rather than leaving it silent.)
- **Talk by mic (turn on mic-in)** — toggle the mic on; grant the browser mic permission; expect a one-time whisper-load delay on the first utterance. Requires localhost or HTTPS.
- **Re-hear a past message (replay)** — the per-message speaker icon re-synthesizes that bubble's existing text through the agent's current voice *without* re-running the agent. Replays run alongside chat (they don't block a live turn) and can be stopped individually. This is the cheap way to "say that again."
- **Switch TTS backend (chatterbox ↔ xAI)** — flip the profile-bar backend toggle. Per-conversation, not persisted. **Switching *to* xAI begins per-character billing** — flag it.
- **Pick a different reference clip (chatterbox)** — drop a `.wav` into `voices/` if needed, then choose it in the voice selector. This persists on the agent.
- **Pick an xAI voice** — set the agent's xAI voice id to one of eve/ara/rex/sal/leo (or a custom id). Persists on the agent.
- **Tune chatterbox knobs** — open the tuning UI, A/B in **preview**, then save. Saving persists per-agent overrides; **resetting** clears the agent's overrides back to the global defaults.
- **Stop audio mid-reply** — the normal `/stop` aborts in-flight synthesis too (it doesn't just mute shipping — it actually stops generating and drops the queued tail), so stopping is immediate, not "wait for the buffered audio to finish."

---

## What happens to your text in voice mode

Two layers cooperate so spoken output sounds natural — worth understanding so you write well for it:

1. **A voice-mode prompt instruction** is appended when TTS-out is active: write *spoken* English, not typed English. Short naturally-paced sentences; let punctuation drive prosody (periods = full stops, commas = short pauses, `?` lifts the end); **no markdown, code blocks, bullet lists, headers, or URLs read aloud**, and skip "e.g."/"i.e."/"etc." If you'd normally share code or a link, say "I'll drop it in the chat" instead of reading it. Persona is unchanged — voice mode changes the *form* of the reply, not who you are. (This instruction is **not** added for background/scheduled (cron) turns — nobody's listening.)
2. **A mechanical normalizer** in the sidecar cleans the text right before synthesis (chatterbox path): it strips markdown, URLs, emoji, code, and **every `[bracket]` tag**, turns em/en dashes into commas, expands `$`/`%`/`&`, spells out short acronyms, and — notably — **removes double-quotes**, because a literal `"` makes chatterbox emit a ~1.2-second "sigh." Separately, the server strips `[bracket]` content from the **on-screen bubble** too, so the user never sees raw `[chuckle]` in the text either.

The key thing about bracket tags: **don't rely on them.** It's tempting to write `[laugh]` or `[sigh]` expecting a sound effect — but the current chatterbox build vocalizes such tags as the literal *words* rather than rendering them as paralinguistic sounds, so the normalizer strips them outright. The net effect of writing `[laugh]` is *nothing* — no laugh, no text. Get expressiveness from the words themselves and the `exaggeration` knob, not from bracket notation. (The tag-stripping is a one-line revert in the sidecar if a future chatterbox release honors tags, but today it's off.)

The practical upshot for you: in voice mode, write clean spoken prose. You don't need to hand-strip markdown (the normalizer catches it), but the *prompt* asks you not to produce it in the first place because half-spoken markdown is jarring. Don't lean on quotation marks for emphasis in voice mode.

---

## Gotchas and failure modes

- **Sidecar not running.** Chatterbox TTS and all mic-in transcription need the python sidecar alive. If voice is *enabled* in config but the process isn't up, voice operations fail with a "sidecar is not running" signal. Causes: the `.venv-streaming` python env isn't installed, a spawn error at boot, or the sidecar crashed mid-session. **Mantle does not auto-restart a crashed sidecar** — the fix is to restart mantle. Check the `[voice:...]` log lines for the spawn/crash reason.
- **First call is slow (cold model load).** The sidecar spawns cheaply at startup but the ML models **lazy-load on first use**. The first TTS reply (or first mic transcription) pays a one-time load cost; subsequent ones are warm.
- **TTS and STT model loads are serialized, not parallel.** The sidecar deliberately loads TTS *then* STT sequentially. The underlying python loader races if both are imported from concurrent threads and fails with a *misleading* "cannot import name 'LlamaModel'" error. So if the user enables both directions at once on a cold start, the loads queue — that's by design, not a hang.
- **VRAM contention with local LLMs.** Chatterbox runs on the GPU and competes with any local llama.cpp model for VRAM. On a tight card, loading a big local model and chatterbox together can fail or thrash. Mitigations: use the **xAI** TTS backend (no GPU), run a smaller local model, or don't keep both resident. (The local-model config has a reserved-VRAM headroom that the "recommended settings" sizer leaves free partly *for* a small consumer like the TTS model — but it's a soft cushion the recommendation uses, not a hard runtime reservation, and chatterbox's real footprint can exceed it. The two genuinely share the card.)
- **Overshoot guards (chatterbox hallucinated tails).** Low `cfgWeight` lets the model tack on multi-second sighs/yawns/noise. Two automatic guards limit the damage: a python-side trim of the final sub-chunk, and a mid-stream guard that **aborts synthesis** once a chunk's cumulative audio exceeds a length-based budget (so a runaway tail stops shipping). Audio already sent still plays; nothing further fires. If a user reports occasional weird tails, the guards are why they're *short* — and raising `cfgWeight` is the real cure.
- **No streaming on xAI.** The xAI backend returns one audio blob per sentence (no sub-chunk streaming). Mantle still pipelines *across* sentences so it feels responsive, but a single very long sentence won't trickle in — it lands whole. If a user on xAI complains about a pause before a long sentence speaks, this is why; chatterbox would stream it.
- **Mic blocked off-localhost.** Covered above — no HTTPS (or non-localhost) means the browser denies the mic. This looks like "mic-in does nothing"; it's a TLS/secure-context problem, not a mantle bug.
- **No clip → no chatterbox voice for that agent.** If an agent has no selected voice file *and* no `voices/<agent-id>.wav`, chatterbox can't speak for it. The user picks or adds a clip. (xAI is unaffected — it has no clips.)
- **Backend toggle vs reality.** The user can have the xAI toggle selected, but with **no Grok key** it can't deliver — and the chatterbox toggle selected, but with the **sidecar down** it can't deliver. The UI signals unavailability and falls back to text; when diagnosing "no audio," check the *selected backend's* specific prerequisite (key vs sidecar+clip), not voice in the abstract.
- **Per-turn tuning logs.** When enabled (default on, bounded count per agent), each voice turn writes a detailed timing log under the runtime state dir. Gold while dialing in a voice, noise once it's set — the user can turn logging off in config once they're happy.

---

## What needs the user's confirmation

- **Switching the TTS backend to xAI** — it begins **per-character billing** against the Grok account. Flag the cost the first time; don't silently move them onto a metered path.
- **Saving tuned voice knobs / changing the selected clip or xAI voice id** — these **rewrite the agent's persisted voice config**. Preview freely (it persists nothing); confirm before *saving*. Resetting (back to global defaults) is also a persisted change — confirm it too.
- **Changing global voice defaults or disabling the sidecar in config** — these are config-level changes affecting *all* agents (and disabling the sidecar darkens voice on next start). Treat as deliberate, user-ratified edits.

Routine, no-confirm-needed: toggling TTS-out or mic-in for the current conversation, replaying a past bubble, previewing knob values, and reading status. These are reversible, per-conversation, and free (replay/preview on chatterbox cost only local GPU time; nothing bills).

---

## Related docs

- `docs/agent-manual/MANTLE.md` — the always-loaded operating manual (points here).
- The realtime-call (Grok Voice Agent) flow is a *separate* subsystem from this TTS/mic loop; if the user wants a live spoken *call* rather than spoken replies, that's covered elsewhere.
