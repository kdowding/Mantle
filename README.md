<pre>
     ┌─────────────────────────────────────────────────────────────────┐

          r e v : / /
          ███╗   ███╗  █████╗  ███╗   ██╗ ████████╗ ██╗      ███████╗
          ████╗ ████║ ██╔══██╗ ████╗  ██║ ╚══██╔══╝ ██║      ██╔════╝
          ██╔████╔██║ ███████║ ██╔██╗ ██║    ██║    ██║      █████╗  
          ██║╚██╔╝██║ ██╔══██║ ██║╚██╗██║    ██║    ██║      ██╔══╝  
          ██║ ╚═╝ ██║ ██║  ██║ ██║ ╚████║    ██║    ███████╗ ███████╗
          ╚═╝     ╚═╝ ╚═╝  ╚═╝ ╚═╝  ╚═══╝    ╚═╝    ╚══════╝ ╚══════╝

          an agent harness with a pulse — identity · memory · voice

     ──── link:online ─── memory:englyph ─── [ awaiting input ] ────────

     └─────────────────────────────────────────────────────────────────┘
</pre>

<p align="center">
  <img alt="Bun" src="https://img.shields.io/badge/Bun-1.3+-14151a?logo=bun&logoColor=fbf0df&style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white&style=flat-square">
  <img alt="Svelte 5" src="https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte&logoColor=white&style=flat-square">
  <img alt="memory" src="https://img.shields.io/badge/memory-Englyph-39BDA0?style=flat-square">
  <img alt="local models" src="https://img.shields.io/badge/local_models-llama.cpp-6E56CF?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-D08A4A?style=flat-square">
</p>

A personal-AI **agent harness** — give an AI a persistent identity, long-term memory, and a home it actually lives in. **Bun + TypeScript** backend, **Svelte 5** UI. Multi-agent: each agent has its own workspace, sessions, memory, persona, and config.

Inference is a **(vendor × access-mode) catalog** — Claude, ChatGPT, and Grok via API keys *or* your existing subscriptions, plus local GGUF models through llama.cpp. Voice (speak + listen), a Discord-style multi-agent channel, music generation, and **Englyph** long-term memory are all built in but **off by default** — a fresh clone is just chat with whichever model you point it at, and you turn the heavy extras on when you want them.

