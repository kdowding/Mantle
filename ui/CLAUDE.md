# Mantle UI — Svelte 5

The frontend: **Svelte 5 (runes) + Vite, standalone — NOT SvelteKit** (no SSR, no file routing, no `$app/*`). Single-user, local, streaming-first.

> Map, not contract — verify against the source, and fix this doc when it drifts.

## Build / serve / verify

| Command (repo root) | What it does |
|---|---|
| `bun run ui:dev` | Vite dev server on **:5174** with HMR; proxies `/api` + `/ws` → Bun backend `:3333`. The iteration loop. |
| `bun run ui:build` | `vite build ui` → **`ui/dist/`** (gitignored). This is what the Bun server serves at `:3333` — rebuild before judging the served app. |
| `bun run check:svelte` | `svelte-check` — type + template errors. **Keep 0 errors / 0 warnings.** Treat its output like `tsc`'s. |
| `bun run lint` | oxlint covers this tree too (vendored `src/lib/smd.js` is ignore-listed). |

Live verify: `MANTLE_AUTH_DISABLED=1 bun run dev` (backend) + `bun run ui:dev`, drive `:5174` with Playwright — HMR picks up edits instantly. To verify the production path (the served app), `ui:build` + restart mantle + drive `:3333`.

## Structure — three tiers (same philosophy as the backend: light core, bolt-on rooms)

```
index.html        — minimal shell; loads src/main.ts
vite.config.ts    — svelte plugin + dev proxy + build outDir
public/           — static assets copied verbatim into dist/ root (emoji-data.json,
                    realtime-worklet.js — both fetched root-relative at runtime)
src/
  main.ts         — mount(App)
  App.svelte      — top-level layout: composes views/, mounts room hosts
  app.css         — global theme tokens + base (the cyberpunk design language); form.css — shared form styles
  lib/            — CORE RUNTIME, zero components. state.svelte.ts (the runes store — the old
                    globals made explicit), ws.ts (socket + chat-turn pipeline + the
                    onWsEvent/sendWs seam rooms hang off), api.ts (typed REST), stream.ts
                    (the streaming island: vendored smd parser + reveal clock), sessions.ts,
                    transcript.ts, inference.ts, attachments.ts, theme.ts (per-agent accent
                    cascade), auth.svelte.ts, reasoning.ts, viewers.ts, commands.ts, crt.ts,
                    cipher.ts, format.ts, storage.ts, unread.ts, quotes/personas.svelte.ts, agents.ts
  components/     — SHARED kit: Button, Toggle, Modal, Popover, ConfirmHost/confirm,
                    CommandPalette, StreamingText (the island's component host),
                    MessageShell (the transmission-block bubble chrome — head/rail/
                    animations; views/Message + rooms/channel both render on it),
                    ToolCall(s), ThinkingBlock, Attachments, Lightbox, DocViewer/TextViewer,
                    emoji/, AgentCard, ProviderModelSelect, TuneSlider. Rule: props/callbacks
                    in, no knowledge of "the current chat".
  views/          — THE CORE SURFACE App.svelte composes: Chat, Message, MessageInput,
                    Sessions, ProfileBar, BackendPicker, ContextBar, AuthGate, BootScreen,
                    EmptyState, SystemsDeck (the full-page subsystem manager — a stage view
                    like the channel; tabs render room-owned *Deck components).
                    Views may wire lib/ state directly. Nothing else lands here.
  rooms/<name>/   — BOLT-ON features, one dir each: activity (toasts), agents, call, channel,
                    codex, cron, local, music, settings, skills, tools, voice, workspace.
                    A room owns
                    its components AND its state (<name>.svelte.ts — room state does NOT go
                    in lib/state.svelte.ts); rooms reach the socket only via ws.ts's
                    onWsEvent/sendWs seam, never core dispatch.
dist/             — vite build output (gitignored; what Bun serves)
```

**Promotion rule** (settles every "where does this go?"): a component starts in its room; the moment a *second* consumer wants it, it moves to `components/` and both consume it. Room-unique chrome (music transport, call visualizer) never promotes. When a room ports onto a shared component and renders subtly differently, fix the room against the kit — don't fork the kit.

## House conventions — Svelte 5 ONLY (the anti-drift anchor; the compiler enforces most of it)

- **Runes only**: `$state` / `$derived` / `$effect` / `$props` / `$bindable`. Shared reactive state lives in `.svelte.ts` modules.
- **NO Svelte 4 patterns**: ❌ `export let` → ✅ `let { foo } = $props()` · ❌ `$:` → ✅ `$derived`/`$effect` · ❌ `on:click` → ✅ `onclick` · ❌ `createEventDispatcher` → ✅ callback props · ❌ stores for app state → ✅ `$state` modules.
- **Effects sparingly** — `$derived` for computed values; `$effect` only for true side effects (DOM, subscriptions, WS), returning a cleanup.
- **Props are LIVE — capture before close.** A handler whose async work outlives a modal `close()` must capture (`const id = agentId`) up front, or it silently reads the nulled prop afterward. Init-only capture is stated explicitly: `untrack(() => prop)` + a keyed remount.
- **The streaming island is manual DOM.** `components/StreamingText.svelte` owns its node via `bind:this`; `lib/stream.ts` writes into it imperatively (smd append-only parser + reveal clock). Svelte must NOT manage that node's children, and don't revert to typewriter/tail-rerender approaches. A turn interleaves text/tool runs: the bubble (`views/Message.svelte`) is reactive, each text run is an island.
- **Transitions are LOCAL by default** — a transition inside a room-mounted modal needs `|global` to fire when the host mounts/unmounts it.
- **Svelte 5 scopes styles via `:where()`** — zero added specificity, so a generic global rule can beat a scoped one; be explicit when fighting a global (e.g. `.stage > .stage-sweep`).
- **Reduced-motion-gate** all decorative animation (boot screen, sweeps, ciphers, glitches already are).
- Scoped `<style>` per component; global tokens stay in `app.css`. Events are callback props, not dispatched.

## Gotchas

- **Two serve modes, one origin assumption.** WS + fetches are location-relative — they work under Vite (proxied) and Bun (same-origin) alike; don't hardcode hosts/ports.
- **The Bun server serves `ui/dist`, not `ui/src`** — a stale dist is the classic "my change didn't take" trap; rebuild or use `ui:dev`. Boot warns if dist is missing entirely.
- `public/` assets must land in `dist/` root (`/emoji-data.json` for the picker, `/realtime-worklet.js` for calls) — a missing one fails only at runtime, not at build.
- `src/lib/smd.js` is **vendored** (MIT, thetarnav) with hand-written `smd.d.ts` — not type-checked, lint-ignored; don't reformat or "fix" it casually.
- Mic capture / VAD / calls need a secure context — off-localhost requires the TLS setup (root CLAUDE.md, Auth section).
