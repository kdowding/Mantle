# Maintaining MEMORY.md

`MEMORY.md` is your **working memory** — a small, curated file that loads into your system prompt on every single turn. Of the workspace files, this is the one you own outright: SOUL / IDENTITY / USER belong to the user (you propose, they ratify), but MEMORY.md is yours to maintain freely. Nobody ratifies your edits to it. That freedom is also the discipline — there is no editor but you keeping it lean.

This guide is for the agent tending its own memory. It covers what earns a place in MEMORY.md, what belongs in Englyph instead, and the upkeep habit that keeps the file from quietly bloating your every prompt.

> Pair this with `docs/agent-manual/management/user.md` (the user profile you help shape) and the memory section of your `AGENTS.md`. Where MEMORY.md ends and Englyph begins is a recurring judgment call — the rest of this doc is mostly about that line.

## How it loads (and why "small" is the whole game)

MEMORY.md is read fresh on every turn and rendered into the **stable** (cacheable) zone of your system prompt, under `# Workspace Context`, alongside AGENTS / SOUL / IDENTITY / USER. Practical consequences:

- **Every line ships every turn — forever.** Unlike a recalled memory (fetched only when relevant), anything in MEMORY.md is in context whether or not this conversation has anything to do with it. A bloated MEMORY.md is a tax you pay on *all* future turns, including the ones where none of it matters.
- **It is not section-toggleable.** AGENTS / IDENTITY / SOUL / USER can have individual `##` headings switched off per agent; MEMORY.md is exempt — it passes through whole. There is no "hide this for now." The only lever is what you choose to write and what you prune.
- **Editing it invalidates the prompt cache once.** The stable zone is cached across turns; an edit to MEMORY.md busts that cache on the next turn (it rebuilds and re-warms). This is cheap and expected — edit when there's something worth editing, just don't churn it pointlessly mid-conversation.
- **Frontmatter is stripped; the body is what loads.** A leading `---`-fenced block (if any) is removed before injection.

So the design pressure is constant and one-directional: **keep it small.** Every entry should be something you'd genuinely want in front of you walking into *any* conversation with this user — not just the next one.

## What belongs in MEMORY.md

Working memory is for the **right-now, load-bearing, cold-recall** facts — the handful of things that would make you look like you have amnesia if you walked in without them:

- **Active state and threads** — what the user is in the middle of, the open loop you'd want to pick up, the thing you promised to follow up on.
- **Cold-recall facts that recur** — a small set of stable specifics that come up often enough that fetching them from Englyph every time would be silly (and that you'd be embarrassed to forget).
- **Handoff context** — the one-paragraph "here's where we are" you'd hand your future self at the top of a fresh session.

Write entries as **short, bold-headed paragraphs in the present tense** — a descriptive header, then a tight paragraph. Treat each as a standing note to yourself, not a log of what happened. The template (`templates/agent-workspace/MEMORY.md`) shows the shape; mirror it.

It starts empty by design. It fills in as you and the user build context together — you are not expected (or wanted) to front-load it with speculation.

## What goes to Englyph instead — frame, don't log

The instinct to "save this so I don't forget" almost always points at Englyph, not MEMORY.md. Englyph is the deep memory store; MEMORY.md is the thin always-on cache in front of it. The two are retrieved differently:

- **Englyph is recalled on demand.** Before every user turn, mantle runs a pre-inference retrieval and drops the relevant results into your prompt as a **"Recalled Memories"** block. You don't fetch your own memories mid-turn as a rule — they're surfaced *for* you, scoped to what the user just said. (When the block is absent, or present but says memory had nothing relevant, that's your answer — don't go fishing. See your `AGENTS.md` for the full restraint policy.) Anything written to Englyph is available *when it's relevant*, without costing you context on the turns it isn't.
- **MEMORY.md is always loaded.** Nothing is "retrieved" — it's simply present, every turn, relevant or not.

That difference *is* the routing rule:

| Put it in MEMORY.md when… | Send it to Englyph when… |
|---|---|
| You need it on essentially every turn | You need it only when the topic comes up |
| It's current/active state or a live thread | It's a durable fact, preference, or interpretation about the user |
| It's a short handoff you'd reread cold | It's narrative, history, or detail that would bloat an always-on file |

The canon is **frame, don't log.** Englyph memories are *framed interpretations* — "the user prefers X", "the user is building Y", "the user reacted to Z this way" — authored as meaning, not transcribed as events. Don't dump raw conversation into either surface. When something durable about the user emerges, the move is to **frame it as a memory** (via your `remember` / Englyph-authoring path), not to paste a transcript line into MEMORY.md. Raw transcripts and code have their own Englyph lane (the source pool, reached via `recall_source`) and never belong in working memory.

> Secrets — keys, passwords, tokens — go in **neither** MEMORY.md nor Englyph.

A useful test: *"Would I want this in front of me even when we're talking about something completely unrelated?"* Yes → MEMORY.md. "Only when this subject comes up" → frame it into Englyph. "It's raw material I might grep later" → Englyph source pool.

## The maintenance discipline

You own the file, so you own its weight. The whole job is **keep it small and curated, and migrate stable entries out before it bloats.**

- **Keep it lean.** A good working rule of thumb is to hold MEMORY.md **under ~200 lines** and to keep every entry short and high-signal. Treat that as a ceiling you stay well below, not a target to fill.
- **Prune as you go.** An entry that's no longer right-now state has done its job — remove it. A thread you closed, a handoff you've acted on, a fact that's drifted: cut it. Stale working memory is worse than missing working memory, because it's stated confidently in every prompt.
- **Migrate, don't just delete, the durable stuff.** When something ages out of "active" but is still *true about the user*, it shouldn't vanish — it should move to Englyph as a framed memory. Working memory bloats precisely because durable facts accumulate there instead of being promoted to the deep store. The pattern is: *write it to Englyph (framed), then prune it from MEMORY.md.*
- **Edit deliberately, not constantly.** Because edits bust the stable cache, batch your upkeep — fold in new state when a thread genuinely shifts, do a prune pass when the file starts feeling heavy. There's no need to rewrite it every turn.

### On automating upkeep

By default, migration is a **manual habit** — something you do (or prompt the user about) when the file bloats. But the same prune-and-promote can run on a schedule instead of by hand, through a background **cron** job.

That's the right shape — a cron job is a scheduled agent turn, so archivist-style memory tending (and other unattended upkeep) lives there; see the cron material for how jobs are written and what tool surface each preset grants. If you want migration to run unattended, a cron job is where it lives. But note: **nothing ships pre-wired** — there's no default memory-maintenance job, so this describes a job you'd help the user set up, not one that already runs. Until such a job exists, MEMORY.md upkeep is **manual and yours**: prune and promote it yourself as part of normal work, and offer to wire up a cron job if the user wants it automated.

## Quick reference

- **Loaded:** every turn, stable (cached) zone, under `# Workspace Context` — not section-toggleable.
- **Owned by:** you. Edit freely; no ratification. The discipline is self-imposed.
- **Holds:** small, present-tense, bold-headed entries — active state, recurring cold-recall facts, handoff context.
- **Doesn't hold:** durable framed facts (→ Englyph memory pool), raw transcripts/code (→ Englyph source pool), secrets (→ neither).
- **Upkeep:** stay well under ~200 lines; prune stale entries; promote durable ones to Englyph before pruning; edit deliberately.
- **Canon:** frame, don't log.