> The Englyph integration is the part worth reading the code for: instead of handing the agent a `recall` tool to call mid-turn, Mantle assembles a memory pack *before* inference and injects it into the system prompt. See [Englyph integration](#englyph-integration) below — it's an optional add-on; Mantle runs fine without it.

## Quick start

You need [**Bun**](https://bun.sh) (1.3+). Everything else is optional.

```bash
git clone https://github.com/kdowding/Mantle.git && cd Mantle
bun install
./start.sh            # Windows: start.cmd
```

`start.sh` (or `start.cmd` on Windows) builds the Svelte UI if it's stale, starts the server in the foreground (logs print here, Ctrl+C stops it), and opens **http://localhost:3333** in your browser. Prefer the raw steps? `bun run ui:build` then `bun run dev` does the same, minus the browser launch.

The app boots even with nothing configured — it starts **lean** (no voice, memory, local models, or calls running) and a setup wizard walks you through the rest:

1. **Create a login** — a single local account locks down the instance.
2. **Connect a provider** — paste an API key (Anthropic / OpenAI / xAI) or connect a ChatGPT/Grok subscription right in **Settings → Providers**. (Or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY` in the environment before launch.)
3. **Pick your features** *(optional)* — turn on the heavy extras you want (memory, voice, local models, realtime calls, music). Each shows what it still needs to run; skip it and add features any time in **Settings → Features**.
4. **Name yourself & create your first agent** — the wizard scaffolds the workspace and drops you into chat.

No keys baked into files, no agents to hand-author. On a trusted local machine you can skip the login wall with `MANTLE_AUTH_DISABLED=1` (e.g. in a gitignored `.env`, which Bun auto-loads) or `server.auth.enabled=false` in config.

### Background lifecycle

```bash
bun run start         # launch detached (rebuilds the UI if stale)
bun run status        # is it up?
bun run restart       # graceful restart (POST /api/shutdown)
bun run stop
```

On Windows the server gets its own console window (that window is the log surface); on macOS/Linux it detaches via `nohup` and logs append to `.mantle/mantle.log`.

### Optional features (off by default)

Turn the heavy extras on in the setup wizard or **Settings → Features** — each shows a live readiness pill (`ready` / `needs a key` / `needs setup`) so you can see exactly what's missing. A disabled feature costs nothing: nothing spawns, probes, or shows a dead button. What each needs to actually run:

- **Englyph memory** — a separate memory engine (its own project, a Python daemon shipping as the `englyph` pip package) that runs alongside Mantle. When its daemon is up, every agent gains provenance-scored long-term memory, pre-loaded every turn; when it isn't, Mantle runs happily without it. See [Englyph integration](#englyph-integration).
- **Voice** — a local `chatterbox` + Whisper sidecar in `.venv-streaming` (speak via browser VAD → Whisper, hear replies back), **or** xAI TTS, which just needs a Grok key and no sidecar. **Set up now** builds the sidecar for you (uv-provisioned Python + a GPU-aware torch); `voice/requirements.txt` is the manual fallback.
- **Local models** — a llama.cpp `llama-server` binary in `local/bin/`, then `bun run src/cli.ts pull <hf-repo>` to fetch GGUF models and run them at zero API cost. **Set up now** auto-downloads the right `llama-server` build for your platform/GPU (checksum-verified); or drop one in by hand.
- **Realtime calls** — just a Grok (xAI) key; live voice conversations, billed per minute.
- **Music** — the player works on its own (upload your own tracks); AI song generation needs a [kie.ai](https://kie.ai) key, set in **Settings → Providers**.

> **Minimal install:** `bun install` plus a single provider key is a complete chat harness — none of the above is required. For voice and local models, the readiness pill's **Set up now** button downloads and installs the runtime for you (with the exact manual commands as a fallback if it can't); the rest need only an API key.

## Configuration

Everything per-machine lives in `.mantle/config.json` (gitignored, written `0600`). Provider keys resolve **config.json > environment > unset**: a key set in-app (Settings → Providers) or hand-edited into `config.json` wins; environment variables are a *fallback* that fills any provider you haven't set, so Docker / CI / secrets-manager flows still work. Keys are never echoed back to the browser — the UI reports presence and source only.

The **Connections** tab (Settings) shows live status for every subsystem — which providers are ready, whether Englyph / voice / local models are up — so you can see at a glance what's wired.

`.mantle/config.json` also carries agents, the server port, MCP server entries, and cron defaults. Per-agent settings live under `agents[]`:

```json
{
  "agents": [
    {
      "id": "agent",
      "name": "agent",
      "workspace": "./workspaces/agent",
      "englyphPath": "~/.rev-mantle/englyph-agent",
      "defaultProvider": "xai/api"
    }
  ],
  "defaultAgent": "agent"
}
```

`englyphPath` is optional; if unset, each agent gets `~/.rev-mantle/englyph-<id>` so memory pools are isolated by construction. New agents start from `templates/agent-workspace/` (AGENTS, SOUL, IDENTITY, USER, MEMORY, CALL scaffolds with `{{user}}` / `{{name}}` / `{{date}}` markers) and need the same fields wired into config.json.

## Englyph integration

Englyph is a 6-signal memory retrieval engine (similarity, salience decay, authority, confidence, type multipliers, room penalty) backed by ChromaDB and SQLite FTS5 hybrid retrieval. Where conventional vector-store memory ranks by cosine similarity alone, Englyph's score function lets agents weight provenance, recency, and intent at retrieval time. It is a separate project shipping as the `englyph` pip package.

Mantle runs Englyph in its `companion` deployment mode, which activates a 4-type companion library (`want`, `preference`, `opinion`, `observation`) and a 6-intent retrieval matrix tuned for single-agent use. The agent's voice and personality come from workspace files; Englyph is purely a retrieval and storage layer.

### Two-pool memory model

Englyph stores two physically separate collections, with separate retrieval surfaces:

- **Memory pool** (`englyph_drawers`): framed interpretations. Things like "Kyle prefers small focused PRs over bundled ones." Authored from the agent's perspective, scored on all 6 signals.
- **Source pool** (`englyph_source_chunks`): raw chunked content. The full text of session transcripts, code, docs, anything ingested via `englyph_ingest_source`. Similarity-only retrieval, separate query surface (`englyph_search_source`).

A question like "what does Kyle think about auth flow?" hits the memory pool. A question like "what did Kyle literally say last Tuesday about the cron bug?" hits the source pool. The two stores never compete for retrieval because they are served by different tools.

### Pre-inference memory pack

Most agent harnesses give the model a `recall` or `search_memory` tool and trust it to call when needed. Mantle doesn't. On every user turn, before any inference happens:

1. The harness decomposes the user message into roughly 6 query variants (full text, per-clause split on `.!?;`, stopword-stripped versions, template-HyDE reframings shaped like authored memories: `Kyle wants {topic}`, `Kyle prefers {topic}`).
2. Fans them out as one batched `englyph_search_batch` call (single embed pass, parallel ChromaDB reads).
3. If topical retrieval comes back empty, falls back to a keyword-floor query so FTS5 hits can surface even when the embedding misses.
4. Always pulls 3 to 6 random memories via `englyph_sample_drawers` for ambient history, so the agent has material for organic callbacks.
5. Optionally runs temporal retrieval (chrono-node parses dates from the user message; if a window is detected, queries by date range with optional topic refinement).
6. Renders everything as a "Recalled Memories" block and injects it into the system prompt's dynamic zone.

The agent receives memory as background context, not as a tool to call. Mid-turn `recall` calls are still possible (the tool is registered) but actively discouraged in the agent's operating instructions, since the pre-injected pack already covers the topical retrieval budget for the turn.

Implementation: `src/agent/memory-pack.ts`.

### Per-agent isolation and lazy spawn

Each Mantle agent runs its own Englyph MCP server process pointed at its own `ENGLYPH_PATH`, so memory pools never cross agents. (Two agents' drawers live in physically separate ChromaDB stores; one's memory writes are invisible to the other.)

Englyph processes spawn lazily, not at boot: the tool surface registers from a cached schema (`.mantle/cache/englyph-schema.json`, captured once on first boot), and each agent's instance stays dormant until its first chat turn, cron job, or memory-pack query. Concurrent first-spawns are deduped, so a burst of parallel calls only triggers one Python process per agent.

Implementation: `src/englyph/manager.ts`.

### Filling the two pools

Both pools are filled by the agent itself, through tools — not a separate background indexer:

- **Source pool** — `render_session_markdown` renders a session's JSONL transcript to a sibling `.md` file (one H2 per turn), and `englyph_ingest_source` chunks it into the source pool under `wing=sessions, room=<session-id>`.
- **Memory pool** — the memory-write tools author framed companion memories (wants, preferences, opinions, observations), de-duplicated against both pools before writing.

To run this unattended, author a **cron** job (see [Other systems → Cron](#other-systems)) whose prompt tells the agent to render + ingest recent sessions and/or mine them for framed memories — scheduled runs execute under a lean autonomous prompt so persona doesn't bias archival judgment. The repo doesn't ship a pre-wired archival job; the `cron-builder` assist skill helps you set one up (it needs the `companion` preset or an explicit tool allow-list).

## Multi-agent

From the UI, the sidebar **+** (or the first-run onboarding) scaffolds an agent's workspace from `templates/agent-workspace/` and wires its `config.json` entry for you. By hand it's the same three pieces: copy `templates/agent-workspace/` to `workspaces/<id>/`, fill in the placeholders, add an entry to `config.json`'s `agents[]`. Either way the harness handles per-agent session storage, Englyph isolation, skill scoping, and cron scheduling automatically; the active agent is selectable from the UI sidebar.

Each agent can override default provider, model, and persona at the agent level. Per-run provider/model overrides live in each cron job's spec.

## Other systems

**Skills.** A two-tier skill system (a global skills dir plus agent-specific `<workspace>/skills/`) loads SKILL.md packs into the system prompt's stable zone with token budgeting. Skill packs are application content rather than core code and are per-deployment (gitignored), so the repo ships none by default. It does ship the three **assist-builder** skills under `assist-skills/` (`cron-builder`, `personality-builder`, `skill-builder`) that power the in-app deck-assist dock.

**Cron.** A SQLite-backed scheduled job system (`src/cron/`) is Mantle's scheduler. Jobs support cron expressions (via [croner](https://github.com/Hexagon/croner)), fixed intervals, or one-shot runs. Each run executes under a security-first preset (`mechanical` read-only by default, up to `companion` full-surface), with an optional per-job egress domain allow-list. Sessions can be isolated, persistent, or named; delivery can be silent, a toast, or relayed into the user's chat. Pre-run hooks for Englyph context enrichment and conditional execution; post-run hooks for outcome storage with causal chaining.

**Personas.** Per-agent persona masks (`personas.json` in workspace) layer on top of SOUL.md. Switching personas mid-session injects a transition note so the agent acknowledges the mask change naturally. Persona is selectable per message via the profile bar.

**Prompt caching.** The system prompt assembles into three zones (stable, persona, dynamic) so providers can apply cache breakpoints around the parts that don't change. Anthropic gets explicit `cache_control` markers on the tools array, the stable system block, the persona block, and the last assistant content block (4 breakpoints, the API maximum). xAI auto-caches by prefix match, so the same zoning works without explicit markers. The pre-inference memory pack lives in the dynamic zone, so it changes per turn without invalidating the larger stable cache.

## Project layout

```
src/
  agent/         agent loop, the (vendor x mode) provider catalog, session, prompt builder
  auth/          inbound login + outbound subscription-token auth
  config/        config schema and loader
  cron/          scheduled jobs (SQLite store, executor, Englyph hooks)
  englyph/       Englyph lifecycle manager (lazy spawn, schema cache)
  integrations/  OAuth-backed third-party tools (GitHub, Gmail)
  local/         llama.cpp runtime + model registry + `pull` engine
  provision/     auto-provisioning for optional runtimes (llama.cpp binary, voice venv)
  realtime/      xAI Grok Voice Agent realtime calls
  rooms/         bolt-on features (music, channel) behind a Room contract
  server/        HTTP / WebSocket / API endpoints
  skills/        skill loader and formatter
  tools/         tool registry plus core tool implementations
  voice/         TTS/STT sidecar client + xAI TTS
ui/              Svelte 5 (runes) SPA — builds to ui/dist, served by the Bun server
voice/           Python voice sidecar (FastAPI: whisper + chatterbox)
templates/
  agent-workspace/   placeholder scaffold for new agents
assist-skills/       deck-assist builder skills (cron / personality / skill)
```

`workspaces/`, `.mantle/`, `.claude/`, `.env`, and agent skill packs are gitignored.

## Status

Personal project — early, but real. Everything described above ships and runs today. Not yet: sandboxed tool execution (multi-user is gated behind it), a Gemini backend.

## Releases & versioning

SemVer intent, currently **0.x = pre-stable**: minor bumps may carry breaking
changes (called out in the release notes), patch bumps are safe. Updating is
never destructive — config migrations are automatic (`configVersion` stamps
carry an existing `.mantle/config.json` forward, and the lean defaults apply
to fresh clones only, so an update never silently turns your features off).
Each release is a git tag with notes on the GitHub Releases page.

## License

[Apache 2.0](LICENSE). © 2026 Kyle Dowding.
