# STRUCTURE — how the agent manual is organized

> Maintainer-facing. This is the meta-doc for the `docs/agent-manual/` corpus: what the docs are, how they tier, how an agent reaches them, and the rules for adding one. If you are an *agent reading your own manual at runtime*, this is not for you — read `MANTLE.md` and follow its pointers. This file is for whoever edits the corpus.

The agent manual is the documentation that teaches a Mantle agent how its own harness works and how to help its user shape a workspace. It is split deliberately across **tiers** (what's always in the prompt vs. what's per-agent) and **classes** (one always-loaded manual, several on-demand guides). The split exists so the always-loaded baseline stays small and behaviorally neutral while the rich, driftable detail lives in documents fetched only when needed.

---

## The tiering — what governs an agent

An agent's behavior is shaped by layers with sharply different jobs and owners. The manual mirrors that layering; keep the distinction crisp when deciding where a sentence belongs.

| Layer | What it is | Owner | Register |
|---|---|---|---|
| **MANTLE.md** | The always-loaded **operating manual** — how Mantle works, mechanically. The baseline every agent shares. | Maintainer (this corpus) | Descriptive. Behaviorally **inert**. |
| **AGENTS.md** | Per-agent **safety / conduct** config — boundaries, role, tool-use policy, response style. A shipped sane default the user loosens or tightens, like a permission mode. | The user (the agent never self-edits it) | Advisory / imperative. |
| **SOUL / IDENTITY / USER / MEMORY** | The **persona**, the **user**, and **working memory** — living, per-agent. | Co-authored; see *hatching* | Personal, living. |

The load-bearing line is between **MANTLE.md** and everything below it:

- **MANTLE.md is behaviorally inert.** It describes *how the machine works* and assumes nothing about who the agent is, what's safe, or how to behave. It does not define personality, safety, memories, conduct, or judgment, and it never steers ("you should…", "be careful to…"). It is written in the register of an **owner's manual** — descriptive, never advisory.
  - **Litmus:** if any agent could reasonably want it different, it does **not** belong in MANTLE.md. A sentence that two well-configured agents would legitimately disagree with is conduct or persona, and belongs in AGENTS.md or the persona files — not the shared baseline.
- **AGENTS.md owns conduct.** Boundaries, safety rails, tool restraint, response style, role. This is the layer the user dials in. It is allowed — expected — to be imperative.
- **SOUL / IDENTITY / USER / MEMORY** are the living workspace files: who the agent is, who the user is, what to remember.

Mechanically, all five workspace files (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`) are loaded into the system prompt's stable zone by `src/agent/prompt-builder.ts`, in that priority order, under `# Workspace Context`. (Scheduled cron runs drop `SOUL.md` so personality doesn't bias autonomous judgment — see MANTLE.md.) MANTLE.md is also always in context, but it is *not* one of these five per-agent workspace files: it is the **shared corpus baseline** above them all, not a per-agent file rendered through that `prompt-builder.ts` path. Everything else in the corpus is on-demand, not always loaded — see *How docs are served*.

---

## The doc classes

Four classes of document live under `docs/agent-manual/`. Each has a fixed home and a fixed job.

### 1. The operating manual — `MANTLE.md`
The always-loaded baseline. **High-level**, not exhaustive: enough to drive the basics on its own — what the subsystems are, what they're for, which tool or surface touches them — but the rich detail lives in the per-feature docs. Scope discipline like a well-managed project memory file, but in the register of an operating manual, not a technical spec.

MANTLE.md also holds the **permanent pointer table** — a table of contents into the management and feature docs (see *The pointer / retention model*).

### 2. Management docs — `management/*.md`
One per workspace file the agent helps shape or maintain: how to *sculpt and maintain* that file, not what it contains for any given agent.

| Doc | Shapes |
|---|---|
| `management/soul.md` | `SOUL.md` — the persona |
| `management/identity.md` | `IDENTITY.md` — name, look, vibe, tagline |
| `management/user.md` | `USER.md` — the user profile (heavily user-led) |
| `management/memory.md` | `MEMORY.md` — working-memory hygiene |
| `management/agents.md` | `AGENTS.md` — the safety / conduct / permission posture |

These are advisory by nature (they coach an editing task) but they describe *how to shape a file*, never how a particular agent should turn out.

### 3. Feature docs — `feature/*.md`
The rich, accurate, on-demand detail for a subsystem, loaded only when the agent is actually helping with it. MANTLE.md says "a guide for X exists"; the feature doc *is* X in depth.

| Doc | Covers |
|---|---|
| `feature/voice.md` | Helping the user with voice — TTS-out and mic-in |

Feature docs are where argument-level, knob-level, gotcha-level detail belongs — the stuff too heavy and too driftable for the always-loaded baseline. Add one per subsystem as it grows enough surface to warrant on-demand depth.

### 4. Scaffold templates — `templates/agent-workspace/*.md` (the live scaffold dir, outside this corpus)
The starting-point files copied into a fresh agent workspace: a slim `AGENTS.md` and the persona scaffolds (`SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`). They use two kinds of placeholder: `{{name}}` / `{{date}}` are baked at creation by the hatch (each file taking whichever apply — `{{date}}`, for instance, only in IDENTITY), while `{{user}}` is left verbatim and resolved **live** by the prompt builder to the user's configured name on every turn, so a profile rename applies without rewriting the file. The four **persona** scaffolds open with a short "*not yet written*" note over empty `## section` headers, and each carries a **transient pointer** to its management doc (e.g. SOUL's note ends `mantle_guide docs/agent-manual/management/soul.md`). The slim **`AGENTS.md`** is the exception: it ships *fully written* — a sane default conduct posture, not a blank skeleton — and carries no transient pointer, because it is the user's to loosen or tighten from a working baseline rather than co-author from scratch.

