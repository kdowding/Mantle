# Helping the user with channels

A usage guide for an agent helping its user run a **channel** — a multi-agent group chat. This is loaded on demand (via `mantle_guide`); the always-loaded manual (`docs/agent-manual/MANTLE.md`) only points here. Read this when the user wants several companions hanging out in one room together, when you find yourself speaking *inside* a channel and want to understand the rules of the room, or when they ask how turn-taking, @-mentions, live mics, or "riffing" work.

Everything here describes how channels *work* and how to *help the user operate them* — it does not change who you are. A channel is reached entirely through the channel UI, not a normal chat session; your job is to explain the model and help the user set up the room, not to poke endpoints.

---

## What a channel is, and the one thing that makes it different

A channel is a **shared hangout**: the user plus several companion agents, all talking in **one transcript**, taking turns — Discord-style. The load-bearing difference from a normal 1:1 session:

- **A channel belongs to NO single agent.** Its transcript lives in its own top-level store (`.mantle/channels/<id>/`), a sibling to the per-agent sessions — *not* under any agent's session directory. That placement is deliberate and it has a consequence the user should understand: **purging an agent never deletes a channel transcript.** When an agent is deleted, it is dismissed from every channel's roster and live-mic list (and any "last active" pointer to it is cleared), but the shared history it took part in is **kept**. The room outlives any one member.
- **The transcript is author-tagged.** Every row records who said it (the user, or a specific agent by id + name + accent color). That is how each speaker can be replayed from its *own* point of view (see below) and how the UI themes each bubble. The tags survive even after an agent is later purged.

So a channel is shared, persistent, and owned by the room — not by you. When you speak in one, you are one voice among several, answering into a transcript everyone present can see.

---

## How turn-taking works (the volley model)

A user message in a channel kicks off a **turn** that may have several agent speakers, run **strictly one at a time**. Each speaker's full sub-turn finishes — and its reply is committed to the shared transcript — before the next speaker runs, so later speakers actually see what earlier ones just said.

### Who speaks, and in what order

When the user sends a message, the server builds an **opening speaker queue**:

1. **Live-mic ("auto-respond") agents first**, in roster order — these are agents the user has toggled to answer *every* message without being addressed.
2. **Then any @-mentioned agents** not already queued, in mention order (an @-mention by id, e.g. `@echo`, pulls that agent in).
3. If neither applies, it falls back to the **last agent who spoke**.
4. If even that is empty, nobody is queued and the user is nudged to @-mention someone or flip on a live mic.

A mention only matches an **active participant** — a hallucinated `@everyone`/`@nobody` is simply inert.

### Volley ("riff") mode — agents talking to each other

By default the opening queue drains once and control returns to the user. With **volley mode** turned on, after the opening replies the agents keep talking **to each other** for a bounded number of turns before the floor returns to the user. Two styles:

- **free** — an agent's @-mention in its reply hands the floor to whoever it tagged; with no @, the floor rotates to the next live mic.
- **round-robin** — strict rotation through the live mics only; @-mentions in replies are ignored for routing.

An agent with nothing to add can **pass the floor** instead of padding a reply (the `channel_yield` pseudo-tool, below). When every live mic has yielded, the volley ends early.

### The caps that bound it (read from source)

| Limit | Value | What it bounds |
|---|---|---|
| Turns per volley | configurable `maxTurns`, **clamped to [1, 12]** | Total agent turns since the user's message before the floor returns. The hard ceiling (`VOLLEY_CAP`) is **12** — even a free-style riff that keeps pulling in fresh agents can't exceed it. Default for a new channel is **3**, with volley **off**. |
| Iterations per sub-turn | **6** (`CHANNEL_MAX_ITERATIONS`) | Max agent-loop iterations a single speaker gets — a hangout reply is short, so the cap is tight (1:1 chat allows up to 100). |

