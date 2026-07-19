# Helping the user with local models

A usage guide for an agent helping its user run inference on a **locally hosted model** — a backend that sits in the same picker as Claude, Grok, and ChatGPT, but runs on the user's own GPU at zero per-token cost. This is loaded on demand (via `mantle_guide`); the always-loaded manual (`docs/agent-manual/MANTLE.md`) only points here. Read this when the user wants to set up local inference, download a model from Hugging Face, pick or switch a local model, tune its settings, or troubleshoot why a local model won't load.

Everything here describes how the local-model subsystem *works* and how to *help the user operate it*. The one thing it can't fix for them is a missing binary: mantle does **not** ship the llama.cpp server itself — the user supplies it (see [The binary is not bundled](#the-prerequisite-the-binary-is-not-bundled)). Settings that download multi-gigabyte files, delete weights from disk, or rewrite a model's persisted config are the user's call to confirm; see [Confirmation](#what-needs-the-users-confirmation).

---

## What local models are, and the rule that matters

Local inference runs through a managed **llama.cpp `llama-server` child process** that mantle spawns, health-checks, and tears down — the same lifecycle pattern as the voice sidecar. That server speaks an **OpenAI-compatible API** on a local loopback port (default `127.0.0.1:8080`), which is why a local model slots into the backend picker like any cloud one: to the rest of mantle it's just another OpenAI-shaped provider.

The load-bearing rule: **llama-server serves exactly ONE model per process.** There is no keep-warm pool of several models. "Switching model" therefore means **kill the running server and respawn it with the new one** — and that swap is serialized (one load at a time) and **refused while a model is mid-stream** (tearing the server down during a live turn would corrupt it). So local models are cheap to *run* but not instant to *switch*: each switch is a cold respawn, and a big model's first load can take many seconds.

Nothing spawns until a local model is actually used — selecting one warms it, or the first message loads it lazily. When you're not using local inference, no VRAM is held.

---

## The prerequisite: the binary is NOT bundled

**Mantle does not ship `llama-server`.** The binary is platform- and GPU-driver-specific (and large), so the user must download it themselves and drop it in place. The default expected location is:

```
local/bin/llama-server.exe
```

(relative to the mantle install; configurable via `localModels.binaryPath`). On Windows + NVIDIA, that's the `llama-server.exe` from llama.cpp's `-bin-win-cuda-x64` release, **plus its DLLs** in the same folder. Other platforms/GPUs use the matching llama.cpp build.

If the binary is missing, any attempt to load a local model fails with a clear "llama.cpp server not found at &lt;path&gt;" error that names the path and tells the user what to download. When a user reports "local models don't work," **check this first** — it's the single most common cause, and it's not a mantle bug, it's a missing dependency the user owns. The systems/connections surface and the status route both report whether the binary is present.

---

## Getting models: `mantle pull` and the in-UI browser

A local model is a **GGUF file** downloaded from Hugging Face and recorded in a local **registry**. There are two ways to get one, both driven by the same shared download+register engine (`src/local/pull.ts`), so they can't drift:

- **`mantle pull <spec>`** — the CLI path. Works whether the server is up or down (it writes the registry directly). A spec can be a full `huggingface.co` URL, `org/repo:quant` (e.g. `:Q4_K_M`), or `org/repo:file.gguf`. If a repo has several quants and you don't name one, the tool lists the options and asks you to pick — it won't guess. Split GGUFs (`*-00001-of-0000N.gguf`) are auto-expanded and downloaded whole.
- **The in-UI Hugging Face browser** — a search/browse surface in the app that lists GGUF repos, shows each repo's quants with sizes, and (when GPU VRAM is known) marks which quants **fit** / are **tight** / are **too big**, with a recommended pick. Downloads run in a background queue the UI polls for progress; finished models register automatically.

On a successful pull, mantle **auto-configures** the fresh model: it sizes a sensible context window to the GPU (a balanced ~32K ceiling) and records sane KV/flash-attn settings, so the model arrives usable rather than stuck on a generic default. It also derives a couple of capability flags from the model — whether it's a **reasoning** model and whether its chat template advertises **tool calls** — and records those (a no-tool template gets tool mode `off` automatically).

Downloads stream to a `.part` file and only rename into place on a verified-complete transfer, so a dropped connection won't leave a half-downloaded GGUF that fails confusingly at load time.

**Gated/private repos** need a Hugging Face token — set `localModels.hfToken` in config or the `HF_TOKEN` env var. A `401/403` from HF in a pull error usually means exactly this.

---

## Selecting and managing models

Once a model is in the registry it's a backend like any other:

- **Pick it in the profile bar** — the backend picker cascades vendor → mode → model; "Local" is one of the modes, and its model dropdown lists whatever's in the registry. Selecting a local model is what warms the server.
- **Make a default** — one registered model is the registry's default (the first one pulled, unless changed). `mantle models set <id> --default` (or the UI) repoints it.
- **List** — `mantle models` (or `mantle models list`) shows the registry; the registry is read **live** every call, so a model pulled while the server is running shows up without a restart.
- **Remove** — `mantle models rm <id>` drops it from the registry; add `--file` to also delete the GGUF from disk (the registry-only removal leaves the weights, in case the user wants to re-register later). **Deleting the file is irreversible** — confirm.

