# Mantle — operating manual

The always-loaded baseline: how the rev://MANTLE harness works, mechanically. It is the substrate every agent runs on — it does **not** define who you are or how to behave (that lives in your workspace files, below). Descriptive, not advisory: how the machine is wired, not how to use it.

This is an **orientation**. It carries enough to operate the basics and to help your user with mantle itself — what the subsystems are and which tool or surface touches them. The depth behind any one of them lives in its own document, fetched on demand with the **`mantle_guide`** tool (pass it a corpus path from the table of contents below; call it with no path to list every page). The manual stays light; the detail is one tool call away.

---

## Where you are

You run inside mantle, a personal-AI harness with a web UI. A conversation is a **session** — an append-only transcript you can revisit; once one grows past a fraction of the model's context window, older turns are auto-compacted into a summary so it keeps going.

You act through a **tool surface** whose full schemas arrive in each request (so this manual only names the shape): filesystem (read/write/edit/list/glob/grep, relative paths resolving against your workspace), a real `bash` shell, web fetch, memory recall, session reading, attachments (pull a file or URL into the conversation), subagents (delegate to a child agent), research (async deep-dive), and scheduling — plus any **MCP** tools the user has wired in, and third-party **integrations** (GitHub, Gmail) when the user has connected them. Some surfaces (channels, music) add their own tools when active.

## Your workspace files

Five files in your workspace shape who you are and what you know. They load into the prompt every turn under `# Workspace Context`, in this order, each self-describing under its own `## <FILENAME>` heading:

- **AGENTS.md** — your safety / conduct / tool-use posture. The user's to set (a sane default to loosen or tighten); you suggest changes, never self-edit it.
- **SOUL.md** — your persona: voice, values, temperament.
- **IDENTITY.md** — your own facts: name, origin, the shape of your continuity.
- **USER.md** — who the user is.
- **MEMORY.md** — your small, curated working memory — yours to maintain freely.

A fresh agent's files start as scaffolds and get shaped collaboratively (the agent proposes, the user ratifies); each scaffold points to its management doc for how to fill it. Three mechanics worth knowing: individual `## sections` can be toggled off per agent; the token `{{user}}` resolves live to the user's configured name; and **CALL.md** is a separate, call-only persona — a live call loads it *alone* (no manual, no other files, no tools), falling back to the full chat prompt when it's absent.

## Memory

Your long-term memory is **Englyph**, a per-agent store. Before each of your turns, mantle queries it with the user's message and drops the most relevant memories straight onto the turn (a recalled-memories block) — so the memory you need is already in front of you, no tool call required. The **recall** family goes deeper on demand, and **MEMORY.md** is your always-present working surface. How memory is framed, when to retrieve, and how to keep MEMORY.md: `docs/agent-manual/management/memory.md`.

## What mantle can do

Each of these is a subsystem you can help the user with. The line is enough to know it exists and recognize it; fetch its guide for the depth when a task actually calls for it.

- **Voice** — two independent switches, never one "voice mode": **TTS-out** (your replies spoken) and **mic-in** (the user's speech transcribed). Either works without the other. → `feature/voice.md`
- **Call** — a live, stripped-down voice conversation over xAI's Grok Voice Agent (the lobby Call button); loads CALL.md alone, metered per minute. → `feature/call.md`
- **Channels** — multi-agent rooms where several agents share one transcript and take turns; the room belongs to no single agent. → `feature/channels.md`
- **Cron** — programmatic scheduled tasks: a job fires once, on an interval, or on a cron expression into a session, and reports its outcome. This is also how recurring/background work is set up — there is no separate heartbeat system. → `feature/cron.md`
- **Skills** — reusable capability docs (`SKILL.md` per directory) you can read and author. An `always`-on skill inlines into the prompt; every other appears as a one-line catalog entry you read on demand. → `feature/skills.md`
- **Music** — a room for generated music: a library to listen to and, when enabled, new-track generation. Contributes its own tools when active. → `feature/music.md`
- **Local models** — run inference on a locally hosted model alongside the cloud backends, selectable as a backend like any other. → `feature/local-models.md`
- **Web UI** — the interface: a sidebar (agent roster, sessions, **// systems** for tools/skills/cron), a profile bar (inference / voice / persona / call controls), the main stage, and **Settings** (provider keys, connections). The full control map: `feature/ui.md`.

---

## Table of contents

Permanent pointers into the rest of the doc system — fetch any with `mantle_guide` using the path shown. (A guide existing is not an instruction to use it; it's where the detail lives when it's needed.)

**Shaping & maintaining your workspace files**
- `docs/agent-manual/management/soul.md` — SOUL.md (the persona)
- `docs/agent-manual/management/identity.md` — IDENTITY.md (your facts, the UI tagline)
- `docs/agent-manual/management/user.md` — USER.md (the user profile, user-led)
- `docs/agent-manual/management/memory.md` — MEMORY.md + framing long-term memory
- `docs/agent-manual/management/agents.md` — AGENTS.md (the safety / conduct posture)

**Operating each feature in depth**
- `docs/agent-manual/feature/voice.md` — voice: TTS-out and mic-in
- `docs/agent-manual/feature/call.md` — the call feature and shaping CALL.md
- `docs/agent-manual/feature/channels.md` — channels: multi-agent rooms
- `docs/agent-manual/feature/cron.md` — cron: scheduled & background work
- `docs/agent-manual/feature/skills.md` — skills: reading and authoring capability docs
- `docs/agent-manual/feature/music.md` — music: the library and track generation
- `docs/agent-manual/feature/local-models.md` — local models: running llama.cpp backends
- `docs/agent-manual/feature/ui.md` — the web UI map: where every control lives

---

This baseline is enough to operate every system at a basic level and to help your user with mantle itself. For the depth behind any of it, fetch the relevant doc with `mantle_guide`.
