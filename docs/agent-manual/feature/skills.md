# Helping the user with skills

A usage guide for an agent helping its user with mantle's skills. This is loaded on demand (via `mantle_guide`); the always-loaded manual (`docs/agent-manual/MANTLE.md`) only points here. Read this when the user asks you to "learn" or save a repeatable behavior, wants a reusable procedure or checklist, asks how skills work, asks to turn one on/off, or wants to clean up the skill list.

A skill is a *capability doc you can read — and author*. That second half is the point: when a user teaches you a repeatable way of doing something and wants it to stick, the right move is usually to write a skill, not just to remember it for this conversation. Deleting a skill removes a file from disk and a couple of operations touch real persisted config, so those are the user's call to confirm — see [Confirmation](#what-needs-the-users-confirmation).

---

## What a skill is, and the one rule that matters

A **skill is a directory containing a `SKILL.md` file.** The directory name is the skill's home; the `SKILL.md` inside it carries a small **YAML frontmatter** block (between `---` fences) followed by the skill **body** (the actual instructions, in markdown).

The frontmatter fields:

| Field | Required? | What it does |
|---|---|---|
| `description` | **REQUIRED** | One line: *what this skill is for / when to use it.* This is what you scan to decide a skill is relevant. **No `description` = the skill is invisible** — discovery silently skips it and it never appears anywhere. This is the single most important rule. |
| `name` | optional | The skill's display name. Defaults to the directory name if omitted. |
| `always` | optional | `true` → the skill's full body is inlined into your prompt every turn (a *standing* skill). Default `false` → it appears as a one-line catalog entry whose body you read on demand. |
| `platform` | optional | `windows` / `macos` / `linux` — the skill only loads on a matching OS. Omit it to load everywhere. |

**The one rule that matters: a skill with no `description` does not exist.** Discovery requires it; the UI's skill editor will *refuse* to save a `SKILL.md` that lacks one (it tells the user the skill would be invisible). When you author a skill, always write a clear `description` — and write it as a *trigger* ("Use when the user wants to…"), because that line is what you (and the user) match against later.

---

## The two surfaces: standing vs catalog

Every active skill lands in your prompt one of two ways, decided by `always`:

- **`always: true` → standing skill.** The skill's **full body** is inlined into the stable prompt zone under `# Standing Skills`, every single turn. You apply it unconditionally — it's part of your operating procedure, not something you choose to load. The cost is real: every standing body ships on every turn. **Keep the always-on set sparse — 3 to 5 short skills.** A standing skill ought to be a short foundational instruction (a few hundred to ~1000 chars), not a long manual. If the standing section overflows its budget, the alphabetical tail is dropped with a note telling you to load those by hand.

- **`always: false` (the default) → catalog skill.** The skill appears as **one line** in a triggered-skills catalog in the dynamic prompt zone — `name — description (read: <path>)` — and nothing more. Its body lives on disk until you actually need it: when a task matches the description, you **`read_file` the path shown** to pull in the full instructions, then act on them. This is the just-in-time pattern — a thin index always present, the heavy bodies fetched only when relevant.

The catalog path is **aliased**: `{workspace}/skills/<name>/SKILL.md` for an agent skill, `{global}/<name>/SKILL.md` for a global one. `read_file` resolves those aliases to real absolute paths automatically, so you read them exactly as written — don't try to "fix" the alias into an absolute path.

Default everything to **catalog** (`always: false`). Reserve `always: true` for the rare instruction that genuinely must color *every* response. When a user asks for a skill, the right question is usually "should this fire only when relevant?" (almost always yes → catalog) versus "should this govern how you behave at all times?" (rare → standing).

---

## Scope: global vs per-agent

Skills come from two roots, and both are discovered and merged:

- **Global skills** live in the repo's root `skills/` directory (the configured global skills dir). They're shared by **every agent** on this mantle instance.
- **Per-agent skills** live in **`{workspace}/skills/`** — that agent's own workspace. Only that agent sees them.

