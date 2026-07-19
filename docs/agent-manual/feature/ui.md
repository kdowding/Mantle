# The web UI — where everything is

A map of mantle's web interface, so you can tell the user *exactly* where to click. When they ask "how do I set X" and X lives in the UI, name the control and its location. Locations here are coarse and stable ("Settings → Connections," not pixel positions) — they stay true as the UI evolves.

## The four regions

- **Sidebar (left).** Agents, sessions, subsystem panels, footer buttons.
- **Profile bar (top of the chat).** Per-conversation controls: inference, voice, persona, call.
- **Main stage (center).** The chat transcript — or the channel view, or a live call overlay, when active.
- **Modals & the systems deck.** Settings and per-agent editors open as modals; deeper subsystem management opens as a full-page "systems deck."

## Sidebar (left)

Top to bottom:
- **Mode tabs** — `◇ chat` (1:1) and `⌗ channels` (multi-agent rooms).
- **// agents** — the roster. **`+`** creates an agent; an **agent card** selects it on click; the **`✎` pencil** (revealed on hover) opens that agent's edit modal.
- **// systems** (when an agent is selected) — a collapsible accordion with quick panels for **tools, skills, cron**. Clicking a panel header drills into the full systems deck.
- **// sessions** — conversation history (search; `+` for a new session; right-click a row to rename/delete/pin).
- **Footer** — **`⚙` settings**, **`⊟` local models** (the llama.cpp / HuggingFace browser), and sign-out (if auth is on).

## Profile bar (top of the chat)

Per-conversation controls (they don't persist unless noted):
- **Persona chip** `◈` — switch the agent's active persona/mask.
- **inference panel:**
  - **Backend picker** — the `vendor · model` cascade; pick a backend, then a model.
  - **Toggles** — `◆ effort` (thinking depth), `◉ reasoning` (show thinking in the transcript), `⊙ memory` (inject the Englyph pack).
  - **`▤ files`** — opens the **Workspace Files** editor (see Modals).
- **voice panel:**
  - **`♬` Chatterbox** and **`✧` xAI** — the two TTS-out toggles (independent; this is *voice*, not *call*).
  - **Voice / xAI-voice pickers** — the reference clip (Chatterbox) or the xAI voice.
  - **`⚙` gear** — opens the Voice Tuning modal.
- **`✆ call`** — starts a realtime voice **call** (the stripped CALL.md slice; see `feature/call.md`).

## Settings modal (the `⚙` footer button)

Three tabs:
- **General** — chat-effects toggle; the agents list (click a row to edit) + "New Agent."
- **Providers** — API keys per vendor (Anthropic / OpenAI / xAI / local) + auth status. *This is where provider keys are set.*
- **Connections** — a live "is my setup working" view: a status row per subsystem (**inference / memory · Englyph / voice / local**) — the same data your `mantle_status` reads. Send users here to *see* health.

## Systems deck (full-page, from `// systems`)

A tabbed page — **skills · tools · cron** — for managing each subsystem, with a **`✦ assist`** button that opens a chat dock where the agent helps stage changes, and `×` to return to chat.

## Modals & editors

- **Agent edit** (`✎` on a card) — name, accent color, avatar, default provider/model, Englyph path (shared/isolated), and the **auto-approve** checkboxes (the per-action trust dial for the deck assist).
- **Create agent** (`+` in // agents) — name, owner, optional id/tagline/accent, provider/model, Englyph mode.
- **Voice Tuning** (`⚙` in the voice panel) — three sliders (**temperature / CFG weight / exaggeration**), a preview-with-sample-text button, save/reset. Preview doesn't persist; Save writes the agent's overrides.
- **Workspace Files** (`▤ files` in the inference panel) — edits the agent's **prompt-source files (AGENTS / IDENTITY / SOUL / USER)** with per-`##`-section toggles and a live assembled-prompt preview. *This is where the persona/identity files are edited today.*

## Rooms

- **Channels** (`⌗ channels` mode tab) — a second sidebar lists channels (`+` to create); selecting one shows its **roster** (add/dismiss agents, per-agent backend) and **conduct** (volley, max-turns, style); the stage becomes the group transcript.
- **Music** — a vertical **"Music" spine** on the right edge of the chat; click to expand the panel (now-playing, generate, library, lyrics).
- **Call** — `✆ call` swaps the stage for a realtime call overlay (waveform, transcript, mic/speaker).
- **Local models** (`⊟` footer) — the local-runtime / HuggingFace model browser.

## Common click-paths

| The user wants to… | Send them to |
|---|---|
| Create / edit / delete an agent | Sidebar **// agents** `+` / card `✎` (Delete is inside the edit modal) |
| Set a provider API key | `⚙` Settings → **Providers** |
| Check if the setup is working | `⚙` Settings → **Connections** |
| Change backend or model | Profile bar → **inference** → backend picker |
| Edit persona/identity files | Profile bar → **inference** → `▤ files` |
| Turn on / tune the spoken voice (TTS) | Profile bar → **voice** → `♬`/`✧` toggles, `⚙` to tune |
| Start a live call | Profile bar → `✆ call` |
| Set up a cron / skill | Sidebar **// systems** → the panel → the deck |
| Make or join a channel | Sidebar `⌗ channels` → `+` |
| Browse / pull a local model | Sidebar footer `⊟` |

---

This map is coarse by design — section-level, not pixel-level — so it stays accurate as the UI moves. When precise, build-checked targeting arrives (a future "highlight this element" feature), the exact element ids will live alongside these locations.
