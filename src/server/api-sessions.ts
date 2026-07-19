// Session-scoped REST surface, split out of api.ts: sessions CRUD +
// mode-locking creation, the cross-agent GET the UI loads transcripts by,
// per-session persona, manual compaction, uploads in, and upload serving
// out. handleApi delegates here for every matching path; null = not ours.

import { resolve, relative, isAbsolute } from "path";
import { existsSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import { getAgent } from "../config/loader.js";
import { SessionManager, mutateSessionIndex } from "../agent/session.js";
import { resolveProviderTurn } from "../agent/providers/catalog.js";
import type { LocalModelManager } from "../local/manager.js";
import { compactIfNeeded } from "../agent/compaction.js";
import { isSessionActive } from "./ws.js";
import { handleUpload, getFilePath, getFileMetadata, buildContentDisposition } from "../agent/attachments.js";
import { json, readJsonBody } from "./api-helpers.js";

export async function handleSessionsApi(
  req: Request,
  url: URL,
  config: MantleConfig,
  localModelManager?: LocalModelManager,
): Promise<Response | null> {
  const baseMantleDir = resolve(config.basePath, ".mantle");
  const path = url.pathname;
  const method = req.method;

  // GET /api/agents/:agentId/sessions
  const agentSessionsMatch = path.match(/^\/api\/agents\/([\w-]+)\/sessions$/);
  if (agentSessionsMatch && method === "GET") {
    const agentId = agentSessionsMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const sessionsDir = resolve(baseMantleDir, "sessions", agentId);
    const index = SessionManager.loadIndex(sessionsDir);
    index.sessions.sort((a, b) =>
      new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    );
    return json(index);
  }

  // POST /api/agents/:agentId/sessions
  if (agentSessionsMatch && method === "POST") {
    const agentId = agentSessionsMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    // Optional body shape:
    //   { mode: "call", callVoice?: string } — xAI realtime voice
    //   { } / no body                        — default chat mode
    // Call mode is locked at session creation so the call bridge can route the
    // first turn before a transcript row exists.
    let body: {
      mode?: "chat" | "call";
      callVoice?: string;
    } = {};
    if (req.headers.get("content-type")?.includes("application/json")) {
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // Treat empty / malformed body as default mode
      }
    }

    const sessionId = crypto.randomUUID();
    const sessionsDir = resolve(baseMantleDir, "sessions", agentId);

    // If a non-default mode was requested, persist a placeholder index
    // entry so the WS / call bridge can read it on the first turn. The
    // default (in-process chat loop) needs no persistence here —
    // updateIndex creates the entry when the first message arrives.
    if (body.mode === "call") {
      // Default from config (schema default "ara") — this used to hardcode
      // "eve", silently disagreeing with realtime.defaultVoice.
      const callVoice = body.callVoice?.trim() || config.realtime.defaultVoice || "ara";
      SessionManager.createSessionMeta(sessionId, sessionsDir, {
        isCall: true,
        callVoice,
        provider: "grok",
        model: "grok-voice-latest",
        title: "Call",
      });
      return json({
        id: sessionId,
        agentId,
        mode: "call",
        callVoice,
      });
    }

    return json({
      id: sessionId,
      agentId,
    });
  }

  // GET /api/sessions/:id — find session across all agents. Intentionally
  // cross-agent: the UI loads a transcript by bare session id. The probe
  // checks for the JSONL directly instead of constructing a SessionManager
  // — the constructor mkdirs, so the old loop CREATED every agent's
  // sessions dir as a side effect of a read.
  const sessionMatch = path.match(/^\/api\/sessions\/([\w-]+)$/);
  if (sessionMatch && method === "GET") {
    const sessionId = sessionMatch[1];

    for (const agent of config.agents) {
      const sessionsDir = resolve(baseMantleDir, "sessions", agent.id);
      if (!existsSync(resolve(sessionsDir, `${sessionId}.jsonl`))) continue;
      const session = new SessionManager(sessionId, sessionsDir);
      const messages = await session.getMessages();
      if (messages.length > 0) {
        return json(messages);
      }
    }

    return json([]);
  }

  // DELETE /api/agents/:agentId/sessions/:id
  const sessionByIdMatch = path.match(/^\/api\/agents\/([\w-]+)\/sessions\/([\w-]+)$/);
  if (sessionByIdMatch && method === "DELETE") {
    const agentId = sessionByIdMatch[1];
    const sessionId = sessionByIdMatch[2];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const sessionsDir = resolve(baseMantleDir, "sessions", agentId);
    const success = SessionManager.deleteSession(sessionId, sessionsDir);
    return json({ success });
  }

  // PATCH /api/agents/:agentId/sessions/:id — user-curated meta (rename/pin)
  if (sessionByIdMatch && method === "PATCH") {
    const agentId = sessionByIdMatch[1];
    const sessionId = sessionByIdMatch[2];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    let body: { title?: unknown; pinned?: unknown } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const patch: { title?: string; pinned?: boolean } = {};
    if (typeof body.title === "string") {
      if (body.title.trim().length === 0) return json({ error: "Title cannot be empty" }, 400);
      patch.title = body.title;
    }
    if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
    if (patch.title === undefined && patch.pinned === undefined) {
      return json({ error: "Nothing to update — provide title and/or pinned" }, 400);
    }

    const sessionsDir = resolve(baseMantleDir, "sessions", agentId);
    const updated = SessionManager.updateSessionMeta(sessionId, sessionsDir, patch);
    if (!updated) return json({ error: `Unknown session: ${sessionId}` }, 404);
    return json({ session: updated });
  }

  // GET /api/agents/:agentId/sessions/:sessionId/persona
  const sessionPersonaMatch = path.match(/^\/api\/agents\/([\w-]+)\/sessions\/([\w-]+)\/persona$/);
  if (sessionPersonaMatch && method === "GET") {
    const agentId = sessionPersonaMatch[1];
    const sessionId = sessionPersonaMatch[2];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const sessionsDir = resolve(baseMantleDir, "sessions", agentId);
    const index = SessionManager.loadIndex(sessionsDir);
    const sessionMeta = index.sessions.find((s) => s.id === sessionId);
    return json({ persona: sessionMeta?.persona || null });
  }

  // PUT /api/agents/:agentId/sessions/:sessionId/persona
  if (sessionPersonaMatch && method === "PUT") {
    const agentId = sessionPersonaMatch[1];
    const sessionId = sessionPersonaMatch[2];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const body = await readJsonBody<{ persona: string | null }>(req);
    if (!body || (body.persona !== null && typeof body.persona !== "string")) {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const sessionsDir = resolve(baseMantleDir, "sessions", agentId);
    mutateSessionIndex(sessionsDir, (index) => {
      const sessionMeta = index.sessions.find((s) => s.id === sessionId);
      if (!sessionMeta) return false;
      sessionMeta.persona = body.persona || undefined;
    });

    return json({ success: true });
  }

  // POST /api/agents/:agentId/sessions/:sessionId/compact
  const compactMatch = path.match(/^\/api\/agents\/([\w-]+)\/sessions\/([\w-]+)\/compact$/);
  if (compactMatch && method === "POST") {
    const agentId = compactMatch[1];
    const sessionId = compactMatch[2];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    // Compaction rewrites the whole JSONL — racing a live turn's appends
    // would tear the transcript (two writers, one file). 409 instead.
    if (isSessionActive(agentId, sessionId)) {
      return json({ error: "Session has a turn in progress — try again when it finishes." }, 409);
    }

    const sessionsDir = resolve(baseMantleDir, "sessions", agentId);
    const session = new SessionManager(sessionId, sessionsDir);
    const beforeTokens = session.estimateTokens();

    if (beforeTokens < 1000) {
      return json({ success: false, reason: "Session too short to compact" });
    }

    const resolved = resolveProviderTurn(config, { localModelManager }, {
      agentDefaultProvider: agent.defaultProvider,
      agentDefaultModel: agent.defaultModel,
      globalDefaultProvider: config.defaultProvider,
    });
    if (!resolved.ok) {
      return json({ success: false, reason: resolved.error });
    }
    const { provider, model } = resolved;

    const compacted = await compactIfNeeded({
      session,
      provider,
      model,
      threshold: 0, // Force compaction
    });

    const afterTokens = session.estimateTokens();
    return json({ success: compacted, before: beforeTokens, after: afterTokens });
  }

  // POST /api/agents/:agentId/sessions/:sessionId/upload
  const uploadMatch = path.match(/^\/api\/agents\/([\w-]+)\/sessions\/([\w-]+)\/upload$/);
  if (uploadMatch && method === "POST") {
    const agentId = uploadMatch[1];
    const sessionId = uploadMatch[2];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    try {
      const formData = await req.formData();
      const files = await handleUpload(
        formData,
        baseMantleDir,
        agentId,
        sessionId,
        config.session.maxUploadSizeMB ?? 10,
      );
      return json({ files });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 400);
    }
  }

  // GET /api/uploads/:agentId/:sessionId/:fileId
  const serveUploadMatch = path.match(/^\/api\/uploads\/([\w-]+)\/([\w-]+)\/(.+)$/);
  if (serveUploadMatch && method === "GET") {
    const agentId = serveUploadMatch[1];
    const sessionId = serveUploadMatch[2];
    const fileId = serveUploadMatch[3];

    // fileId is the only user-controlled path segment and the route regex
    // lets it contain slashes — reject traversal before it reaches the disk.
    // ":" rejected too (NTFS alternate data streams open a different stream
    // of the same name). "_meta.json" is the session's upload manifest —
    // serving it would dump every filename + extracted text in one fetch.
    if (
      fileId.includes("/") || fileId.includes("\\") || fileId.includes("..") ||
      fileId.includes(":") || fileId === "_meta.json"
    ) {
      return json({ error: "Invalid file id" }, 400);
    }

    const filePath = getFilePath(baseMantleDir, agentId, sessionId, fileId);
    // Defense-in-depth: confirm the resolved path stays under the session's
    // upload dir even if the character check above ever misses an encoding.
    const uploadDir = resolve(baseMantleDir, "uploads", agentId, sessionId);
    const relToUploadDir = relative(uploadDir, filePath);
    if (relToUploadDir.startsWith("..") || isAbsolute(relToUploadDir)) {
      return json({ error: "Invalid file id" }, 400);
    }

    const file = Bun.file(filePath);

    if (!await file.exists()) {
      return json({ error: "File not found" }, 404);
    }

    const meta = getFileMetadata(baseMantleDir, agentId, sessionId, fileId);
    const originalName = meta?.originalName || fileId;
    const contentType = meta?.mediaType || file.type || "application/octet-stream";

    // Stored-XSS hardening. The mediaType is attacker-influenceable — for user
    // uploads it's the browser-supplied multipart type, and for agent
    // attachments (attach_url_file / attach_local_file) it's passed straight
    // through. A prompt-injected agent could plant an HTML/SVG file and emit a
    // same-origin markdown link to it; served inline, its <script> would run in
    // the authenticated mantle origin and drive the gated API. Three defenses:
    //   - nosniff: the browser honors the declared type, no content-sniffing
    //   - sandbox CSP: on direct navigation the bytes run in an opaque origin
    //     with scripts disabled, so even an inline HTML doc can't reach the API
    //     (the in-app viewer fetch()es bytes, so this header doesn't touch it)
    //   - force `attachment` for anything not on a render-safe allowlist
    //     (images except SVG, audio, video, pdf, plain text) — html/svg/xml
    //     never render inline
    const t = contentType.toLowerCase();
    const inlineSafe =
      (t.startsWith("image/") && t !== "image/svg+xml") ||
      t.startsWith("audio/") ||
      t.startsWith("video/") ||
      t === "application/pdf" ||
      t === "text/plain";
    const disposition: "inline" | "attachment" = inlineSafe ? "inline" : "attachment";

    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": buildContentDisposition(originalName, disposition),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "max-age=86400",
      },
    });
  }

  return null;
}
