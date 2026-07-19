// Per-agent presentation/configuration surface, split out of api.ts:
// skill toggles (global + per-agent), avatar GET/POST, the profile blob the
// lobby renders, and personas. handleApi delegates here; null = not ours.

import { resolve, sep, basename, dirname, join } from "path";
import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import { getAgent, saveConfig } from "../config/loader.js";
import { discoverSkills, parseFrontmatter } from "../skills/loader.js";
import { getBackend, migrateLegacyBackendId } from "../agent/providers/catalog.js";
import type { LocalModelManager } from "../local/manager.js";
import { json, readJsonBody } from "./api-helpers.js";

export async function handleAgentSurfaceApi(
  req: Request,
  url: URL,
  config: MantleConfig,
  localModelManager?: LocalModelManager,
): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  // GET /api/agents/:agentId/skills
  const agentSkillsMatch = path.match(/^\/api\/agents\/([\w-]+)\/skills$/);
  if (agentSkillsMatch && method === "GET") {
    const agentId = agentSkillsMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const allSkills = discoverSkills(config, agent);
    const globalDisabled = new Set(config.skills?.disabled ?? []);
    const agentDisabledSet = new Set(agent.disabledSkills ?? []);
    const agentEnabledSet = new Set(agent.enabledSkills ?? []);

    const skills = allSkills.map((s) => {
      const globalEnabled = !globalDisabled.has(s.name);
      let agentOverride: string | null = null;
      if (agentDisabledSet.has(s.name)) agentOverride = "disabled";
      else if (agentEnabledSet.has(s.name)) agentOverride = "enabled";

      // Effective state: agent disable > agent enable > global disable > default enabled
      let enabled = true;
      if (agentDisabledSet.has(s.name)) enabled = false;
      else if (agentEnabledSet.has(s.name)) enabled = true;
      else if (globalDisabled.has(s.name)) enabled = false;

      const source = s.filePath.includes(agent.workspace) ? "agent" : "global";

      return {
        name: s.name,
        description: s.description,
        source,
        // The on-disk directory is the skill's stable address (frontmatter
        // name may differ) — the editor endpoints key on scope+dir.
        dir: basename(dirname(s.filePath)),
        always: s.always === true,
        enabled,
        globalEnabled,
        agentOverride,
      };
    });

    return json({ skills });
  }

  // ── Skill file CRUD (the systems-deck editor) ──────────────────────────
  // Skills are addressed by scope + DIRECTORY name (the stable on-disk
  // identity; frontmatter `name` may differ). Roots: global =
  // config.globalSkillsDir, agent = <workspace>/skills. Writes validate with
  // the same parse discovery uses, so a save can't produce an invisible
  // skill; discovery's fingerprint cache picks changes up on the next turn.
  const SKILL_DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const MAX_SKILL_BYTES = 256_000; // mirrors the loader's cap

  // Resolves the skills root for a scope, or an error Response.
  const skillsRoot = (scope: string | null, agentId: string | null): { root: string } | { err: Response } => {
    if (scope === "global") return { root: resolve(config.globalSkillsDir) };
    if (scope === "agent") {
      const agent = agentId ? getAgent(config, agentId) : undefined;
      if (!agent) return { err: json({ error: `Unknown agent: ${agentId}` }, 404) };
      return { root: resolve(agent.workspace, "skills") };
    }
    return { err: json({ error: "scope must be 'global' or 'agent'" }, 400) };
  };

  if (path === "/api/skills/file" && (method === "GET" || method === "DELETE")) {
    const scope = url.searchParams.get("scope");
    const dir = url.searchParams.get("dir") ?? "";
    const rooted = skillsRoot(scope, url.searchParams.get("agentId"));
    if ("err" in rooted) return rooted.err;
    if (!SKILL_DIR_RE.test(dir)) return json({ error: "Invalid skill directory name" }, 400);
    const skillDir = resolve(rooted.root, dir);
    if (!skillDir.startsWith(rooted.root + sep)) return json({ error: "Invalid path" }, 400);

    if (method === "GET") {
      const file = join(skillDir, "SKILL.md");
      if (!existsSync(file)) return json({ error: "Skill not found" }, 404);
      return json({ scope, dir, content: readFileSync(file, "utf-8") });
    }
    // DELETE — removes the whole skill directory (assets included).
    if (!existsSync(skillDir)) return json({ error: "Skill not found" }, 404);
    rmSync(skillDir, { recursive: true, force: true });
    return json({ success: true });
  }

  if (path === "/api/skills/file" && method === "PUT") {
    const body = await readJsonBody<{ scope?: string; dir?: string; agentId?: string; content?: string }>(req);
    if (!body || typeof body.content !== "string") return json({ error: "Invalid JSON body" }, 400);
    const rooted = skillsRoot(body.scope ?? null, body.agentId ?? null);
    if ("err" in rooted) return rooted.err;
    const dir = body.dir ?? "";
    if (!SKILL_DIR_RE.test(dir)) {
      return json({ error: "Skill directory must be alphanumeric with - or _ (no spaces or dots)" }, 400);
    }
    const skillDir = resolve(rooted.root, dir);
    if (!skillDir.startsWith(rooted.root + sep)) return json({ error: "Invalid path" }, 400);
    if (Buffer.byteLength(body.content, "utf-8") > MAX_SKILL_BYTES) {
      return json({ error: `SKILL.md exceeds ${MAX_SKILL_BYTES / 1000}KB — discovery would skip it` }, 400);
    }
    // Refuse writes discovery would silently drop.
    const { frontmatter } = parseFrontmatter(body.content);
    if (!frontmatter.description) {
      return json({ error: "Frontmatter needs a `description:` — without one the skill is invisible to discovery" }, 400);
    }
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), body.content, "utf-8");
    return json({ success: true, scope: body.scope, dir, name: frontmatter.name ?? dir });
  }

  // PUT /api/skills/:skillName/toggle
  const globalSkillToggle = path.match(/^\/api\/skills\/([\w-]+)\/toggle$/);
  if (globalSkillToggle && method === "PUT") {
    const skillName = globalSkillToggle[1];
    const body = await readJsonBody<{ enabled: boolean }>(req);
    if (!body || typeof body.enabled !== "boolean") return json({ error: "Invalid JSON body" }, 400);

    // Update in-memory config
    if (!config.skills) config.skills = { disabled: [] };
    const idx = config.skills.disabled.indexOf(skillName);
    if (body.enabled && idx !== -1) {
      config.skills.disabled.splice(idx, 1);
    } else if (!body.enabled && idx === -1) {
      config.skills.disabled.push(skillName);
    }

    // Persist
    saveConfig(config.basePath, (raw) => {
      if (!raw.skills) raw.skills = { disabled: [] };
      if (!raw.skills.disabled) raw.skills.disabled = [];
      if (body.enabled) {
        raw.skills.disabled = raw.skills.disabled.filter((n: string) => n !== skillName);
      } else if (!raw.skills.disabled.includes(skillName)) {
        raw.skills.disabled.push(skillName);
      }
    });

    return json({ success: true });
  }

  // PUT /api/agents/:agentId/skills/:skillName/toggle
  const agentSkillToggle = path.match(/^\/api\/agents\/([\w-]+)\/skills\/([\w-]+)\/toggle$/);
  if (agentSkillToggle && method === "PUT") {
    const agentId = agentSkillToggle[1];
    const skillName = agentSkillToggle[2];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const body = await readJsonBody<{ state: "inherit" | "enabled" | "disabled" }>(req);
    if (!body || !["inherit", "enabled", "disabled"].includes(body.state)) {
      return json({ error: "Invalid JSON body" }, 400);
    }

    // Update in-memory config
    if (!agent.disabledSkills) agent.disabledSkills = [];
    if (!agent.enabledSkills) agent.enabledSkills = [];
    agent.disabledSkills = agent.disabledSkills.filter((n) => n !== skillName);
    agent.enabledSkills = agent.enabledSkills.filter((n) => n !== skillName);

    if (body.state === "disabled") {
      agent.disabledSkills.push(skillName);
    } else if (body.state === "enabled") {
      agent.enabledSkills.push(skillName);
    }

    // Persist
    saveConfig(config.basePath, (raw) => {
      if (!raw.agents) return;
      const rawAgent = raw.agents.find((a: any) => a.id === agentId);
      if (!rawAgent) return;

      if (!rawAgent.disabledSkills) rawAgent.disabledSkills = [];
      if (!rawAgent.enabledSkills) rawAgent.enabledSkills = [];
      rawAgent.disabledSkills = rawAgent.disabledSkills.filter((n: string) => n !== skillName);
      rawAgent.enabledSkills = rawAgent.enabledSkills.filter((n: string) => n !== skillName);

      if (body.state === "disabled") {
        rawAgent.disabledSkills.push(skillName);
      } else if (body.state === "enabled") {
        rawAgent.enabledSkills.push(skillName);
      }

      // Clean up empty arrays
      if (rawAgent.disabledSkills.length === 0) delete rawAgent.disabledSkills;
      if (rawAgent.enabledSkills.length === 0) delete rawAgent.enabledSkills;
    });

    return json({ success: true });
  }

  // PUT /api/agents/:agentId/tools/disable  — body { names: string[], disabled: boolean }
  // Batch (so a whole group toggles atomically). Sets/clears the per-agent
  // capability gate enforced at the front door (triggered-turn.ts). Binary —
  // there's no global tool list to inherit from, so no tri-state like skills.
  const agentToolDisable = path.match(/^\/api\/agents\/([\w-]+)\/tools\/disable$/);
  if (agentToolDisable && method === "PUT") {
    const agentId = agentToolDisable[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const body = await readJsonBody<{ names: string[]; disabled: boolean }>(req);
    if (!body || !Array.isArray(body.names) || typeof body.disabled !== "boolean") {
      return json({ error: "Invalid JSON body — expected { names: string[], disabled: boolean }" }, 400);
    }
    const names = body.names.filter((n): n is string => typeof n === "string" && n.length > 0);

    const apply = (list: string[] | undefined): string[] | undefined => {
      const set = new Set(list ?? []);
      for (const n of names) {
        if (body.disabled) set.add(n);
        else set.delete(n);
      }
      return set.size > 0 ? [...set] : undefined;
    };

    // In-memory
    agent.disabledTools = apply(agent.disabledTools);
    if (!agent.disabledTools) delete agent.disabledTools;

    // Persist
    saveConfig(config.basePath, (raw) => {
      if (!raw.agents) return;
      const rawAgent = raw.agents.find((a: any) => a.id === agentId);
      if (!rawAgent) return;
      const next = apply(rawAgent.disabledTools);
      if (next) rawAgent.disabledTools = next;
      else delete rawAgent.disabledTools;
    });

    return json({ success: true, disabledTools: agent.disabledTools ?? [] });
  }

  // GET/PUT /api/agents/:agentId/assist/auto-approve — the deck-assist trust
  // dial (per-agent × per-action). GET returns the key set; PUT { key, allowed }
  // adds/removes one. Same shape as the tools-disable gate.
  const assistAuto = path.match(/^\/api\/agents\/([\w-]+)\/assist\/auto-approve$/);
  if (assistAuto && (method === "GET" || method === "PUT")) {
    const agentId = assistAuto[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    if (method === "GET") return json({ autoApprove: agent.assist?.autoApprove ?? [] });

    const body = await readJsonBody<{ key: string; allowed: boolean }>(req);
    if (!body || typeof body.key !== "string" || typeof body.allowed !== "boolean") {
      return json({ error: "Invalid JSON body — expected { key: string, allowed: boolean }" }, 400);
    }
    const key = body.key;
    const apply = (list: string[] | undefined): string[] | undefined => {
      const set = new Set(list ?? []);
      if (body.allowed) set.add(key); else set.delete(key);
      return set.size > 0 ? [...set] : undefined;
    };

    // In-memory
    if (!agent.assist) agent.assist = {};
    agent.assist.autoApprove = apply(agent.assist.autoApprove);
    if (!agent.assist.autoApprove) {
      delete agent.assist.autoApprove;
      if (Object.keys(agent.assist).length === 0) delete agent.assist;
    }

    // Persist
    saveConfig(config.basePath, (raw) => {
      if (!raw.agents) return;
      const rawAgent = raw.agents.find((a: any) => a.id === agentId);
      if (!rawAgent) return;
      const next = apply(rawAgent.assist?.autoApprove);
      if (next) rawAgent.assist = { ...rawAgent.assist, autoApprove: next };
      else if (rawAgent.assist) {
        delete rawAgent.assist.autoApprove;
        if (Object.keys(rawAgent.assist).length === 0) delete rawAgent.assist;
      }
    });

    return json({ success: true, autoApprove: agent.assist?.autoApprove ?? [] });
  }

  // GET /api/agents/:agentId/avatar
  const avatarMatch = path.match(/^\/api\/agents\/([\w-]+)\/avatar$/);
  if (avatarMatch && method === "GET") {
    const agentId = avatarMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    // Check explicit avatar field, then fallback filenames
    const candidates = agent.avatar
      ? [resolve(agent.workspace, agent.avatar)]
      : ["avatar.png", "avatar.jpg", "avatar.webp"].map((f) => resolve(agent.workspace, f));

    for (const filePath of candidates) {
      if (existsSync(filePath)) {
        const ext = filePath.split(".").pop()!;
        const mimeMap: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          webp: "image/webp", gif: "image/gif",
        };
        // Validator keyed on mtime+size so the browser revalidates cheaply
        // (304, no body) instead of re-downloading the image on every agent
        // switch — the avatar was previously re-fetched in full each time
        // because of `no-cache` + a client `?t=Date.now()` buster. An avatar
        // upload bumps the mtime → new ETag → the next revalidation pulls
        // fresh bytes automatically, so `no-cache` keeps it never-stale.
        const st = statSync(filePath);
        const etag = `"${st.mtimeMs.toString(36)}-${st.size.toString(36)}"`;
        const baseHeaders: Record<string, string> = {
          "Cache-Control": "no-cache",
          "ETag": etag,
        };
        if (req.headers.get("If-None-Match") === etag) {
          return new Response(null, { status: 304, headers: baseHeaders });
        }
        return new Response(readFileSync(filePath), {
          headers: { ...baseHeaders, "Content-Type": mimeMap[ext] || "application/octet-stream" },
        });
      }
    }

    return json({ error: "No avatar found" }, 404);
  }

  // POST /api/agents/:agentId/avatar
  if (avatarMatch && method === "POST") {
    const agentId = avatarMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const contentType = req.headers.get("Content-Type") || "";
    const extMap: Record<string, string> = {
      "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    };
    const ext = extMap[contentType];
    if (!ext) return json({ error: "Unsupported image type" }, 400);

    // Cap the avatar body — small images only. (Bun's maxRequestBodySize is the
    // hard backstop; this gives a clean 413 and a tighter per-endpoint bound
    // than reading an unbounded arrayBuffer.)
    const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
    const declaredLen = Number(req.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLen) && declaredLen > MAX_AVATAR_BYTES) {
      return json({ error: `Avatar exceeds the ${MAX_AVATAR_BYTES / (1024 * 1024)}MB limit` }, 413);
    }
    const buffer = await req.arrayBuffer();
    if (buffer.byteLength > MAX_AVATAR_BYTES) {
      return json({ error: `Avatar exceeds the ${MAX_AVATAR_BYTES / (1024 * 1024)}MB limit` }, 413);
    }
    const filename = `avatar.${ext}`;
    writeFileSync(resolve(agent.workspace, filename), Buffer.from(buffer));

    agent.avatar = filename;
    saveConfig(config.basePath, (raw) => {
      const rawAgent = raw.agents?.find((a: any) => a.id === agentId);
      if (rawAgent) rawAgent.avatar = filename;
    });

    return json({ success: true, avatar: filename });
  }

  // GET /api/agents/:agentId/profile
  const profileMatch = path.match(/^\/api\/agents\/([\w-]+)\/profile$/);
  if (profileMatch && method === "GET") {
    const agentId = profileMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    // Extract tagline from IDENTITY.md
    let tagline: string | null = null;
    const identityPath = resolve(agent.workspace, "IDENTITY.md");
    if (existsSync(identityPath)) {
      const content = readFileSync(identityPath, "utf-8");
      // Try ## About section first, then ## Vibe
      for (const section of ["## About", "## Vibe"]) {
        const idx = content.indexOf(section);
        if (idx !== -1) {
          // Bound the section BEFORE trimming: trimming first let an EMPTY
          // section run past its own end and swallow the next heading, which
          // made a fresh scaffold's tagline render as a literal "About.".
          const afterHeader = content.slice(idx + section.length);
          const nextSection = afterHeader.indexOf("\n##");
          const sectionText = (nextSection !== -1 ? afterHeader.slice(0, nextSection) : afterHeader).trim();
          // Get first sentence
          const firstSentence = sectionText.split(/\.\s/)[0];
          if (firstSentence) {
            tagline = firstSentence.replace(/^[^a-zA-Z]*/, "").trim();
            if (!tagline.endsWith(".")) tagline += ".";
            break;
          }
        }
      }
    }

    // Load quotes from workspace. Three accepted on-disk shapes:
    //   1. [{ persona: "x", phrase: "..." }, ...]  — persona-keyed
    //   2. { persona: ["...", "..."], ... }        — pre-bucketed
    //   3. ["...", "..."]                          — flat list (no persona)
    // The flat list lands under the `default` bucket so the UI's
    // no-persona fallback picks it up via Object.values(...).flat().
    let quotes: Record<string, string[]> | null = null;
    const quotesPath = resolve(agent.workspace, "quotes.json");
    if (existsSync(quotesPath)) {
      try {
        const raw = JSON.parse(readFileSync(quotesPath, "utf-8"));
        if (Array.isArray(raw)) {
          quotes = {};
          for (const entry of raw) {
            if (typeof entry === "string") {
              (quotes.default ??= []).push(entry);
            } else if (entry && entry.persona && entry.phrase) {
              (quotes[entry.persona] ??= []).push(entry.phrase);
            }
          }
        } else if (typeof raw === "object" && raw !== null) {
          quotes = raw;
        }
      } catch {
        quotes = null;
      }
    }

    // Check avatar existence
    const hasAvatar = !!(agent.avatar && existsSync(resolve(agent.workspace, agent.avatar)))
      || existsSync(resolve(agent.workspace, "avatar.png"))
      || existsSync(resolve(agent.workspace, "avatar.jpg"))
      || existsSync(resolve(agent.workspace, "avatar.webp"));

    const provider = agent.defaultProvider || config.defaultProvider;
    const backend = getBackend(migrateLegacyBackendId(provider));
    const model = agent.defaultModel || backend?.defaultModel(config, { localModelManager }) || "";

    return json({
      id: agent.id,
      name: agent.name,
      tagline,
      quotes,
      accentColor: agent.accentColor || null,
      hasAvatar,
      // Only advertise the avatar URL when a file actually exists. An
      // unconditional URL makes the lobby's <img> 404 into a broken-image
      // icon (it has no onerror fallback); omitting it lets every
      // profile-driven surface fall back to the initial cleanly.
      avatarUrl: hasAvatar ? `/api/agents/${agent.id}/avatar` : undefined,
      provider,
      model,
    });
  }

  // GET /api/agents/:agentId/personas
  const personasMatch = path.match(/^\/api\/agents\/([\w-]+)\/personas$/);
  if (personasMatch && method === "GET") {
    const agentId = personasMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const personasPath = resolve(agent.workspace, "personas.json");
    if (!existsSync(personasPath)) {
      return json({ available: false, profiles: {}, currentState: null });
    }

    try {
      const raw = JSON.parse(readFileSync(personasPath, "utf-8"));
      return json({
        available: true,
        currentState: raw.currentState || null,
        profiles: Object.fromEntries(
          Object.entries(raw.profiles || {}).map(([key, profile]: [string, any]) => [
            key,
            {
              description: profile.description,
              style: profile.style,
              anchor: profile.anchor,
            },
          ])
        ),
        escapePhrases: raw.escapePhrases || [],
      });
    } catch {
      return json({ available: false, profiles: {}, currentState: null });
    }
  }

  // PUT /api/agents/:agentId/personas — update currentState in personas.json
  if (personasMatch && method === "PUT") {
    const agentId = personasMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const personasPath = resolve(agent.workspace, "personas.json");
    if (!existsSync(personasPath)) {
      return json({ error: "No personas.json" }, 404);
    }

    const body = await readJsonBody<{ currentState?: unknown }>(req);
    // currentState writes into personas.json verbatim — accept only a
    // string (a persona key) or null (clear), never arbitrary JSON.
    if (!body || (body.currentState !== null && typeof body.currentState !== "string")) {
      return json({ error: "currentState must be a string or null" }, 400);
    }

    try {
      const raw = JSON.parse(readFileSync(personasPath, "utf-8"));
      raw.currentState = body.currentState;
      writeFileSync(personasPath, JSON.stringify(raw, null, 2), "utf-8");
      return json({ success: true });
    } catch {
      return json({ error: "Failed to update personas" }, 500);
    }
  }

  return null;
}