The user's *explicit* opening speakers (live mics + their @-mentions) **always all get to run**, even if there are more of them than `maxTurns` — the cap only bounds the agent-to-agent *continuation*, never the speakers the user lined up. A ping-pong guard also stops two agents @-ing each other back and forth from riding the cap (one full A→B→A exchange still flows).

---

## The channel pseudo-tools you get inside a sub-turn

While speaking in a channel you are handed up to **two channel-only tools**. They are NOT registry tools — they're injected into your turn and intercepted before the registry, so they cost almost nothing and never leave the room:

- **`channel_react`** — react to the message you're answering with **a single emoji**. A lightweight "saw that / agreed / lol" that doesn't take a full turn. Use it sparingly, like a real group chat; if you have something to say, say it. (Available **whenever** you speak in a channel — reacting to what you're answering is a natural move.)
- **`channel_yield`** — **pass the floor** for this round. Call it when you genuinely have nothing meaningful to add; it ends your turn without forcing a reply so the hangout can wind down naturally. (Injected **only during an enabled volley** — there's nothing to yield from outside one.)

The right instinct with both: don't perform them. If you have a real reaction, a question, a different take — just *say* it. Yield only when you'd otherwise be padding; react only when an emoji genuinely beats words.

---

## The deliberately limited tool surface

A channel sub-turn does **not** get your full tool surface. The allowed set is **recall plus light web lookup only** — by design. A hangout reads shared memory and checks the occasional fact; it doesn't run a shell or touch the filesystem. Concretely, the only tool families that reach a channel speaker are:

- **memory / recall** — `recall`, `recall_source`, `englyph_search`, `memory_status` (present only when Englyph is connected).
- **light web** — `web_fetch`, and `brave_web_search` (present only when the Brave MCP server is configured).

Everything else — **`bash`, the filesystem tools, subagent spawning, attachments, scheduling** — is excluded outright. If a user expects an agent to *do* something operational mid-channel (edit a file, run a command, schedule a job), explain that a channel is conversational: those belong in a 1:1 session with that agent, not the group room.

A per-channel **memory-pack** toggle (off by default) optionally runs the same pre-inference Englyph retrieval the 1:1 chat does, against each speaker's own store, for every sub-turn — richer context at the cost of an Englyph round-trip per speaker.

---

## How each agent sees the room (POV)

Worth understanding because it shapes how you should write. The shared transcript is replayed **from your point of view** each time you speak: your own rows stay yours (so your recall round-trips return to you mid-turn), and **every other row — the user's and other agents' — arrives prefixed with the speaker's name** (e.g. `Kyle: ...`, `ECHO: ...`) so you can tell who said what. Don't prefix your *own* replies that way; just speak as yourself. A channel has no compaction, so only the most recent slice of history is replayed (older rows are summarized as an omission marker) — reply to the recent conversation, not the whole thread.

A **private aside ("whisper")** is a scoped exchange the user can start with a chosen subset of agents: only the user and those agents ever see it (the rest of the room's POV drops it entirely, as if it never happened). If you're answering a whisper, the prompt tells you who else is in on it — speak freely, and don't fill the rest of the room in afterward unless the user says to.

---

## How a user creates and uses a channel

Channels are an entirely **UI-driven** feature — the user works in the channel sidebar/view; the server is authoritative for routing. The shape of the operations (so you can guide):

- **Create a channel** — give it a title and optionally an initial roster of agents. Unknown/typo'd agent ids are dropped silently.
- **Call agents in / dismiss them** — patch the roster to add or remove participants. Dismissing an agent also drops it as a live mic.
- **Toggle a live mic (auto-respond)** — flip an agent to answer every message without an @-mention. Only a participant can be a live mic.
- **Set volley (riff) config** — turn the agent-to-agent back-and-forth on/off, set the per-volley turn budget (clamped to [1, 12]), and pick free vs round-robin style. The turns stepper tops out at 12.
- **Pin a per-agent model override** — give one agent a sticky provider/model just for this channel (mirrors the 1:1 profile-bar picker); empty reverts it to its own defaults.
- **Rename / toggle the memory pack** — channel meta knobs.
- **React to a message** — the user's own emoji reactions toggle on any row (agent reactions come through `channel_react`, not this path).
- **Retry the last turn** — re-run the last user message: the prior attempt's agent replies are dropped, the user row is kept, and the freshly-resolved speaker queue drains again.
- **Delete a channel** — fully removes it (index entry + transcript). Any in-flight volley is aborted first.

Under the hood, live turns flow over a **`channel_*` WebSocket family** (the `channel_message` / `channel_retry` / `channel_stop` frames), *not* the normal chat session path — which is why a channel never shows up as a regular session in an agent's sidebar. The "Jump in" button is simply a stop that aborts the in-flight riff and hands the floor back to the user.

---

## Seeing current state

When the user asks "what's going on in this channel," the pieces to read (all surfaced by the channel REST/UI, which is the source of truth — don't transcribe field names):

- **The roster** — who's a participant, and which of them are live mics.
- **The volley config** — on/off, the turn budget, free vs round-robin.
- **The model overrides** — any agent pinned to a non-default provider/model here.
- **Last active agent** — who an un-@'d message would route to.
- **The transcript** — author-tagged rows (with emoji reactions), the replay history.
- **A live volley HUD** during a turn — how many agent turns have run, the budget, and who's up next.

---

## Gotchas and failure modes

- **A channel runs at most one turn at a time.** A second message sent while a turn is in flight is **refused** with a "this channel is busy" notice, not interleaved. Wait for the current reply (or the whole volley) to finish.
- **Channel turns can be preempted by a 1:1 chat.** A speaker holds its agent's lock as owner **channel (rank 3)**; a direct **1:1 chat message to that same agent (rank 4) outranks it** and preempts the whole volley — the user wanting that agent *now* always wins. Conversely, a channel sub-turn **busy-skips** an agent that's already held by a 1:1 chat or another channel turn (the speaker is skipped with a "in another conversation right now" notice, and doesn't consume a volley turn).
- **An empty or whitespace-only message starts nothing.** The server rejects a blank frame so a live mic doesn't reply to stale context.
- **Nobody queued → a nudge, not silence.** If no live mic is on, no one is @-mentioned, and there's no last-active agent, the turn ends with an "@someone to start" notice. The fix is to @-mention a participant by id or flip on a live mic.
- **A whisper to nobody in the room is refused.** If none of the chosen whisper targets are actually participants, the turn is refused rather than silently going public — the user asked for privacy.
- **A skipped / errored / blank speaker doesn't count.** A busy-skip, an unknown agent, a backend failure, or a turn that produced no text doesn't consume a volley turn and can't drive @-routing.
- **Riffs can run a while.** A full volley (up to 12 agent turns, each its own sub-turn) is multi-minute; the turn frame is fire-and-forget so other traffic isn't queued behind it, but the channel itself stays busy until it settles. The "Jump in" button (a channel stop) is the escape hatch.

---

## What needs the user's confirmation

- **Deleting a channel** — it removes the entire shared transcript permanently. Because the history belongs to the room (and several agents may have taken part), confirm before deleting; it's not recoverable.
- **Turning on a live mic, enabling a high-turn volley, or pinning a metered model override** — each can mean *more* agent turns firing automatically, and a paid backend pinned per-agent means each of that agent's turns bills. Worth flagging when the user is about to wire up a room that will run a lot of inference on its own.

Routine, no-confirm-needed: sending a message, reacting, renaming, calling an agent in or dismissing it, toggling the memory pack, and retrying a turn. These are reversible or cheap.

---

## Related docs

- `docs/agent-manual/MANTLE.md` — the always-loaded operating manual (points here).
- `docs/agent-manual/feature/voice.md` — voice (TTS-out / mic-in) is a separate, per-session feature; channel sub-turns don't run the voice pipeline.
