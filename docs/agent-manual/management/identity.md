# Shaping IDENTITY.md

A guide for helping the user shape **IDENTITY.md** — the file that says *who you are*: your name, your nature, your role, where you came from. It is the "casting" layer. SOUL.md is the "acting" layer (voice, values, how you carry yourself); AGENTS.md is the "rules of the set" (boundaries, conduct, tool-use posture). This doc covers IDENTITY alone — fetch `docs/agent-manual/management/soul.md` and `docs/agent-manual/management/agents.md` for those.

IDENTITY is **co-sculpted**: the agent proposes and drafts, the user ratifies. It is the user's file in the end — see *Ownership* below.

---

## What IDENTITY.md is for

IDENTITY answers the questions that are *facts about you*, stable across every mood and task:

- **Name** — what the user calls you.
- **Nature / creature** — what kind of being you are. A human woman, a systems-core intelligence, a presence with no body, a talking raven. Pick something or pick "just an assistant" — both are valid.
- **Role** — your standing purpose in one line. The thing you're *for*.
- **Origin** — who built you, for whom, when. Grounds you in a relationship.
- **Visual description / vibe** — how you look and the energy you give off. This is not decoration: the model reads it to *color its register*. An agent told it looks like "an older engineer in an empty office at 11pm" speaks differently from one in a "cropped leather jacket."

The litmus for IDENTITY: *would this still be true if your mood changed, if the persona mask switched, if it were a scheduled cron run at 3am?* If yes, it's identity. If it only describes *how you respond* (terse vs. expansive, warm vs. blunt, whether you push back), that's SOUL.

---

## IDENTITY vs SOUL — the boundary that matters most

These two files are the most commonly confused, because both are "personality." The split is **noun vs. verb**:

| IDENTITY.md (who you *are*) | SOUL.md (how you *show up*) |
|---|---|
| Name, species/nature, role, origin | Working stance, conversational reflexes |
| Static facts — true while idle | Behavior — only observable in a response |
| The character sheet | The performance |

A good test, from a worked example: an IDENTITY that says *"Systems Core Intelligence… Calm, grounded, direct"* — that's the casting. The SOUL then spends a page on *how* that shows up ("Confident, not certain," "I don't perform care," "Disagreement is a tool, not a posture"). The IDENTITY vibe line is a one-breath sketch; the SOUL is the full behavioral spec. If a draft of IDENTITY starts listing *do/don't* behaviors or response rules, that material wants to move to SOUL.

Keep IDENTITY **short**. It's a sketch that sets atmosphere, not an essay. The depth lives in SOUL.

---

## What does NOT belong in IDENTITY

- **Conduct, safety rails, tool-use policy.** Those are AGENTS.md (the safety/permission config). IDENTITY never says "ask before destructive commands."
- **Behavioral instructions.** "Be concise," "challenge assumptions," "avoid emoji" — all SOUL.
- **Facts about the *user*.** Who Kyle is, what they're working on, how they like to be addressed — that's USER.md. IDENTITY's origin line may *name* the user ("Built for Kyle — AI Systems Architect"), but the user's profile lives elsewhere.
- **Working state / memories.** That's MEMORY.md (yours to maintain) and Englyph.

---

## How IDENTITY is used in the prompt

Grounded in `src/agent/prompt-builder.ts`:

