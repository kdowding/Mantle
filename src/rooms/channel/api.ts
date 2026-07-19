// ── /api/channels/* — the channel (multi-agent group-chat) REST surface ──────
// Backs the channel sidebar + view: create/list/get a channel, read its
// author-tagged transcript for replay, and patch its participant roster
// ("call in" / dismiss). Storage is owned by ChannelStore — this layer is a
// thin HTTP front over it, mirroring api-cron.ts / api-music.ts. Fully
// self-contained so the feature rips out with the file.
//
//   POST   /api/channels                  body {title, participants?} -> ChannelMeta
//   GET    /api/channels                  -> ChannelMeta[]
//   GET    /api/channels/:id              -> ChannelMeta
//   GET    /api/channels/:id/messages     -> ChannelMessage[] (author-tagged, replay)
//   PATCH  /api/channels/:id/participants  body {add?, remove?} -> ChannelMeta
//   PATCH  /api/channels/:id/auto-respond  body {agentId, on?} -> ChannelMeta (toggle live mic)
//   PATCH  /api/channels/:id/volley        body {enabled?, maxTurns?, style?} -> ChannelMeta
//   PATCH  /api/channels/:id/model-override body {agentId, provider?, model?} -> ChannelMeta
//   PATCH  /api/channels/:id              body {title?, memoryPack?} -> ChannelMeta (rename / toggles)
//   DELETE /api/channels/:id              -> {ok:true, id} (drops index entry + transcript dir)

import type { MantleConfig } from "../../config/schema.js";
import { getAgent } from "../../config/loader.js";
import { ChannelStore } from "./channel-store.js";
import { abortChannelTurn } from "./bridge.js";
import { REACTION_USER, type ChannelVolley } from "./types.js";

