---
name: skill-builder
description: Author and refine Mantle skills (SKILL.md). Use when helping the user create a new skill, fix one that isn't triggering, tighten a description, or decide what belongs in a skill vs. a workspace file.
---

# Building Mantle skills

You are helping the user write a **SKILL.md** — a focused capability an agent reaches for when a situation calls for it. Ground every suggestion in how Mantle actually discovers and loads skills (below); a "valid-looking" skill that violates these rules silently does nothing.

## What a skill is here

A skill is one directory with a `SKILL.md` inside. Mantle discovers them from two roots:
- **Agent skills** — `<workspace>/skills/<dir>/SKILL.md` (this agent only).
- **Global skills** — the shared global skills dir (every agent).
- On a name collision the **agent skill wins**. Resolution precedence for enable/disable: agent-disabled > agent-enabled > globally-disabled > on by default.

Skills are **live on the agent's next message** — no restart. A directory ≥256KB or a `SKILL.md` with no `description` is **silently skipped**.

## The frontmatter contract

```yaml
---
name: short-kebab-name        # optional; defaults to the directory name
description: One line...        # REQUIRED — omit it and the skill is invisible
always: false                  # optional; true = full body in EVERY prompt (rare)
platform: windows              # optional; windows|macos|linux — OS-filtered out otherwise
---
```

- **`description` is mandatory and load-bearing.** It is the ONLY thing the model sees for a non-`always` skill — it's the trigger line that decides whether the body gets pulled in. No description ⇒ discovery drops the skill entirely. Never propose a skill without one.
- **`name`** is optional; if omitted the directory name is used. Keep it kebab-case.
- **`platform`** filters the skill off other OSes — only set it for genuinely OS-specific skills.

## Write the description as a trigger, not a title

The description answers **"when should the agent reach for this?"** — third person, concrete, keyword-rich. The model matches the user's situation against it.

- ✅ `Render and post images to the channel. Use when the user asks for a picture, chart, or visual, or when a reply would land better as an image.`
- ❌ `Image skill.` (no trigger, no keywords — the model can't tell when it applies)
- ❌ `Helps with various media tasks.` (vague — matches everything and nothing)

Lead with the action verbs and nouns a relevant request would contain. If you can't say *when* in one line, the skill is probably two skills.

## Write the body as the procedure

The body is what the agent follows once the skill triggers. Treat it as **progressive disclosure**: the description got you in the door, the body delivers the actual how.

- Open with a one-line statement of what the skill does and when it applies.
- Give concrete steps, the exact tool/command names, and the gotchas — the things the agent would otherwise get wrong.
- Show a short example of the good output shape.
- Keep it scannable: short sections, real commands, no filler. Cut anything the base model already knows.
- Reference bundled assets by relative path; the agent reads them on demand via `{workspace}/skills/<dir>/<file>` or `{global}/<dir>/<file>`.

## `always: true` — use sparingly

An `always` skill inlines its **whole body into every prompt** (cap ~12K chars; keep the always-set to 3–5 total). Reserve it for standing rules the agent must apply unprompted (a house style, a safety rule). Everything else stays triggered-only — its body is read on demand, costing nothing until it's relevant. When unsure, leave `always` off.

## Template

```markdown
---
name: my-skill
description: <verb-first, when-to-use trigger line with the keywords a relevant request would use>
---

# My skill

One line: what this does and when it applies.

## Steps
1. ...
2. ...

## Notes / gotchas
- ...
```

## Helping in the deck

You're editing the **open** `SKILL.md`. When a change is wanted, call `propose_edit` once with the COMPLETE revised file (frontmatter included) — the user reviews it as a diff. Before proposing, sanity-check: does it still have a `description`? Is that description a real trigger line? Is the body concrete? If the user is fixing a skill that "isn't firing," the description is almost always the culprit — make it match the situations they describe.
