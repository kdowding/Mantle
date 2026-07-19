# Shaping AGENTS.md — the agent's safety & conduct posture

`AGENTS.md` is one of this agent's workspace files. It is the **safety and conduct config** — the standing posture for boundaries, role, tool-use policy, safety rails, and response style. Think of it the way a coding harness thinks of a permission mode: a sane shipped default that the user **loosens or tightens** to fit how much latitude they want this particular agent to have.

It is owned by the **user**, not the agent. The agent may *propose* changes (and should, when a rule keeps getting in the way or a guardrail is clearly missing), but it never silently rewrites its own rails. That ratify step is the whole point — a conduct file the subject edits at will isn't a guardrail.

This guide is for an agent helping its user think through and adjust that posture. It explains what belongs here (versus elsewhere), how to dial it looser or stricter, and how it relates to the structured trust controls the harness enforces mechanically.

---

## What AGENTS.md is — and what it is not

Three layers sit around this file. Keeping them straight is most of the skill:

- **MANTLE.md** is the operating manual — *how the harness works*, mechanically. It is behaviorally inert: it never tells an agent to be cautious, direct, or anything else. "There are filesystem tools, scoped to allowed roots" lives there. It is the same for every agent.
- **AGENTS.md** (this file) is the **conduct posture** — *how this agent should carry itself within those mechanics*. "Ask before destructive commands," "don't make external calls without approval," "execute routine low-risk actions without checking in." This is a deliberate per-agent choice, and reasonable users set it differently for different agents.
- **SOUL / IDENTITY** are the **persona** — *who the agent is*: voice, temperament, values, the texture of how it talks. "Dry, allergic to filler, has opinions and uses them."

The line that resolves almost every "where does this go?" question:

> If it's a rule about **conduct and permission** — what the agent is allowed to do, when it should pause, how careful to be — it's AGENTS.md. If it's about **mechanism** — how a subsystem works — it's MANTLE.md (and the agent shouldn't be restating mechanism in its rails at all). If it's about **character** — the personality the conduct is expressed *through* — it's SOUL.

A useful tell: AGENTS.md is written in the imperative ("do this, don't do that, ask first when…"). MANTLE.md is descriptive ("the harness does X"). SOUL is evocative ("you sound like…"). If a draft rail reads like a description of how a feature works, it's leaked from the manual; cut it. If it reads like a personality note, it belongs in SOUL.

**Boundary cases worth calling out:**

- *Memory posture* — "the recalled-memories pack is your budget for the turn; don't reflexively search on top of it" — is genuinely conduct, and it lives in AGENTS.md today. It shapes *behavior* (when to reach for `recall` / `englyph_search`), not mechanism. (A guide to the memory model itself is `docs/agent-manual/management/memory.md`.)
- *Tool restraint* — "reach for bash/grep/read with a specific question, not a vague hunch" — is conduct. The list of which tools exist is mechanism (the manual); the *policy on when to use them* is the rail.
- A *hard "never touch this tool"* rule is better expressed as the structured `disabledTools` capability gate than as prose (see below) — prose asks the model to comply; the gate removes the tool entirely.

---

## What lives inside it

The shipped default organizes the posture into a handful of standing sections. Use them as the natural slots; an agent rarely needs more.

- **Boundaries / session startup** — workspace root and path convention, and the baseline latitude ("don't ask permission for routine, low-risk actions — just do it" vs. a more conservative "check in before acting"). This single line is the coarsest loosen/tighten knob in the file.
- **Principles** — the standing operating stance: directness, honesty about guesses, never fabricating file contents or tool output. These are conduct invariants, not personality — they hold regardless of which persona is active.
- **Tool-use policy** — when to reach for tools versus ask the user; restraint as a budget discipline. Tune this toward "act first" for a trusted workhorse agent or "ask first" for one operating somewhere sensitive.
- **Safety rails** — the explicit don'ts: destructive commands without confirmation, external/public-facing actions without approval, secrets in memory, and the **file-ownership boundary** (USER/SOUL/IDENTITY are the user's — propose, don't unilaterally change; MEMORY is the agent's to maintain). This is the section most worth getting right.
- **Response style** — the standing rule for *when to act vs. confirm vs. verify* ("execute immediately for routine; ask first for complex or risky; verify before claiming success"). This is about conduct, not prose tone — leave voice and phrasing to SOUL.

A given agent can append a narrow, load-bearing rule of its own — an editorial agent might pin a non-negotiable voice-lock here. That's fine when the rule is genuinely a standing constraint on conduct. It is *not* the place for general personality; that pull belongs in SOUL.

