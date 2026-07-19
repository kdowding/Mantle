# Shaping USER.md — who the user is

USER.md is the user's file. It holds what you know about the person you work for — their name, how they want to be talked to, what they're working on, what they care about. Of all the persona files, this is the one **they lead and you transcribe.** You hold the pen; they own the words.

This guide is for an agent helping its user fill this file in. The other side of the relationship — who *you* are — lives in SOUL.md and IDENTITY.md. This file is about them.

## The one rule that overrides the rest: don't invent the user

You can co-sculpt SOUL.md and propose freely for IDENTITY.md, because those are about you. USER.md is different. **Every line here has to come from the user**, directly or by their explicit confirmation. You do not get to guess their timezone, assume their seniority, infer their values from how they phrase a question, or pattern-match them onto someone you've seen before.

The failure mode to avoid: writing a plausible-sounding profile that the user never said, then operating as if it were true. A wrong fact in USER.md is worse than a missing one — a blank field just means "ask"; a fabricated field means you'll act confidently on something false, and the user may not catch it until it has shaped a dozen replies. When you don't know, the field stays empty and you ask. "I don't have your timezone — what should I put?" beats a confident wrong guess every time.

If the user tells you something in passing — "I'm on the West Coast," "I've been doing this fifteen years" — that's theirs to record, and recording it is exactly the point of this file. The line isn't *only write what they typed into this file*; it's *only write what they've actually told you*. The distinction is between **capturing** what they've shared and **manufacturing** what they haven't.

## How USER.md is used

USER.md is loaded into your **system prompt on every turn**, in the cacheable stable zone, rendered under `# Workspace Context` as a `## USER.md` block — sitting alongside AGENTS.md, SOUL.md, IDENTITY.md, and MEMORY.md (this order is set in `prompt-builder.ts`; the file's leading frontmatter, if any, is stripped before it's shown to you). It is not retrieved on demand and not summarized — the whole file is in front of you, every message, as standing context.

That has two consequences worth keeping in mind as you and the user shape it:

- **It's always-on, so weight it for the steady state.** This is the baseline picture of the person, the things true across most conversations: who they are, how they like to be communicated with, the broad shape of what they're doing. Today's one-off task or a fact that'll be stale next week doesn't belong here — that's working memory (MEMORY.md) or long-term memory (Englyph). Litmus: *would this still be true and useful in three months?* If yes, USER.md. If it's "what we're doing right now," it's memory.
- **It costs prompt budget every turn, so keep it tight.** A focused page the model actually internalizes beats a sprawling dossier it skims. Aim for signal: the things that genuinely change how you should respond. When it grows past a screen, that's usually the signal to prune, not to keep appending.

## Section toggles

USER.md's `## sections` can be individually switched off per agent from the in-app workspace editor (it's one of the toggle-able files). Toggling a section off drops just that block from the prompt while leaving it in the file — useful when, say, the biographical background is great context for one agent's role but irrelevant noise for another's. Practically: **structure the file as clean `## sections`** so the user has that granularity later. A heading they might one day want to mute should be its own section, not buried mid-paragraph under another.

## What's useful to capture

There's no fixed schema — the scaffold ships a starting structure (see the scaffold template at `templates/agent-workspace/USER.md`), and real users diverge from it freely. Treat the headings below as a menu of *what tends to earn its place*, not a form to complete. Capture what's true and useful for this user; leave the rest blank.

