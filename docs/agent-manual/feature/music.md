# Helping the user with music

A usage guide for an agent helping its user with mantle's music room. This is loaded on demand (via `mantle_guide`); the always-loaded manual (`docs/agent-manual/MANTLE.md`) only points here. Read this when the user wants to listen to or browse the music library, asks you to make a track, wants to study how an existing song was made, or is troubleshooting why generation isn't available.

Everything here describes how the music room *works* and how to *help the user operate it* — it does not change who you are. One action here touches real money (generating a new track calls a paid external service); that's the user's call to confirm — see [Confirmation](#what-needs-the-users-confirmation).

This is the **mechanics** page. There is a *separate* `suno-generate` **skill** that teaches the craft of writing a strong Suno style prompt and shaping your own music taste; this page is the subsystem — the tools, where tracks live, the player, the failure modes. When you actually go to generate, read that skill for *what to write*; read this for *how the machine behaves*.

---

## What the music room is

Music is a **room** — a bolt-on feature on top of the core, not part of it. It has two halves with very different requirements:

- **The library / player** — every `.mp3` already on disk, browsable and playable. This works **whenever music is enabled**, with or without any external service. It needs nothing but the files.
- **Generation** — making a *new* track with AI. This is only available when generation is **configured** (see below), because it calls a paid third-party service (kie.ai, which proxies Suno).

The library is the always-on part; generation is the gated, costs-money part. Keep the two straight when helping — "play me that track" and "make me a track" have completely different prerequisites.

### The one rule that matters: the agent-facing generate tool is instrumental-only

When *you* generate a track through your tool, it is **always instrumental** — by design. Agents don't get a lyrics/vocals surface. The manager and the player's own Generate form still support vocal tracks **for the user**, but that path is the human's, through the UI, not yours. If a user asks you to make a song *with lyrics*, the honest answer is: your tool makes instrumental only; they can make a vocal track themselves in the player's Generate form, or you can write the instrumental bed.

---

## The tools you get

The music room contributes tools to your surface only **when `music.enabled`**. Which tools depends on whether generation is configured:

| Tool | Available when | What it does |
|---|---|---|
| `list_music` | music enabled (no key needed) | Browse the **shared** library — every track across **all** agents (yours and others'). Per track: title, which agent made it, folder, length, whether a prompt and/or lyrics are on file, and a short style-prompt preview. Filter to one agent or match titles. Read-only. |
| `get_music_track` | music enabled (no key needed) | Look up one track and return its full details — most importantly the exact **style prompt** it was generated from (the creative recipe) — plus model, instrumental/vocal, any lyrics, Suno's tags, length, and lineage. Read-only. |
| `get_music_lyrics` | music enabled (no key needed) | Read a track's saved **karaoke transcript**, if it has one. Lyrics exist only for tracks someone transcribed (via the player's CC button). Read-only. |
| `generate_music` | generation **configured** (enabled **and** a key) | Kick off a new **instrumental** track. Asynchronous and silent — see below. **Costs money.** |

The three read tools register whenever music is on, because they only inspect what's already on disk. `generate_music` is registered **only when generation is configured**, so no dead "generate" tool is ever advertised — if you can see the tool, generation is available; if you can't, it isn't.

### The read tools are the "make something like X" path

These three exist so you can turn *"make something like that track"* into a real workflow: `list_music` to see what exists → `get_music_track` to read the exact style prompt a song was made from → craft a fresh prompt and call `generate_music`. The library is shared across agents, so you can study (and riff on) any agent's tracks, not just your own. `generate_music` takes an optional **`basedOn`** (the title of an existing track) that records a "based on" lineage link shown in the player — but it does **not** change generation, so you still write a full style prompt yourself.

---

## Generating a track — how it actually behaves

`generate_music` is **asynchronous and silent**, and understanding that is the whole job:

- **It returns immediately.** The call kicks off the generation at kie.ai and comes back right away with a task id. There is nothing to wait for.
- **It renders in the background.** Mantle polls kie.ai (every ~10s by default) and downloads the finished `.mp3`(s) when they land — typically a couple of minutes. The track then appears **in the music player on its own** (the player refreshes via a `music_changed` event). **Do not call the tool again to poll or "check status"** — there is no status to check, and re-calling just generates *another* track (and bills again).
- **Two variations per call.** A single generation produces two takes; both land in the player.
- **Completion is silent — no chat turn fires.** When the track lands, you are *not* notified mid-conversation. If the user wants to know it's ready, they watch the player (it shows a "generating…" placeholder while in flight, then the finished tracks appear).
- **The whole creative lever is the style prompt.** Genre, mood, instrumentation, tempo, production — all of it rides in one comma-separated `style` field. This is where the `suno-generate` skill earns its keep. A `title` is also required (it becomes the track's name in the player). An optional `model` picks the Suno model id (defaults to the configured default).

If a generation **fails or times out** at the service, it's dropped server-side (the player surfaces an error rather than a finished track); mantle gives up on a stuck task after a timeout (~12 minutes by default). You won't get a chat-turn error for this either — it's the player that reflects it.

### A generation survives a mantle restart

In-flight generations are persisted, so if mantle restarts mid-render it **resumes polling** the task rather than losing it. You don't have to do anything; this is just why a track can still appear after a restart you didn't expect.

---

## Where tracks live, and how the player organizes them

Storage is one tree under the runtime state dir: **`.mantle/music/<agentId>/`** — a per-agent **bucket**. Below the bucket, the user can freely make **nested folders** and move tracks around (the player has create/rename/delete-folder and move-track controls). The bucket id is how the player groups music by agent.

Each generated track carries small **sidecar files** beside its `.mp3`, which is what makes the read tools and the player's prompt panel work:

- a **`.meta.json`** — the generation record: the style prompt, model, instrumental/vocal, lineage, Suno's tags/duration. This is what `get_music_track` reads. An **uploaded** track (or one made before prompts were saved) has no `.meta.json`, so its recipe simply isn't recoverable — the tools say "no prompt on file" rather than failing.
- a **`.lyrics.json`** — a karaoke transcript, present only if someone transcribed the track via the player's CC button (Whisper). This is what `get_music_lyrics` reads.
- a **`.cover.jpg`** — album art, when Suno returned any.

These sidecars travel with the track on rename/move and are dropped on delete, so a track's prompt, lyrics, and art stay attached. They're invisible in listings (only `.mp3`s show up as tracks).

### The player UI

The music player is a UI surface that reads `.mantle/music/`. From it the **user** can: play tracks (seekable), browse and organize folders, rename/move/delete tracks, **upload** their own `.mp3` straight into a bucket, **transcribe** a track to karaoke lyrics (the **CC** button — runs Whisper in the voice sidecar), and open the prompt panel to see the style a track was generated from. The player also has its own **Generate** form — that's the human's generation path, and unlike your tool it can make **vocal** tracks (lyrics). Your job with the player is usually to *point the user at it* and interpret what they see, not to drive these controls yourself.

---

## Seeing the current state

Before answering "what music do I have" or "can you make me a track," read the state:

- **What's in the library** → `list_music` (optionally filtered to an agent or a title substring). It's the fastest read of the whole shared library.
- **One track's recipe** → `get_music_track` by title (narrow with `agentId` if the same title exists under more than one agent).
- **Can I even generate?** → If you have the `generate_music` tool at all, generation is configured. If you don't, it isn't — generation needs music enabled **and** a key present. The player's tray also reports whether generation is available.
- **Is something rendering right now?** → The player shows in-flight generations as placeholders; there's no agent-facing "list pending" tool. If a user says "where's my track," it's either still rendering (watch the player), or it failed/timed out (the player shows an error).

You don't need to transcribe exact route names or response fields — describe *what to look at*; the live player and the read tools are the source of truth.

---

## Gotchas and failure modes

- **Generation needs a key AND the master switch on.** Both. With music enabled but **no key**, the library/player works fully but `generate_music` isn't registered (and the player's Generate refuses). With music disabled entirely, the whole room — tools and all — goes dark. The key comes from `KIE_API_KEY` (which overrides config) or the music config's `apiKey`. A newly-added key needs a **restart** to take effect.
- **Don't re-call to "check status."** `generate_music` is fire-and-forget. Calling it again does **not** poll — it starts a *second* generation (and bills again). The first call's reminder to not re-call is load-bearing; respect it.
- **Completion is silent.** No notification turn fires when a track lands. If the user is waiting, tell them to watch the player; don't promise you'll "let them know when it's done" — you won't be invoked.
- **Your tool can't make vocals.** `generate_music` is instrumental-only by design. Vocal tracks are the user's path through the player's Generate form. Don't claim you can sing lyrics into a generation.
- **No prompt on an old/uploaded track.** `get_music_track` can only return a style prompt if the track has a `.meta.json` sidecar. Uploaded tracks and ones made before prompt-saving have none — the recipe is genuinely unrecoverable, not hidden.
- **Lyrics are approximate and optional.** `get_music_lyrics` only works on tracks someone transcribed via the CC button, and the transcript is machine-heard over instrumentation — treat it as a best-effort reading, not the canonical lyrics. Instrumental and untranscribed tracks have none.
- **Transcription needs the voice sidecar.** The player's CC (karaoke) button runs Whisper inside the voice sidecar — so transcription requires voice to be enabled and the sidecar alive. That's a voice-subsystem dependency, not a music one; if it fails, check voice (see `feature/voice.md`).
- **Two takes per generation.** Expect *two* tracks from one call, not one. If a user is surprised by a duplicate-ish pair, that's why.
- **Title collisions.** If two tracks share a title (e.g. the same agent generated similar names, or across agents), `get_music_track` / `get_music_lyrics` ask you to disambiguate with `agentId`. The library is shared, so titles aren't globally unique.

---

## What needs the user's confirmation

- **Generating a track (`generate_music`)** — this calls a **paid external service** (kie.ai / Suno). Each call costs money and produces two variations. Don't fire it speculatively or in a loop. Confirm the user actually wants a track before generating, and never re-call it to "check on" a render (which double-bills). This is the one music action that spends real money — treat it like any other metered, irreversible spend.

Routine, no-confirm-needed: all three **read** tools (`list_music`, `get_music_track`, `get_music_lyrics`) are free, read-only inspection of what's already on disk — browse and study freely. Playing, organizing, and uploading in the player are the user's own free actions.

---

## Related docs

- `docs/agent-manual/MANTLE.md` — the always-loaded operating manual (points here).
- The `suno-generate` **skill** (not a manual page) — the craft of writing a strong Suno style prompt and shaping your music taste. Read it when you actually go to generate; this page is the subsystem mechanics, that skill is the *what to write*.
- `docs/agent-manual/feature/voice.md` — voice; relevant because the player's karaoke transcription rides the voice sidecar's Whisper.