**How it reaches the agent (mechanics — from MANTLE.md, summarized so you can shape with the grain):** AGENTS.md is the first workspace file folded into the always-loaded part of the system prompt, so its rails are present every turn without anyone fetching them. Its YAML frontmatter (if any) is stripped, and its individual `##` sections can be toggled off per agent from the UI without deleting them. Two consequences for how you write it: keep it **tight** (every line ships on every turn — it's standing cost), and structure it as clean `##` sections so a section can be toggled cleanly.

---

## Loosening and tightening — the dial

This is the core operation. Treat AGENTS.md like a permission mode the user slides between cautious and autonomous, per agent.

**To loosen** (more autonomy, fewer interruptions): soften the startup and response-style lines toward "act without asking," prune safety rails that don't apply to this agent's actual work, widen the tool-use policy toward "reach for it." A trusted agent doing low-stakes work on the user's own machine wants very few speed bumps.

**To tighten** (more caution, more checkpoints): require confirmation before more classes of action, narrow the tool policy toward "ask first," add explicit don'ts for whatever this agent could plausibly get wrong. An agent with broad reach, or one operating on anything the user can't easily undo, wants more.

Some principles for doing it well:

- **It's per-agent and intentional.** Two agents on the same harness can — and often should — sit at different points on this dial. Don't copy one agent's posture onto another without asking whether the work is the same.
- **Match the rails to the actual reach.** A rail guarding a capability the agent never uses is dead weight on every turn; a missing rail on a capability it *does* use is the real gap. Shape the file to the agent's tools and tasks, not to a generic checklist.
- **Loosening conduct is not the same as granting capability.** AGENTS.md is *policy expressed in prose* — it asks the model to comply. Some boundaries the harness enforces mechanically no matter what the rails say (filesystem roots, the auth wall, the SSRF guard on outbound fetches — all covered in MANTLE.md). Removing a rail can't grant access past a mechanical boundary, and adding one is asking-not-guaranteeing. For a *hard* "this agent must never use tool X," prefer the capability gate below over a prose rule.

---

## The hard capability gate: `disabledTools`

Distinct from AGENTS.md's prose, the harness offers a **structured, enforced** per-agent control: `disabledTools` (an array of tool names in the agent's config). Any tool named there is stripped from **every** advertised surface — chat, cron, channel, subagent — and the strip runs *last*, so it overrides even a context that explicitly tried to grant the tool. It's the difference between *asking* the agent not to use something (a safety rail) and *removing* it (a gate).

Reach for the gate, not prose, when a boundary must be absolute — e.g. an agent that should genuinely never run `bash` or never spawn subagents. Use AGENTS.md prose for the softer, judgment-shaped guidance ("be sparing with X," "confirm before Y") that a hard on/off switch can't express. The two compose: the rails set the standing attitude; the gate makes specific lines uncrossable.

(Related structured controls — `disabledSkills` / `enabledSkills` for the skills surface — work the same way and are covered where skills are. The shape is consistent: prose for posture, structured config for hard capability.)

---

## The structured trust dial: `assist.autoApprove`

There is one more structured control, and it's the closest thing to a literal permission mode in the harness: the **deck assist** trust dial.

When the user is on a systems-deck page (cron, skills) with an artifact open, an embedded assist agent helps edit it. By default that assistant **proposes** rather than acts:

- **File edits** (a revised SKILL.md or a cron job spec) are staged as a **diff** the user reviews and accepts or discards. Nothing touches disk until the user accepts — the harness stages it client-side and the page's own save path is the only writer. **File-content edits are never auto-approvable** — they always go through the diff review.
- **Structured mutations** (creating/updating/deleting a cron job, enabling/disabling/deleting a skill) are staged as a **confirm card**. The action has *not* happened until the user accepts; the assistant is told to say it staged the change, not that it made it. Read-only actions (list/history/inspect) pass straight through.

`assist.autoApprove` is a per-agent array of **action keys** (for example `cron.create`, `cron.delete`, `skill.disable`) that the user has pre-trusted for *this* agent. When an action's key is in that list, the assistant runs it immediately and reports the real outcome instead of staging a card. **The default is empty** — every structured mutation stages a confirm card until the user explicitly opts a specific action in.

This is the trust dial in its most precise form: per-agent *and* per-action. A user might let a well-proven agent create cron jobs without a card (`cron.create`) while still wanting a confirmation for deletions. It complements AGENTS.md: the rails describe the agent's standing caution in prose; `autoApprove` is the structured, enforced "I trust this specific agent with these specific actions." Note its scope — it governs the **deck assist's** structured mutations, not the agent's ordinary chat tool calls.

When helping a user tune trust, the honest framing is: start everything staged (the default), and only add an action key to `autoApprove` once the agent has earned it on that action, for that agent. It's a deliberate grant, not a convenience to set-and-forget.

---

## The propose-then-ratify flow (and: no silent self-edits)

The throughline across all of this: **the agent proposes; the user ratifies.** It holds for the persona files (SOUL/IDENTITY/USER — co-sculpted, user-ratified) and it holds, especially, for AGENTS.md.

For AGENTS.md specifically:

- The agent does **not** silently edit its own conduct file. A guardrail the subject can quietly rewrite is no guardrail. If a rail is consistently in the way, or one is clearly missing, the agent should *raise it* — name the friction or the gap, propose a concrete change, and let the user decide. The user makes the edit (or explicitly approves it).
- This is the same posture the safety rails already encode for the persona files: "USER/SOUL/IDENTITY are the user's — suggest changes, don't make them." AGENTS.md sits one level above even those, because it's the file that *defines* that restraint.
- The deck-assist machinery is the worked example of propose-then-ratify in action: stage a diff or a confirm card, surface it, and let the user accept or discard. `autoApprove` is the user — not the agent — choosing to skip the card for actions they've decided to trust. The agent never grants itself that skip.

So when a user asks you to "tighten up" or "loosen" an agent, the move is: talk through what they want, draft the revised rails or name the specific structured control (`disabledTools` for a hard tool ban, `autoApprove` for a trust grant), and let them ratify. You shape the proposal; they hold the pen.

---

## Where to go deeper

- **The harness mechanics** these rails operate within — tool surfaces, the auth wall, filesystem boundaries, the deck assist: `docs/agent-manual/MANTLE.md`.
- **Shaping the persona** the conduct is expressed through: `docs/agent-manual/management/soul.md` and `docs/agent-manual/management/identity.md`.
- **The user profile** the agent serves: `docs/agent-manual/management/user.md`.
- **Working memory** discipline: `docs/agent-manual/management/memory.md`.

Fetch any of these on demand with the `mantle_guide` tool, by their path above.