These live in `templates/agent-workspace/`, *not* in this corpus — `scaffoldWorkspace` copies them into a fresh workspace at creation, and they are never served to a running agent. A lean `CALL.md` call-persona scaffold ships alongside the four persona files.

---

## The pointer / retention model

Docs cross-reference each other through two kinds of pointer with deliberately different lifetimes.

- **Permanent pointers — in MANTLE.md.** MANTLE.md carries a stable table of contents into the management and feature docs. These are **inert**: they say *"a guide for shaping SOUL.md exists at `docs/agent-manual/management/soul.md`"*, never *"you should go shape your SOUL.md."* They persist forever because MANTLE.md is always loaded and the guides are always reachable. Reference docs by their **repo-relative corpus path** so the pointer is resolvable and greppable.

- **Transient pointers — in the scaffold templates.** A freshly scaffolded persona file (`SOUL.md`, `IDENTITY.md`, …) carries a one-line pointer to *its* management doc — e.g. SOUL.md's scaffold notes that `docs/agent-manual/management/soul.md` explains how to fill it in. This pointer is **load-bearing only while the file is still a scaffold**. Once the user and agent build the file out, the pointer is edited away along with the placeholder prose; it has done its job. A built-out workspace file should contain no manual pointers — only its own content.

The asymmetry is the point: the always-loaded baseline keeps a permanent index so any guide is one fetch away; the scaffolds keep a self-erasing nudge so a new agent knows where to look on day one without leaving scaffolding scars in a mature workspace.

---

## How docs are served — `mantle_guide`, on demand

Only **MANTLE.md** is always in context (the operating-manual baseline). Everything else — management docs, feature docs — is fetched **on demand** via the **`mantle_guide`** tool, which reads a doc out of this corpus by its repo-relative path and returns its body to the agent.

The flow is: MANTLE.md's pointer table tells the agent a guide *exists* and where → when a task actually calls for that depth (the user wants to tune voice, reshape SOUL, set the safety posture), the agent fetches the doc through `mantle_guide` → it reads the rich detail just-in-time, then drops it. This keeps the always-loaded footprint to the inert baseline while making the full corpus reachable in one hop. It is the same just-in-time discipline Mantle itself uses for skills (a one-line catalog in the prompt, bodies read on demand) and for memory (a pre-injected pack, deeper recall on request) — context retrieved when relevant, not front-loaded.

> Maintainer note: `mantle_guide` is the corpus's intended serving mechanism and the contract these docs are written against — pointers reference docs by the exact path the tool resolves. Confirm the tool's wiring (name, the corpus root it reads from, path resolution) against the source before relying on the literal name in user-facing copy; if it has drifted, fix the pointers and this note together.

---

## Rules for adding a new doc

Follow these when extending the corpus. They keep the tiering honest and the pointers resolvable.