export async function handleChannelApi(
  req: Request,
  url: URL,
  config: MantleConfig,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const store = new ChannelStore(config.basePath);

  // POST /api/channels — create a channel.
  if (path === "/api/channels" && method === "POST") {
    let body: { title?: string; participants?: string[] } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      /* empty/malformed body → defaults below */
    }
    const title = body.title?.trim() || "New channel";
    // Drop any requested participant that isn't a known agent so a channel
    // can't be created referencing a deleted/typo'd id.
    const participants = Array.isArray(body.participants)
      ? body.participants.filter((id) => !!getAgent(config, id))
      : [];
    const meta = store.create({ title, participants });
    return json(meta);
  }

  // GET /api/channels — list, newest-active first (ChannelStore.list sorts).
  if (path === "/api/channels" && method === "GET") {
    return json(store.list());
  }

  // GET /api/channels/:id/messages — author-tagged transcript for replay.
  // Optional pagination so a long-lived channel doesn't ship its entire
  // history on every open: `?after=<messageId>` returns only rows after
  // that id (incremental refresh), `?limit=N` caps to the most recent N.
  // Bare call (today's UI) still returns everything.
  const messagesMatch = path.match(/^\/api\/channels\/([\w-]+)\/messages$/);
  if (messagesMatch && method === "GET") {
    const id = messagesMatch[1];
    if (!store.get(id)) return json({ error: `Unknown channel: ${id}` }, 404);
    let rows = store.readMessages(id);
    const after = url.searchParams.get("after");
    if (after) {
      const idx = rows.findIndex((r) => r.id === after);
      // Unknown cursor → full list (client state is stale; let it resync).
      if (idx !== -1) rows = rows.slice(idx + 1);
    }
    const limitRaw = url.searchParams.get("limit");
    if (limitRaw) {
      const limit = parseInt(limitRaw, 10);
      if (Number.isFinite(limit) && limit > 0) rows = rows.slice(-limit);
    }
    return json(rows);
  }

  // PATCH /api/channels/:id/messages/:msgId/reactions — toggle the USER's emoji
  // reaction on one message. {emoji, on?}; on defaults to true. Agent reactions
  // come through the channel_react pseudo-tool, not this route.
  const reactMatch = path.match(/^\/api\/channels\/([\w-]+)\/messages\/([\w-]+)\/reactions$/);
  if (reactMatch && method === "PATCH") {
    const id = reactMatch[1];
    const msgId = reactMatch[2];
    if (!store.get(id)) return json({ error: `Unknown channel: ${id}` }, 404);
    let body: { emoji?: string; on?: boolean } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.emoji || !body.emoji.trim()) return json({ error: "emoji is required" }, 400);
    const result = store.setReaction(id, msgId, body.emoji, REACTION_USER, body.on !== false);
    if (!result) return json({ error: `Unknown message: ${msgId}` }, 404);
    return json(result);
  }

  // PATCH /api/channels/:id/participants — call in (add) / dismiss (remove).
  const participantsMatch = path.match(/^\/api\/channels\/([\w-]+)\/participants$/);
  if (participantsMatch && method === "PATCH") {
    const id = participantsMatch[1];
    if (!store.get(id)) return json({ error: `Unknown channel: ${id}` }, 404);

    let body: { add?: string[]; remove?: string[] } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    // Add first (only known agents), then remove — so a request that both
    // adds and removes the same id ends with it removed (idempotent intent).
    let meta = store.get(id);
    for (const agentId of body.add ?? []) {
      if (!getAgent(config, agentId)) continue;
      meta = store.invite(id, agentId) ?? meta;
    }
    for (const agentId of body.remove ?? []) {
      meta = store.dismiss(id, agentId) ?? meta;
    }
    return json(meta);
  }

  // PATCH /api/channels/:id/auto-respond — toggle an agent's "live mic"
  // (auto-respond) state. {agentId, on?}; `on` defaults to true. The store
  // no-ops a non-participant, so this can't make a stranger auto-reply.
  const autoMatch = path.match(/^\/api\/channels\/([\w-]+)\/auto-respond$/);
  if (autoMatch && method === "PATCH") {
    const id = autoMatch[1];
    if (!store.get(id)) return json({ error: `Unknown channel: ${id}` }, 404);
    let body: { agentId?: string; on?: boolean } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.agentId) return json({ error: "agentId is required" }, 400);
    const meta = store.setAutoRespond(id, body.agentId, body.on !== false);
    return json(meta);
  }

  // PATCH /api/channels/:id/model-override — set/clear an agent's sticky
  // provider/model override for this channel (mirrors the 1:1 profile-bar
  // picker; fed into resolveProviderTurn per sub-turn). {agentId, provider?,
  // model?}; both empty = revert to the agent's own defaults.
  const overrideMatch = path.match(/^\/api\/channels\/([\w-]+)\/model-override$/);
  if (overrideMatch && method === "PATCH") {
    const id = overrideMatch[1];
    if (!store.get(id)) return json({ error: `Unknown channel: ${id}` }, 404);
    let body: { agentId?: string; provider?: string; model?: string } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.agentId) return json({ error: "agentId is required" }, 400);
    const provider = typeof body.provider === "string" && body.provider.trim() ? body.provider.trim() : undefined;
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : undefined;
    const meta = store.setModelOverride(id, body.agentId, { provider, model });
    return json(meta);
  }

  // PATCH /api/channels/:id/volley — update the volley (riff) config. Partial
  // merge; the store clamps maxTurns to [1, VOLLEY_CAP] and we validate style.
  const volleyMatch = path.match(/^\/api\/channels\/([\w-]+)\/volley$/);
  if (volleyMatch && method === "PATCH") {
    const id = volleyMatch[1];
    if (!store.get(id)) return json({ error: `Unknown channel: ${id}` }, 404);
    let body: { enabled?: boolean; maxTurns?: number; style?: string } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const patch: Partial<ChannelVolley> = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.maxTurns === "number") patch.maxTurns = body.maxTurns;
    if (body.style === "free" || body.style === "round-robin") patch.style = body.style;
    const meta = store.updateVolley(id, patch);
    return json(meta);
  }

  // GET /api/channels/:id — single channel meta. Checked AFTER the longer
  // tails above so /messages and /participants don't fall through here.
  const idMatch = path.match(/^\/api\/channels\/([\w-]+)$/);
  if (idMatch && method === "GET") {
    const meta = store.get(idMatch[1]);
    if (!meta) return json({ error: `Unknown channel: ${idMatch[1]}` }, 404);
    return json(meta);
  }

  // PATCH /api/channels/:id — channel meta knobs: rename + the per-channel
  // memory-pack toggle. Partial; absent fields keep their current value.
  if (idMatch && method === "PATCH") {
    const id = idMatch[1];
    if (!store.get(id)) return json({ error: `Unknown channel: ${id}` }, 404);
    let body: { title?: string; memoryPack?: boolean } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 120) : undefined;
    const meta = store.update(id, (m) => {
      if (title) m.title = title;
      if (typeof body.memoryPack === "boolean") m.memoryPack = body.memoryPack;
    });
    return json(meta);
  }

  // DELETE /api/channels/:id — fully remove the channel (index entry +
  // transcript dir/JSONL). Abort any in-flight volley FIRST so a running
  // speaker stops streaming/writing into the dir we're about to rm (the
  // bridge's abort path re-checks existence before persisting partials).
  if (idMatch && method === "DELETE") {
    const id = idMatch[1];
    if (!store.get(id)) return json({ error: `Unknown channel: ${id}` }, 404);
    abortChannelTurn(id);
    store.delete(id);
    return json({ ok: true, id });
  }

  return json({ error: "Not found" }, 404);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
