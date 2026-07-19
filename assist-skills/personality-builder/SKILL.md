---
name: personality-builder
description: Help the user shape an agent's personality files (AGENTS / IDENTITY / SOUL / USER / MEMORY / CALL). Use when co-authoring who the agent is, its voice, what it knows about the user, or its call persona — proposing changes the user reviews and ratifies.
---

# Shaping an agent's personality files

You are helping the user edit this agent's **own** persona and identity files — often *your* own. This is guided self-authorship: you propose, the user ratifies. Co-author, never overwrite wholesale — change what was asked and leave the rest intact. Ground every change in what the files actually say (read them first) and keep them consistent with each other.

## The files

- **AGENTS.md** — operating rules, safety boundaries, and judgment. The user-owned guardrails. Edit it with extra care and a clear rationale; it's where "what I will and won't do" lives.
- **IDENTITY.md** — name, tagline, one-line purpose. The factual "who/what." The first line feeds the profile bar, so keep it a real sentence.
- **SOUL.md** — voice, values, way of being. The personality layer, loaded into **every chat turn** (autonomous cron runs may skip it). This is where character lives: how the agent talks, what it cares about, its relationship stance.
- **USER.md** — what the agent knows about its user: who they are, how they work, what they want. The relationship's memory of the person.
- **MEMORY.md** — a small, curated list of **pinned facts** always in the prompt. Keep it tight and durable — this is working memory, not a log; the large recallable pool is Englyph, not this file.
- **CALL.md** — the agent's persona on a live voice **call** (xAI Grok Voice). Used **alone** on a call — no other files load. Keep it a lean paragraph; no markdown, no stage directions (`*laughs*`), no emoji — they get spoken literally. It should sound like SOUL.md distilled for the ear.

## How Mantle loads them

- AGENTS / IDENTITY / SOUL / USER / MEMORY render into the **stable** (cached) system-prompt zone every chat turn. Keep them lean — every line ships each turn.
- In AGENTS / IDENTITY / SOUL / USER, each `## heading` is a **section the user can toggle on/off** independently. Structure these files as meaningful `## sections` so the user keeps that control. (MEMORY and CALL aren't section-toggled.)
- CALL.md loads **only** on a call, by itself. Anything the agent should do or avoid on a call must live in CALL.md — AGENTS.md doesn't apply there.

## Writing well

- **SOUL.md** — concrete over abstract. "Dry, understated, allergic to hype" beats "has a good personality." Let the voice show in how the file itself is written.
- **Keep SOUL.md and CALL.md in sync.** Same character — one for reading, one for the ear. Change one, check the other.
- **MEMORY.md** — frame facts, don't dump them. One durable line each; prune the stale.
- **IDENTITY.md** — a real one-sentence purpose, never a placeholder.

Deeper per-file guidance lives in the manual — read it on demand with `mantle_guide` (e.g. `docs/agent-manual/management/soul.md`, `docs/agent-manual/feature/call.md`).

## Helping in the deck

- The **open** file is edited with `propose_edit` — call it once with the COMPLETE revised file; the user reviews it as a diff and accepts or rejects per block.
- To edit **another** personality file, or fill a **missing** one, use `stage_workspace_edit(file, content)` — each stages as its own reviewable diff.
- Read the related files before proposing, so a change to one doesn't contradict another.
- Small questions deserve a plain answer — don't stage a proposal when the user just asked what a file is for.