1. **Pick the class first — that fixes the home.**
   - Mechanical, shared, always-true-for-every-agent → it's baseline material; fold a *high-level* mention into `MANTLE.md` and put the depth in a feature doc.
   - "How to shape/maintain workspace file X" → `management/<x>.md`.
   - "How to use subsystem X in depth" → `feature/<x>.md`.
   - A starting-point workspace file → `templates/agent-workspace/` (the live scaffold dir, outside this corpus).

2. **Hold MANTLE.md to inert + high-level.** Anything added to MANTLE.md must pass the litmus — *if any agent could reasonably want it different, it doesn't belong here.* Keep the register descriptive (owner's manual), never advisory or imperative. If the content steers, assumes a personality, or defines a boundary, it belongs in AGENTS.md or the persona files, not the baseline. Push detail down into a feature doc and leave only a high-level mention plus a pointer.

3. **Match the template / register of the class.** A new management doc reads like the existing management docs (coaching an editing task); a new feature doc reads like `feature/voice.md` (rich, on-demand, accurate). Scaffold templates carry placeholders and a transient pointer to their management doc.

4. **Wire the pointers — both directions where they apply.**
   - Add a **permanent** entry to MANTLE.md's pointer table, referencing the new doc by its **repo-relative corpus path** (`docs/agent-manual/...`).
   - If it's a scaffold template, give the scaffold a **transient** pointer to its management doc, written to be edited away when the file is built out.

5. **Ground every factual claim in the source — accuracy is non-negotiable.** Do **not** invent flags, endpoints, defaults, tool names, or behaviors. Verify against the actual code in `src/`; the project's top-level map is a useful guide but is known to drift, so read the source when unsure. Prefer describing *the concept + which tool / where* over transcribing argument lists or tool schemas — those rot fastest. When the source moves under a doc, fix the doc.

6. **Keep the verification loop green.** Doc-only changes shouldn't touch `typecheck` / `lint` / `check:arch` / `bun test`, but if a doc change is paired with a code change, the usual gates still apply.

### A `check:docs` guard (proposed)

Pointers are the corpus's connective tissue and the thing most likely to silently break under a rename. Model a guard on `scripts/check-arch.ts` — the existing regex static-scan in the verification loop — that:

- scans every doc under `docs/agent-manual/` for `docs/agent-manual/...` references and asserts each **resolves to a real file** (the doc-corpus analogue of check-arch's "every relative import resolves");
- asserts every **management/feature doc is reachable** from MANTLE.md's pointer table — an orphan guide that nothing points to is as good as missing;
- optionally flags a **dangling scaffold pointer** — a scaffold in `templates/agent-workspace/` whose management-doc pointer doesn't resolve.

It would run alongside `check:arch` so a moved or renamed doc fails loudly instead of leaving a dead pointer in the always-loaded baseline. (Not yet implemented — proposed here so the corpus is built pointer-resolvable from the start.)

---

## At a glance

```
docs/agent-manual/
  MANTLE.md            — operating manual; always loaded; inert + high-level; holds the permanent pointer table
  STRUCTURE.md         — this file; maintainer-facing meta-doc
  management/
    soul.md            — how to shape SOUL.md
    identity.md        — how to shape IDENTITY.md
    user.md            — how to shape USER.md (user-led)
    memory.md          — how to maintain MEMORY.md
    agents.md          — how to tune AGENTS.md (safety / conduct posture)
  feature/
    voice.md           — helping with voice (TTS-out + mic-in)
    call.md            — the call feature + shaping CALL.md
    ui.md              — the web UI map (where controls live)
    channels.md        — multi-agent channels (POV, mentions, whispers)
    cron.md            — scheduled jobs (schedules, presets, delivery)
    local-models.md    — local GGUF models via llama.cpp
    music.md           — the music room (player + generation)
    skills.md          — the skills system (SKILL.md packs)

The scaffold templates live OUTSIDE this corpus, in templates/agent-workspace/
(AGENTS / CALL / SOUL / IDENTITY / USER / MEMORY) — copied into a new workspace.
```

Served model: **MANTLE.md** always in context; **management/** and **feature/** fetched on demand via `mantle_guide`; the scaffold templates in `templates/agent-workspace/` seed a new workspace and are never served to a running agent.