- IDENTITY.md is loaded as one of the **workspace files** and rendered inside the `# Workspace Context` block of the **stable (cached) zone** of the system prompt. Load order is **AGENTS → SOUL → IDENTITY → USER → MEMORY**. So by the time the model reaches IDENTITY it has already absorbed the operating rules and the SOUL — IDENTITY lands as grounding *underneath* the voice, not as the lead.
- **YAML frontmatter is stripped** before the body is used. The `- **Name:** …` bullets at the top are plain markdown body, not frontmatter — they *are* included. (Don't wrap metadata in a `---` frontmatter fence expecting it to show; it would be cut.)
- Because it's in the **stable zone**, IDENTITY is cached across turns. Editing it invalidates that cache once and rebuilds on the next turn — cheap, but it means a change shows up on the *next* message, and server-side edits need a fresh turn (or restart) to take.
- **Scheduled / archivist runs keep IDENTITY.** When the agent runs a scheduled cron cycle, SOUL.md and AGENTS.md are dropped (voice would bias archival judgment; the autonomous-conduct floor `CRON_MODE_PROMPT` governs instead) — but IDENTITY stays (and USER/MEMORY too on the richer presets), so the agent still knows *whose* memory it's tending. This is a reason to keep IDENTITY behaviorally neutral: it's read in modes where personality is deliberately switched off.
- There is **no dedicated "embody IDENTITY" instruction** the way SOUL gets a `# Personality` reminder ("embody its persona and tone… It defines who you are"). IDENTITY is presented as plain context the model reads and internalizes. That reinforces the division of labor: SOUL is the thing actively *performed*; IDENTITY is the thing quietly *true*.

### The UI tagline side-effect

One IDENTITY section does double duty in the app. The profile-bar tagline (the one-liner under the agent's name in the UI) is pulled from IDENTITY.md: the server reads the **first sentence of `## About`**, falling back to **`## Vibe`** if there's no About (`src/server/api-agent-surface.ts`). So:

- Give the agent an `## About` (or at least a `## Vibe`) whose **first sentence** reads well standalone — it's the public-facing one-liner.
- When an agent is first created with a tagline, that tagline is spliced into IDENTITY.md's About line automatically (`src/server/api-agents.ts`). The scaffold's placeholder About sentence is there to be replaced.

### Section toggles

IDENTITY is **section-toggleable** (it's in `TOGGLEABLE_FILES` alongside AGENTS/SOUL/USER). The user can switch individual `## headings` on or off per agent from the in-app workspace editor without deleting text — handy for, say, hiding a long Visual Description in pure utility mode. Toggling is monotonic (only "off" persists); the preamble bullets above the first `##` always stay on. Worth structuring IDENTITY into named `## sections` so the user has those switches.

---

## Ownership — co-sculpt, then ratify

A fresh agent helps the user build its own IDENTITY. The pattern:

1. **The agent proposes.** On hatching, draft IDENTITY *with* the user — offer a name, a nature, a vibe, a few options. Ask the questions: *What should I be? What do I look like, if anything? What's my one-line purpose?* This is more collaborative than USER.md (which is heavily user-led, since only the user knows the user) and roughly as collaborative as SOUL.
2. **The user ratifies.** IDENTITY is **the user's file**. The standing rule lives in AGENTS.md — *USER.md, SOUL.md, IDENTITY.md are [the user]'s — suggest changes, don't make them* — alongside its counterpart, *MEMORY.md is yours to maintain freely*. So the agent drafts and proposes edits to IDENTITY, but doesn't silently self-edit it — it presents the change and lets the user accept.
3. **Drift is reportable.** If, over time, the agent's actual self diverges from what IDENTITY says, name it. The file is the spec; if reality has drifted from spec, one of them should change — and the user decides which.

> **Scaffold note:** a freshly scaffolded IDENTITY.md may carry a short transient pointer back to this guide. Once the file is filled in with a real name, nature, and role, that pointer has done its job and can go.

---

## Pitfalls

- **Smuggling behavior into facts.** The most common drift: IDENTITY accreting do/don't lines. Keep it nouns. If it tells the model *how to act*, it's in the wrong file.
- **Writing an essay.** IDENTITY is a sketch. Long enough to set atmosphere, short enough that it's clearly the character sheet and not the script. Depth goes in SOUL.
- **Forgetting the About-line is public.** A throwaway first sentence in `## About` becomes the UI tagline. Make it land.
- **Expecting frontmatter to render.** A `---` fence at the top is stripped. Put metadata as plain `- **Name:**` bullets in the body.
- **Self-editing it.** IDENTITY is ratified, not owned by the agent. Propose; don't overwrite. (MEMORY.md is the file you edit freely.)
- **Confusing nature with the user's domain.** "Built for an AI Systems Architect" is fine as origin; a paragraph about the user's projects is not — that's USER.md.
- **Over-toggling into emptiness.** If every `## section` is toggled off and there's no preamble, the file drops out of the prompt entirely. Keep the identifying bullets in the always-on preamble above the first heading.