**On a name conflict, the agent's own skill wins** — a per-agent `SKILL.md` with the same name shadows the global one. That's the mechanism for an agent to override or specialize a shared skill without touching the global copy.

When you author a skill, choose the scope deliberately: a procedure that's specific to *this* agent's relationship with *this* user belongs in the workspace; a general-purpose capability the user wants every agent to have belongs in global. If unsure, default to **per-agent** — it's the narrower blast radius and easy to promote later.

---

## Discovery is live — write the file and it exists

There is **no registration step and no restart.** Discovery reads the skill directories fresh, and a structural fingerprint (the set of skill dir names plus each `SKILL.md`'s mtime and size) busts a cache the moment a file is added, edited, or deleted. So:

> **Write a valid `SKILL.md` with `write_file`, and the skill is live on your very next turn.** Delete the directory and it's gone next turn.

This is why authoring a skill is a real, low-friction action — not a config ceremony. The caveats are exactly the discovery rules: the file must be at `<dir>/SKILL.md`, it must have a `description` in its frontmatter, it must be under the size cap (~256KB — far past any sane skill), and if it sets `platform` it only appears on a matching OS. Miss the `description` and the skill silently won't show up — that's the most common "I wrote it but it's not there" cause.

---

## Authoring a skill — how, and when it's the right move

### When

Reach for a skill when the user is teaching you a **repeatable behavior** and wants it to persist — phrasings like "learn how to…", "from now on when I ask for X, do it this way", "save this as a routine", "make a checklist for…", "remember this procedure". The tell is *reusability across future conversations*. A one-off instruction is just this turn's context; a *pattern the user will invoke again* is a skill.

Distinguish a skill from neighboring surfaces, because the user often won't:

- **A skill** = a reusable *procedure / capability* ("how to do X"). Read on demand, applied when the task matches.
- **MEMORY.md / Englyph** = *facts and context* — what's true about the user and the world, not a procedure. ("Kyle prefers terse replies" is memory; "how to format a release note" is a skill.)
- **A scheduled job (cron)** = something that should *run on its own on a schedule*, not a procedure you apply when asked. If the user wants it to *happen automatically and recurringly*, that's cron, not a skill — see that guide.

### How

Authoring is just writing a file:

1. **Pick the scope** → `{workspace}/skills/<dir>/SKILL.md` (this agent) or `{global}/<dir>/SKILL.md` (all agents). The `<dir>` name should be plain alphanumeric with `-`/`_` (the editor enforces this).
2. **Write the frontmatter** — a `description` (required; phrase it as a trigger), an optional `name`, and `always: true` *only* if it must govern every turn.
3. **Write the body** — the actual instructions, in plain markdown. Be concrete; this is what future-you reads to execute the behavior.
4. **Save with `write_file`** at that path. It's live next turn — no restart.

Confirm the scope and the `always` choice with the user before writing, and read the new skill back once to sanity-check the frontmatter parsed (a malformed `---` block silently falls back to "no frontmatter," which means no description, which means invisible).

The user can also author and edit skills **in the UI** — the systems deck (**// systems**) has a skill editor with a diff/save flow. When the user is editing there, your job is to help draft the content; the deck's save path validates the same way discovery does (it refuses a `SKILL.md` with no `description`).

---

## The `skills_manage` tool — lifecycle, not content

`skills_manage` handles a skill's **records**, not its text. It acts on **the calling agent**. Its actions:

| Action | What it does |
|---|---|
| `list` | Every skill the agent sees (its own + global), each with its **scope** (`agent`/`global`) and **enabled/disabled** state. The way to answer "what skills do I have?" |
| `enable` | Turn a skill **on for this agent**, by name. (Can re-enable a skill the global config disabled — the per-agent enable overrides the global disable.) |
| `disable` | Turn a skill **off for this agent**, by name. |
| `delete` | **Remove a skill directory from disk.** Needs a `scope` (`agent` or `global`) and the directory name. Destructive and irreversible. |

**What `skills_manage` does NOT do: create or edit a skill's content.** There is no "create" or "write" action — authoring and editing a skill's body is done by **writing the `SKILL.md` directly** (`write_file`) or through the UI's skill editor. The tool's own description says so. Think of it as: *write the file to create/change a skill; use `skills_manage` to list, toggle, or remove one.*

A note on `enable`/`disable`: they're **per-agent overrides** stored in config. The resolution order is — an agent-disable wins, else an agent-enable wins (this is how it overrides a global-disable), else a global-disable, else the skill is on by default. Toggling is a saved config change (it persists), but it's reversible and touches no file on disk.

---

## Seeing the current state

- **"What skills do I have, and which are on?"** → `skills_manage` `list` — names, scope tags, enabled/disabled state for this agent.
- **Which are *standing* vs *catalog*?** → the standing ones are the ones in your `# Standing Skills` prompt section right now (their full bodies, inlined); everything else is a one-liner in the triggered-skills catalog. The `always` frontmatter flag is what decides this.
- **The user's view** → the systems deck's skill panel lists the same merged set with scope and toggle state, and is where they edit bodies.

You don't need to recite directory paths or config field names — describe *what* to look at. `skills_manage list` and the deck are the live source of truth.

---

## Gotchas and failure modes

- **No `description` → invisible skill.** The number-one "my skill isn't showing up." Discovery skips any `SKILL.md` without a `description` *silently* — no error, it just never appears. Always check the frontmatter first when a skill is missing.
- **Malformed frontmatter falls back to none.** If the `---` fences are broken or the YAML doesn't parse, the parser treats the whole file as body with *no* frontmatter — which means no description — which means invisible. A subtle version of the rule above.
- **Standing skills are not free.** Every `always: true` body ships on every turn for that agent. A long standing skill, or too many of them, inflates the prompt continuously. Keep them sparse (3–5) and short; push anything heavier to a catalog skill read on demand.
- **Caps and drops.** The standing section and the catalog each have a char budget. Overflow is handled gracefully — standing drops the alphabetical tail with a note; the catalog omits the tail to fit — but skills can quietly fall out of view if either set grows huge. Trim rather than rely on the cap.
- **Name conflicts shadow silently.** A per-agent skill with the same `name` as a global one *replaces* the global in that agent's view — intended, but it can surprise a user who edited the global copy and "nothing changed." Check whether a workspace skill is shadowing it.
- **`platform` filters by OS.** A skill tagged `platform: linux` simply won't appear on a Windows host — not a bug. Omit `platform` unless the skill genuinely only works on one OS.
- **Disabled vs deleted.** Disabling hides a skill from one agent and is reversible; deleting removes the directory from disk for *every* agent that shared it (if global) and is permanent. Don't reach for `delete` when the user just wants it "off."

---

## What needs the user's confirmation

- **Deleting a skill** (`skills_manage delete`) — it **removes the directory from disk**, irreversibly, and if the scope is `global` it's gone for *every* agent. Confirm the exact skill and scope before deleting; offer **disable** instead when the user just wants it turned off.
- **Creating or editing a skill body** — you're writing a persisted `SKILL.md` that will shape future turns. Confirm the scope (agent vs global — global affects all agents), the `always` choice (a standing skill ships every turn for everyone who has it), and the content. For a global skill especially, treat it as a deliberate, user-ratified change.

Routine, no-confirm-needed: **listing** skills, and **enabling/disabling** a skill for the calling agent (a reversible per-agent toggle that touches no file). Reading a catalog skill's body via `read_file` is just normal context-gathering — always free.

---

## Related docs

- `docs/agent-manual/MANTLE.md` — the always-loaded operating manual (points here).
- If the user wants a behavior to *run on its own on a schedule* rather than a procedure you apply when asked, that's the cron/scheduled-jobs subsystem, not skills.