The registry lives at `local/registry.json` and is dependency-free, which is why the CLI can read and write it with the server down.

---

## The per-model knobs: instant vs reload-required

Each registered model carries optional overrides; anything unset falls back to the global `localModels.defaults`. The knobs split into two classes, and **the split matters** because one takes effect on the next message and the other forces a server respawn:

| Knob | Class | Notes |
|---|---|---|
| Tool mode (`--tools off\|core\|all`) | **instant** | Sent per-request; the next message uses the new surface. |
| Reasoning on/off (`--reasoning`) | **instant** | Whether the model is treated as a chain-of-thought model. |
| Sampling — temperature, top-p, top-k, min-p, repeat-penalty, max-tokens | **instant** | Per-request sampling; edits apply on the next turn, no reload. |
| Context size (`--ctx`) | **reload** | `-c` — needs a respawn to change. `0` = the model's trained context. |
| GPU layers (`--ngl`) | **reload** | `-1` = offload all layers to the GPU; `0` = CPU only. |
| Threads (`--threads`) | **reload** | `0` = llama.cpp auto. |
| KV-cache type (`--kv-cache f16\|q8_0\|q4_0`) | **reload** | Quantizing the KV cache buys context at a small quality cost. |
| Flash attention (`--flash-attn auto\|on\|off`) | **reload** | Forced on automatically when the KV cache is quantized. |

Set them with `mantle models set <id> <flags>` or in the UI. A reload-class change to the **currently loaded** model only takes hold when the server next respawns (the next swap, or an explicit unload + reload). An instant-class change just lands on the next message. To wipe a model's overrides back to the global defaults, there's a reset path (CLI/UI) that clears the sampling + spawn + tool-mode overrides while leaving identity and model traits intact.

There's also a **"recommend settings"** helper: it measures live free VRAM, reads the model's parameter count and trained context, and proposes a context size + KV type that fit the budget — handy when the user asks "what should I set this to for my GPU."

---

## Tool modes — and why a curated "core" set exists

A local model advertises a **tool surface** chosen by its tool mode:

| Mode | What it advertises |
|---|---|
| `off` | No tools at all. The model can't emit tool calls. |
| `core` | A small **curated set of 14 tools** (the default). |
| `all` | The full mantle tool surface (~76 tools). |
| `custom` | Exactly the tool names the user lists for that model. |

**Why `core` is the default, and why it's small:** llama.cpp's `--jinja` chat template builds a tool-call *grammar* from the advertised tools, and the **full ~76-tool surface overflows that grammar's size limit and swamps small models** — they lose the thread when handed dozens of schemas. So mantle ships a curated 14-tool subset covering the essentials: the filesystem tools (read/write/edit/list/glob/grep), `bash`, `web_fetch`, the core memory tools (`remember`, `recall`, `recall_source`, `memory_status`), and session reading (`sessions_list`, `sessions_history`). It's enough to be a capable companion without drowning a 7B model.

Guidance to pass on:

- **Small model acting confused or ignoring tools?** Stay on `core` (or even drop to `custom` with just `read_file`/`recall` to save context). Don't reach for `all` on a small model — it's the thing that breaks them.
- **Large, capable local model that handles the full surface?** `all` is reasonable; it advertises everything.
- **Want a model that never calls tools** (pure chat)? `off`.

Pinned per-turn pseudo-tools (the ones the front door injects for things like channels) survive curation in every mode except `off`.

A crucial note: the `--jinja` flag is **load-bearing** — it activates the model's own chat template, which is what makes OpenAI-style tool calls work at all. Mantle always passes it; tool-aware models need it.

---

## Reasoning / `<think>` handling

A model flagged as a **reasoning** model (DeepSeek-R1, Qwen3, QwQ, and the like) gets two things: the provider splits inline `<think>…</think>` chain-of-thought out of the content (so it surfaces as thinking, not as the answer), and the thinking toggle maps to llama.cpp's `enable_thinking` template kwarg for hybrid reasoners. The reasoning flag is set automatically at pull time when the model's id or chat template indicates chain-of-thought, but the user can flip it with `--reasoning on|off` if the auto-detection got it wrong. (Non-reasoning models ignore the kwarg harmlessly.)

---

## VRAM realities

Local inference runs on the GPU, and VRAM is the binding constraint:

- **Detection is NVIDIA-only** (via `nvidia-smi`, best-effort). On a non-NVIDIA GPU or a machine without `nvidia-smi`, mantle simply can't show fit hints — it falls back to "load it and watch for an out-of-memory error." That's a missing convenience, not a failure.
- **A reserved-VRAM headroom** (`reservedVramBytes`, default ~2 GB) is left free so the recommender doesn't size a model to the very edge of the card. It's a soft cushion the recommendation respects, not a hard runtime reservation.
- **Local models compete with the voice sidecar for VRAM.** If the user runs a chatterbox voice and a big local model on the same card, they share the GPU — loading both can fail or thrash on a tight card. The live free-VRAM reading already nets out whatever's resident (Windows, the browser, the voice models), so the recommender sizes against what's *actually* free right now. Mitigations: a smaller quant, a smaller context, or using a cloud/xAI backend for one of the two.
- **Quant choice is the real lever.** A smaller quant (e.g. Q4 instead of Q8) is usually the right fix for "won't fit" — the in-UI browser's fit hints and recommended pick are built exactly for this decision. Full-precision formats (F16/BF16/F32) are wasteful for inference and never the recommended pick unless a repo ships nothing else.

By default an idle local model stays resident (`autoUnloadMinutes` is `0` = off), so VRAM isn't freed automatically between turns — the user can enable idle auto-unload in config, or unload manually, if they need the card back.

---

## Seeing current state

Before changing anything, read where things stand. The pieces and where they come from:

- **Is local inference even available?** It needs `localModels.enabled` (on by default), the **binary present**, and **at least one registered model**. Any one missing and the backend can't run. The status/connections surface reports enabled-ness, whether the binary exists (and at what path), the registry's models + default, the base URL, and the current runtime state (`idle` / `loading` / `ready` / `failed`).
- **What's loaded right now** — the active model id, the load state, and the context window the server is actually running with (read from llama-server's own props). If a load failed, the status carries the error.
- **GPU budget** — detected total VRAM (when NVIDIA is present) powers the per-quant fit hints in the browser.

When the user asks "what's my local setup," assemble: enabled? → binary present? → which models are registered, which is default? → is one loaded (and at what context)? → is the GPU readable for fit hints?

You don't need to transcribe exact route names or response fields — describe *what* to look at; the live UI and the status/connections surfaces are the source of truth.

---

## Gotchas and failure modes

- **"llama.cpp server not found."** The binary isn't at the expected path. The user downloads the right llama.cpp build for their platform/GPU and drops `llama-server.exe` (+ DLLs) in `local/bin/`, or points `localModels.binaryPath` elsewhere. This is the #1 cause of "local doesn't work."
- **Server exits during load.** A bad binary, a GPU/driver mismatch, or an out-of-memory at load. The load fails fast (mantle watches for an early exit) with the error; the llama-server output is forwarded to mantle's logs prefixed `[local:stdout]` / `[local:stderr]` — point the user there for the real reason. A model that's too big for the card OOMs here; a smaller quant is the fix.
- **"Model is busy — can't switch."** A swap to a *different* model is refused while the current one is serving an in-flight stream (the swap would corrupt the live turn). Wait for the turn to finish, then switch. Loading the *same* model again is a no-op (it's already warm).
- **First message on a cold model is slow.** The first load of a multi-GB model can take many seconds; mantle feeds the agent loop keep-alive ticks during the load so it doesn't time out, and surfaces a "Loading … into memory" thinking note. Subsequent messages on that model are warm.
- **Small model ignoring tools / going in circles.** Almost always tool-surface overflow — it's on `all` when it should be on `core` (or `custom`). See [Tool modes](#tool-modes--and-why-a-curated-core-set-exists).
- **Reload-class edit didn't apply.** Context/GPU-layers/threads/KV/flash-attn changes only take effect on the next server respawn. If the model is currently loaded, the user won't see the change until it next swaps or is unloaded + reloaded.
- **No fit hints / no VRAM readout.** Non-NVIDIA GPU or no `nvidia-smi`. Not a bug — the browser just omits the hint and the recommender falls back to a capped-context guess.
- **Gated/private HF repo (401/403).** Needs `localModels.hfToken` or the `HF_TOKEN` env var.
- **Multi-quant repo, ambiguous pull.** If a repo ships several quants and the spec doesn't name one, `mantle pull` lists the options and asks for a `:quant` rather than guessing.

---

## What needs the user's confirmation

- **Downloading a model.** A pull can be **many gigabytes** over the network. Confirm the repo + quant (and that they have the disk/bandwidth) before kicking off a large download, especially when *you'd* be triggering it.
- **Deleting a model's weights** (`mantle models rm <id> --file`, or the UI's delete-file). Removing the GGUF from disk is **irreversible** — they'd have to re-download. Registry-only removal (no `--file`) is recoverable, but still confirm intent.
- **Changing a model's persisted settings** (tool mode, sampling, context/KV/GPU knobs, default pointer, reset-to-defaults). These rewrite the model's registry entry and affect every future turn on it. Reversible, but deliberate — confirm before saving, especially a reload-class change that will respawn the server.

Routine, no-confirm-needed: selecting/warming a model, reading status, previewing recommended settings, listing the registry or browsing Hugging Face. These are reversible and free (local GPU time only — nothing bills).

---

## Related docs

- `docs/agent-manual/MANTLE.md` — the always-loaded operating manual (points here).
- The backend picker that local inference shares with the cloud vendors lives in the profile bar — the web-UI map (`docs/agent-manual/feature/ui.md`) covers where every control is.
