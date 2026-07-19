// Local model routes (llama.cpp runtime): status + per-model settings
// CRUD + warm/unload + the `mantle pull` download queue + the in-UI
// HuggingFace model browser. Peeled out of api.ts; handleApi delegates
// here for any /api/local/* path.
//
// `mantle pull` (CLI) writes the registry; these read it live so models
// pulled while the server is up surface without a restart. After any
// registry mutation, resyncConfig() keeps the in-memory config model
// list in sync (ws/cron/heartbeat read it for provider/model lookups).

import type { MantleConfig } from "../config/schema.js";
import type { LocalModelManager } from "../local/manager.js";
import { existsSync, unlinkSync } from "fs";
import {
  loadRegistry,
  removeModel,
  resetModelOverrides,
  resolveModelFile,
  resolveModelsDir,
  updateModel,
} from "../local/registry.js";
import { hfSearch, hfRepoQuants, hfAuthor, hfModel, annotateFit } from "../local/pull.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleLocalApi(
  req: Request,
  url: URL,
  config: MantleConfig,
  localModelManager?: LocalModelManager,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  if (!localModelManager || !localModelManager.isEnabled()) {
    return json({ error: "Local models disabled (config.localModels.enabled=false)" }, 503);
  }
  const modelsDirAbs = resolveModelsDir(config.basePath, config.localModels.modelsDir);

  // Keep the in-memory config model list (used by runtime provider/model
  // lookups in ws/cron/heartbeat) in sync after a registry mutation.
  const resyncConfig = () => {
    config.providers.local.models = localModelManager.listModelIds();
    config.providers.local.defaultModel = localModelManager.getDefaultModelId() ?? "";
  };

  if (path === "/api/local/status" && method === "GET") {
    // Include the config-level setting defaults so the UI can show
    // effective/placeholder values for any knob a model hasn't overridden.
    return json({ ...localModelManager.status(), defaults: config.localModels.defaults, reservedVramBytes: config.localModels.reservedVramBytes });
  }

  if (path === "/api/local/models" && method === "GET") {
    const reg = loadRegistry(modelsDirAbs);
    const st = localModelManager.status();
    return json({
      models: reg.models,
      defaultModelId: reg.defaultModelId ?? reg.models[0]?.id ?? null,
      activeModelId: st.activeModelId,
      state: st.state,
      hasBinary: st.hasBinary,
    });
  }

  // GET /api/local/models/:id/recommended — GPU-sized spawn settings for the
  // "Set recommended" button. Measures live free VRAM + the source repo's
  // GGUF metadata; no ceiling, so context pushes to the model's trained max.
  const recMatch = path.match(/^\/api\/local\/models\/([^/]+)\/recommended$/);
  if (recMatch && method === "GET") {
    const id = decodeURIComponent(recMatch[1] ?? "");
    const rec = await localModelManager.recommendForModel(id);
    if (!rec) return json({ error: `Model not found: ${id}` }, 404);
    return json(rec);
  }

  const modelIdMatch = path.match(/^\/api\/local\/models\/([^/]+)$/);

  // PUT /api/local/models/:id — patch per-model spawn settings.
  if (modelIdMatch && method === "PUT") {
    const id = decodeURIComponent(modelIdMatch[1] ?? "");
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    // Reset-to-defaults: clear per-knob overrides (sampling + spawn + toolMode).
    if (body.reset === true) {
      const reset = resetModelOverrides(modelsDirAbs, id);
      if (!reset) return json({ error: `Model not found: ${id}` }, 404);
      resyncConfig();
      return json({
        ok: true,
        model: reset,
        reloadRequired: localModelManager.status().activeModelId === id,
      });
    }
    // Whitelist + per-key type coercion: the keys were already vetted but
    // the VALUES landed in the registry raw — a string ctxSize or NaN
    // temperature persisted and then fed llama-server spawn args.
    const patch: Record<string, unknown> = {};
    const num = (v: unknown): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const int = (v: unknown): number | undefined => {
      const n = num(v);
      return n === undefined ? undefined : Math.trunc(n);
    };
    const setIf = (k: string, v: unknown): void => {
      if (v !== undefined) patch[k] = v;
    };
    if ("name" in body && typeof body.name === "string") patch.name = body.name;
    if ("chatTemplate" in body && (typeof body.chatTemplate === "string" || body.chatTemplate === null)) {
      patch.chatTemplate = body.chatTemplate;
    }
    if ("reasoning" in body) patch.reasoning = body.reasoning === true;
    if ("toolMode" in body && ["off", "core", "all", "custom"].includes(String(body.toolMode))) {
      patch.toolMode = String(body.toolMode);
    }
    if ("supportsTools" in body) patch.supportsTools = body.supportsTools === true;
    if ("allowedTools" in body && Array.isArray(body.allowedTools)) {
      patch.allowedTools = body.allowedTools.filter((t): t is string => typeof t === "string");
    }
    if ("kvCacheType" in body && typeof body.kvCacheType === "string") patch.kvCacheType = body.kvCacheType;
    if ("flashAttn" in body) patch.flashAttn = body.flashAttn === true;
    if ("ctxSize" in body) setIf("ctxSize", int(body.ctxSize));
    if ("gpuLayers" in body) setIf("gpuLayers", int(body.gpuLayers));
    if ("threads" in body) setIf("threads", int(body.threads));
    if ("maxTokens" in body) setIf("maxTokens", int(body.maxTokens));
    if ("topK" in body) setIf("topK", int(body.topK));
    if ("temperature" in body) setIf("temperature", num(body.temperature));
    if ("topP" in body) setIf("topP", num(body.topP));
    if ("minP" in body) setIf("minP", num(body.minP));
    if ("repeatPenalty" in body) setIf("repeatPenalty", num(body.repeatPenalty));
    if (body.makeDefault === true) patch.makeDefault = true;
    const updated = updateModel(modelsDirAbs, id, patch);
    if (!updated) return json({ error: `Model not found: ${id}` }, 404);
    resyncConfig();
    // Spawn-knob edits to the live model only take effect on next load.
    return json({
      ok: true,
      model: updated,
      reloadRequired: localModelManager.status().activeModelId === id,
    });
  }

  // DELETE /api/local/models/:id[?deleteFile=true]
  if (modelIdMatch && method === "DELETE") {
    const id = decodeURIComponent(modelIdMatch[1] ?? "");
    const reg = loadRegistry(modelsDirAbs);
    const entry = reg.models.find((m) => m.id === id);
    if (!entry) return json({ error: `Model not found: ${id}` }, 404);
    if (localModelManager.status().activeModelId === id) {
      // Same busy guard load/unload have — don't yank a model that's
      // mid-stream out from under its turn.
      if (localModelManager.hasActiveGenerations()) {
        return json({ error: `"${id}" is busy serving a request — stop it before deleting.` }, 409);
      }
      await localModelManager.unload();
    }
    const removed = removeModel(modelsDirAbs, id);
    let fileDeleted = false;
    if (url.searchParams.get("deleteFile") === "true" && removed) {
      try {
        const f = resolveModelFile(modelsDirAbs, removed);
        if (existsSync(f)) {
          unlinkSync(f);
          fileDeleted = true;
        }
        // Split GGUFs: the registry stores part 1 ("-00001-of-0000N");
        // delete the sibling parts too or N-1 multi-GB shards orphan.
        const splitMatch = /-(\d{5})-of-(\d{5})\.gguf$/i.exec(f);
        if (splitMatch) {
          const total = parseInt(splitMatch[2], 10);
          for (let part = 1; part <= total; part++) {
            const sibling = f.replace(
              /-\d{5}-of-(\d{5})\.gguf$/i,
              `-${String(part).padStart(5, "0")}-of-$1.gguf`,
            );
            if (sibling !== f && existsSync(sibling)) unlinkSync(sibling);
          }
        }
      } catch {
        /* leave the weights — non-fatal */
      }
    }
    resyncConfig();
    return json({ ok: true, removed: id, fileDeleted });
  }

  // POST /api/local/load { model } — warm a model (UI calls this on
  // select so the first message isn't a cold load). Blocks until healthy.
  if (path === "/api/local/load" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { model?: string };
    const id = body.model || localModelManager.getDefaultModelId() || "";
    if (!id) return json({ error: "No model specified and no default set" }, 400);
    // Don't swap a model out from under an in-flight turn. The manager's
    // _doLoad enforces this too; checking here returns a cleaner 409 for the
    // Load button instead of a generic 502.
    const st = localModelManager.status();
    if (st.activeModelId && st.activeModelId !== id && localModelManager.hasActiveGenerations()) {
      return json(
        { error: `"${st.activeModelId}" is busy serving a request — finish or stop it before loading "${id}".` },
        409,
      );
    }
    try {
      await localModelManager.ensureModelLoaded(id);
      return json(localModelManager.status());
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // POST /api/local/unload — free VRAM, leave the runtime idle.
  if (path === "/api/local/unload" && method === "POST") {
    // Don't yank the model out from under an active stream.
    if (localModelManager.hasActiveGenerations()) {
      return json({ error: "A local turn is in progress — stop it before unloading." }, 409);
    }
    await localModelManager.unload();
    return json(localModelManager.status());
  }

  // POST /api/local/pull { spec, id?, revision?, noTools? } — start a model
  // download from HuggingFace. Fire-and-forget; the UI polls /pull/status.
  if (path === "/api/local/pull" && method === "POST") {
    const body = (await req.json().catch(() => ({}))) as {
      spec?: string;
      id?: string;
      revision?: string;
      noTools?: boolean;
      reasoning?: boolean;
      supportsTools?: boolean;
    };
    const spec = (body.spec || "").trim();
    if (!spec) {
      return json({ error: "Missing 'spec' — e.g. org/repo:Q4_K_M or a huggingface.co URL" }, 400);
    }
    const res = localModelManager.enqueuePull({
      spec,
      idOverride: body.id,
      revision: body.revision,
      noTools: body.noTools,
      reasoning: body.reasoning,
      supportsTools: body.supportsTools,
    });
    if (res.error) return json({ error: res.error }, 409);
    return json({ queued: true, jobId: res.jobId });
  }

  // GET /api/local/pull/status — the download queue (active + queued +
  // recent finished), for the UI's tray.
  if (path === "/api/local/pull/status" && method === "GET") {
    const jobs = localModelManager.getPullQueue();
    // When any pull has finished, resync the in-memory model list so the
    // selector + status reflect new models without a restart.
    if (jobs.some((j) => j.status === "done")) resyncConfig();
    // Strip internal run opts from the wire.
    return json({
      pulling: localModelManager.isPulling(),
      jobs: jobs.map((j) => ({
        id: j.id,
        spec: j.spec,
        status: j.status,
        progress: j.progress,
        modelId: j.modelId,
        error: j.error,
      })),
    });
  }

  // ── Model browser (HuggingFace) ──────────────────────────────────
  const hfToken =
    config.localModels.hfToken ||
    process.env.HF_TOKEN ||
    process.env.HUGGING_FACE_HUB_TOKEN ||
    undefined;

  // GET /api/local/hf/search?q=&author=&sort=&limit= — GGUF repos.
  // HF /api/models only supports descending sort, so there's no direction param.
  if (path === "/api/local/hf/search" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    const author = (url.searchParams.get("author") || "").trim();
    const cursor = url.searchParams.get("cursor") || undefined;
    // No query AND no author = browse mode (e.g. the landing's trending feed).
    const sortMap: Record<string, "downloads" | "likes" | "lastModified" | "trendingScore"> = {
      downloads: "downloads", likes: "likes", updated: "lastModified", trending: "trendingScore",
    };
    const sort = sortMap[url.searchParams.get("sort") || "downloads"] || "downloads";
    const limit = parseInt(url.searchParams.get("limit") || "30", 10) || 30;
    try {
      // hfSearch returns { results, nextCursor } — forwarded as-is for load-more.
      return json(
        await hfSearch(
          { query: q || undefined, author: author || undefined, sort, limit, cursor },
          hfToken,
        ),
      );
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // GET /api/local/hf/author?name= — author profile (avatar / count / name).
  if (path === "/api/local/hf/author" && method === "GET") {
    const name = (url.searchParams.get("name") || "").trim();
    if (!name) return json({ error: "missing name" }, 400);
    try {
      return json({ author: await hfAuthor(name, hfToken) });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // GET /api/local/hf/files?repo= — a repo's GGUF quants with sizes.
  if (path === "/api/local/hf/files" && method === "GET") {
    const repo = (url.searchParams.get("repo") || "").trim();
    if (!repo) return json({ error: "missing repo" }, 400);
    try {
      return json({ repo, quants: await hfRepoQuants(repo, hfToken) });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  // GET /api/local/hf/model?repo= — full detail: parsed GGUF metadata,
  // README, capabilities, and quants annotated with GPU-fit verdicts +
  // a recommended pick for the detected VRAM. Powers the detail pane.
  if (path === "/api/local/hf/model" && method === "GET") {
    const repo = (url.searchParams.get("repo") || "").trim();
    if (!repo) return json({ error: "missing repo" }, 400);
    try {
      const detail = await hfModel(repo, hfToken);
      annotateFit(detail, localModelManager.status().vramTotalBytes ?? 0);
      return json(detail);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  }

  return json({ error: "Unknown local route" }, 404);
}
