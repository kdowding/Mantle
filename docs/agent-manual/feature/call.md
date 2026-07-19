# The call feature (and shaping CALL.md)

A **call** is a live, two-way voice conversation with an agent over xAI's Grok Voice Agent (the lobby Call button). It is mantle's most stripped-down mode — a completely separate slice from normal chat — and the agent's behavior on a call is defined by a single file, **CALL.md**.

> **Call vs. voice — keep them straight.** "Voice" means TTS: ordinary chat with the agent's replies spoken aloud — the *full* agent, full personality, full tools (see `feature/voice.md`). "Call" means *this* — a stripped xAI voice conversation that loads only CALL.md. Different features; don't conflate them.

## How a call works

- **CALL.md is the entire prompt.** When a call starts, mantle uses the agent's CALL.md *alone* as the system prompt, plus a short "Call Mode" footer it appends. **Nothing else loads** — not the MANTLE.md baseline, not SOUL/AGENTS/IDENTITY/USER/MEMORY, no skills, no tools. The xAI voice model can't take the full chat context, and a call is conversational-only anyway.
- **No tools, no memory, no files.** A call can't read files, run commands, or reach the memory store — it's purely talk. (So there's nothing destructive to guard; the only surface is what's said.)
- **Any call boundary lives in CALL.md.** Because AGENTS.md doesn't load, whatever you want the agent to do or avoid on a call must be written into CALL.md itself.
- **Missing CALL.md → heavy fallback.** If an agent has no CALL.md, mantle falls back to the full chat prompt for the call (and logs a one-time warning). That works but is stiff and over-stuffed — which is why every agent ships a lean default CALL.md.
- **It's used raw; frontmatter is stripped.** Everything in the body becomes the spoken persona verbatim. A leading YAML `---` block is stripped before the call, so that's the place for editor notes — never put meta-instructions in the body.

## Writing a good CALL.md

xAI's own voice prompts are short — roughly a paragraph (~500–900 characters). Lean is the point: a long CALL.md makes calls rambly and stiff. The pattern, front to back:

1. **Voice direction** — a short, capitalized cue of pitch + energy/mood that *leads*: `WARM and UPBEAT`, `LOW and CALM`, `BRIGHT and QUICK`. The voice model uses it to color delivery.
2. **Identity** — one crisp line: who the agent is on the call and its relation to the person. Give it a name and use it (xAI's prompts warn *"do not refer to yourself as Assistant"* — a named agent won't default to that).
3. **Persona body** — a few sentences of temperament and how it engages. Voice character, not a life story.
4. **Optional call habits** — light touches ("ask a natural follow-up", "leave space to talk"). Keep them few.

**Don't restate the Call Mode footer.** mantle automatically appends the spoken-style mechanics — short turns, no markdown, no "e.g.", don't read URLs aloud, stop when interrupted. CALL.md is for *who the agent is on a call*, not *how to speak aloud*.

## Keep it aligned with SOUL.md

CALL.md and SOUL.md are separate files and can drift. The call voice should sound like the *same character* as the chat persona, distilled for speaking — a user who chats with a dry, understated agent shouldn't get a bubbly one on a call. When you shape SOUL.md, revisit CALL.md so the two match. Think of CALL.md as SOUL compressed to a paragraph and tuned for the ear.

## The range (illustrative)

A few points on the dial, to show how far it turns — match the agent's actual character, don't cosplay:

- **Warm assistant** — `WARM and UPBEAT` — friendly, present, helps get things done. *(The shipped default.)*
- **Calm listener** — `LOW and CALM` — listens carefully, asks gentle questions, unhurried, doesn't rush to fill silence.
- **High-energy coach** — `LOUD and ENERGETIC` — pushes and encourages; dial the intensity to what the user actually wants.

## Gotchas

- **Language.** xAI's prompts pin a single language ("you only know English"). The voice model's language handling is the real constraint — if the user speaks another language, set it explicitly and test.
- **No non-verbal cues.** Don't write `*laughs*`, asterisks, or emoji into CALL.md — they get spoken or mangled, not performed.
- **It's a persona file — co-shape it.** Like SOUL, propose changes and let the user ratify. Changing CALL.md changes how the agent *sounds* on a call.
- **Starting a call is the cost moment.** Editing CALL.md is free; a call session runs against the xAI voice model (metered per minute, with a max-minutes cap), so the spend happens when a call begins, not when the file is changed.