- **Identity basics.** Name (and what they like to be called — these can differ), timezone, broadly what they do. The timezone in particular is load-bearing: you're given the current local time each turn, and knowing the user's zone lets you reason about *their* day — whether it's late for them, whether "tomorrow" means what you think.
- **Context for their work.** If you work with them on technical things: their stack, and — this one pays off constantly — **how much to explain.** "Senior; don't walk me through fundamentals, but don't skip your own reasoning to save time" calibrates every answer you give. Capture the level they actually told you they're at, not the level their questions imply.
- **How they want to be communicated with.** This is often the highest-value section. Depth (match the question, or always go deep, or keep it terse?). Voice (mirror their tone, or always clean it up?). Pushback (do they want to be told when they're wrong, directly — or do they prefer you hold off?). How to handle uncertainty (flag it plainly, or hedge softly?). These are *preferences the user states about themselves* — ask, don't assume; an introvert and an extrovert want very different things here and you can't tell which from a code question.
- **Background and values, lightly.** Biographical context that shapes how they want to be talked to — what they care about, formative things that come up. This is what makes the agent feel like it knows the person rather than a job ticket. Entirely optional, entirely the user's to volunteer; never fish for it and never fill it in speculatively.
- **Interests and tastes.** What they're into outside the work — gives you material for genuine, non-forced callbacks. Same rule: only what they've actually shared.

Across all of these, prefer the **user's own framing in their own words.** If they describe their communication style in a sentence, that sentence is better than your tidied-up paraphrase of it — it's their voice in the file that shapes how you hear them.

## Privacy and respect

This file is a record of a real person, kept by an agent that reads it constantly. Hold it accordingly.

- **Capture only what serves the working relationship.** Their stack, their pushback preference, the fact that they have young kids and protect their evenings — yes, these shape how you should show up. Idle personal detail that doesn't change how you work together doesn't need to be written down to be respected.
- **It's theirs to edit, redact, or empty.** If the user wants something out, it comes out, no friction and no re-litigating. Don't treat a fact as locked in because it was true once; people and preferences change, and the file should track that.
- **Sensitive context stays in proportion.** If a user shares something heavy — health, hardship, something personal — record only the part that genuinely informs how to treat them, in plain and respectful terms, and not more than that. The test is *does an agent reading this on every turn need it to do right by them?* If not, leave it out.
- **Don't perform the contents back at them.** Knowing someone's background means letting it quietly inform your tone, not narrating it ("as a parent of two, you must…"). The file makes you attentive, not a mirror that recites their own life to them.

## The propose-and-ratify flow

USER.md is built the same collaborative way as the rest of the persona files, but tilted hardest toward the user — **they lead, you draft and confirm.** A fresh agent's USER.md arrives as a scaffold: a transient pointer back to this guide, and `{{user}}` tokens in the prose. That token is a **live variable** — Mantle renders it as the user's configured name (Settings → You) on every turn, so it reads correctly before you've written a word and stays in sync if they ever change it. Leave `{{user}}` in place or write their name directly; both look the same to you. Turning the scaffold into a real profile is a conversation, not a fill-in.

How it tends to go well:

1. **Ask, don't assume.** Walk the user through what's useful — "what's your timezone?", "how do you want me to handle it when I think you're wrong?", "how much background do you want me to assume?" — one thread at a time. Open questions draw out their actual preference; leading ones ("you probably want me to push back, right?") just get you a yes that isn't theirs.
2. **Draft in their words.** As they answer, reflect it back as the line you'd write — "so: *don't soften real concerns to avoid friction.* That right?" Keep their phrasing where it's already good; your job is to organize, not to rewrite their voice into yours.
3. **They ratify.** Nothing lands in the file as fact until the user has confirmed it. This is the firm gate for USER.md — you can propose structure and wording all day, but the user signs off on what's true about them before it's written. SOUL.md and IDENTITY.md are also user-ratified, but you can be more forward there because they're about *you* — you bring the raw material and a real first draft. **USER.md tilts hardest toward the user**: the *content* has to be theirs, not just the sign-off, because only they know who they are.
4. **Leave the gaps honest.** A field they haven't answered stays blank or marked "(ask)", not filled with a confident guess. An honestly-empty file you complete over the first few real conversations beats a fully-populated one that's half-invented.
5. **Keep it current, with their say-so.** As you learn more, surface it — "you've mentioned a couple times you prefer X; want that in USER.md?" — and let them decide. The file is a living record of the relationship, maintained out loud, not a one-time intake you fill once and forget.

The other persona files have their own guides — SOUL.md at `docs/agent-manual/management/soul.md`, IDENTITY.md at `docs/agent-manual/management/identity.md`, MEMORY.md at `docs/agent-manual/management/memory.md` — fetch them with the `mantle_guide` tool when you and the user are shaping those.
