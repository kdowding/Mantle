import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync, statSync } from "fs";
import type { MantleConfig } from "../config/schema.js";
import { getAgent } from "../config/loader.js";
import { SessionManager } from "../agent/session.js";
import { buildSystemPrompt, type PersonaProfile } from "../agent/prompt-builder.js";
import { resolveAgentSkillsForPrompt } from "../skills/loader.js";
import {
  PERSONALITY_FILES,
  isToggleableFilename,
  isPersonalityFile,
  parseFileSections,
  loadToggleMap,
  saveToggleMap,
  reconcileFileToggles,
  disabledHeadingsFor,
  type ToggleMap,
} from "../agent/section-toggles.js";
import { scaffoldWorkspaceFile } from "./workspace-templates.js";

// ── Workspace files API ──────────────────────────────────────────────────
//
// Endpoints:
//   GET    /api/agents/:id/workspace-files
//          → { files: [{ name, exists, size, mtime, sections, hasToggleable }] }
//
//   GET    /api/agents/:id/workspace-files/:filename
//          → { name, content, sections, exists, mtime }
//
//   PUT    /api/agents/:id/workspace-files/:filename
//          body { content }
//          → saves the file (whitelist filename), reconciles toggle map
//          against the new section list, returns updated metadata
//
//   PUT    /api/agents/:id/workspace-files/:filename/sections
//          body { sections: { "Heading": boolean, ... } }
//          → updates toggle map for that file, takes effect next turn
//
//   GET    /api/agents/:id/system-prompt-preview
//                          ?persona=<name>&voiceMode=true|false
//                          &memoryPack=on|off&sessionId=<id>
//          → { stable, persona, dynamic, meta }
//          Renders buildSystemPrompt() against the agent's current state.
//          Memory pack is shown as a placeholder block (its actual content
//          depends on the user's next message text); UI knows the slot
//          state from `meta.memoryPackEnabled`.

interface PersonasConfig {
  currentState: string;
  profiles: Record<string, PersonaProfile>;
  escapePhrases?: string[];
}

function loadPersonas(workspacePath: string): PersonasConfig | null {
  const personasPath = resolve(workspacePath, "personas.json");
  if (!existsSync(personasPath)) return null;
  try {
    return JSON.parse(readFileSync(personasPath, "utf-8"));
  } catch {
    return null;
  }
}

// Rough Anthropic-ish token estimation. char/4 is the common heuristic;
// fine for cache headroom guidance — this is a UI hint, not billing.
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

interface SectionSummary {
  heading: string;
  enabled: boolean;
  // Character count of the section body (heading line + content). Useful
  // for the UI to show "weight" without sending the full text on the list
  // endpoint — content is fetched lazily on click.
  size: number;
}

interface FileSummary {
  name: string;
  exists: boolean;
  size: number;        // total byte size of the on-disk file
  mtime: string;       // ISO timestamp
  sections: SectionSummary[];
  // Whether section toggling applies to this file. Always true for the
  // four files we expose; included for the UI's stability against future
  // additions to TOGGLEABLE_FILES.
  toggleable: boolean;
}

function summarizeFile(
  workspacePath: string,
  filename: string,
  toggleMap: ToggleMap,
): FileSummary {
  const filePath = resolve(workspacePath, filename);
  if (!existsSync(filePath)) {
    return { name: filename, exists: false, size: 0, mtime: "", sections: [], toggleable: isToggleableFilename(filename) };
  }
  const stat = statSync(filePath);
  const content = readFileSync(filePath, "utf-8");
  const parsed = parseFileSections(content);
  const disabled = disabledHeadingsFor(toggleMap, filename);
  const sections: SectionSummary[] = parsed.sections.map((s) => ({
    heading: s.heading,
    enabled: !disabled.has(s.heading),
    size: s.body.length,
  }));
  return {
    name: filename,
    exists: true,
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    sections,
    toggleable: isToggleableFilename(filename),
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleWorkspaceFilesApi(
  req: Request,
  url: URL,
  config: MantleConfig,
): Promise<Response> {
  const path = url.pathname;
  const method = req.method;
  const baseMantleDir = resolve(config.basePath, ".mantle");

  // System prompt preview — separate route, handled first.
  const previewMatch = path.match(/^\/api\/agents\/([\w-]+)\/system-prompt-preview$/);
  if (previewMatch && method === "GET") {
    const agentId = previewMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const personaName = url.searchParams.get("persona") ?? null;
    const voiceMode = url.searchParams.get("voiceMode") === "true";
    const memoryPackEnabled = url.searchParams.get("memoryPack") !== "off";
    const sessionId = url.searchParams.get("sessionId");

    // Resolve persona — caller can pass an explicit name; if null, fall
    // back to personas.json `currentState`. Profile must exist in the
    // agent's profiles[] map or persona section is omitted.
    const personasConfig = loadPersonas(agent.workspace);
    const requestedPersona = personaName ?? personasConfig?.currentState ?? null;
    let personaOpts: { name: string; profile: PersonaProfile } | undefined;
    if (
      personasConfig &&
      requestedPersona &&
      personasConfig.profiles[requestedPersona]
    ) {
      personaOpts = {
        name: requestedPersona,
        profile: personasConfig.profiles[requestedPersona],
      };
    }

    // Persona transition: if the caller passed sessionId AND that session's
    // last-message persona differs from the requested persona, the next
    // turn will inject a transition note. Mirror that here so the preview
    // matches reality.
    let transitionOpts: { from: string; to: string } | undefined;
    if (sessionId && requestedPersona) {
      const sessionsDir = resolve(baseMantleDir, "sessions", agentId);
      try {
        const index = SessionManager.loadIndex(sessionsDir);
        const meta = index.sessions.find((s) => s.id === sessionId);
        const previous = meta?.lastMessagePersona;
        if (previous && previous !== requestedPersona) {
          transitionOpts = { from: previous, to: requestedPersona };
        }
      } catch {
        // Best-effort — preview doesn't depend on transition note
      }
    }

    // Skills: same dispatch the WS path uses, so the preview's stable zone
    // matches what the agent gets on send.
    const { standingSkills, skillsCatalog } = resolveAgentSkillsForPrompt(config, agent);

    // Memory-pack placeholder: when on, inject a clearly-marked stand-in
    // block where Englyph hits would land at send time. When off, omit
    // entirely — that's literally what the agent will receive.
    const memoryPackPlaceholder = memoryPackEnabled
      ? "# Recalled Memories\n\n" +
        "[Memory pack placeholder — at send time, Englyph retrieval runs " +
        "against your message (and prior turn context if available) and " +
        "fills this block with framed memories scored above the relevance " +
        "floor. Contents vary per turn; cannot be previewed without a " +
        "concrete query.]"
      : undefined;

    const prompt = buildSystemPrompt({
      workspacePath: agent.workspace,
      standingSkills,
      skillsCatalog,
      persona: personaOpts,
      personaTransition: transitionOpts,
      memoryPack: memoryPackPlaceholder,
      voiceMode,
    });

    return json({
      stable: prompt.stable,
      persona: prompt.persona,
      dynamic: prompt.dynamic,
      meta: {
        agentId,
        persona: personaOpts?.name ?? null,
        transition: transitionOpts ?? null,
        voiceMode,
        memoryPackEnabled,
        tokens: {
          stable: estimateTokens(prompt.stable),
          persona: estimateTokens(prompt.persona),
          dynamic: estimateTokens(prompt.dynamic),
          // Sub-counts so the UI can isolate what skills cost: standing bodies
          // AND the triggered catalog both live inside `stable`.
          standingSkills: estimateTokens(standingSkills),
          skillsCatalog: estimateTokens(skillsCatalog),
          total:
            estimateTokens(prompt.stable) +
            estimateTokens(prompt.persona) +
            estimateTokens(prompt.dynamic),
        },
      },
    });
  }

  // List all toggleable files for an agent.
  const listMatch = path.match(/^\/api\/agents\/([\w-]+)\/workspace-files$/);
  if (listMatch && method === "GET") {
    const agentId = listMatch[1];
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const toggleMap = loadToggleMap(agent.workspace);
    const files = PERSONALITY_FILES.map((f) => summarizeFile(agent.workspace, f, toggleMap));
    return json({ files });
  }

  // Per-file routes — read raw, save raw, update sections.
  const fileMatch = path.match(/^\/api\/agents\/([\w-]+)\/workspace-files\/([\w.]+)$/);
  if (fileMatch) {
    const agentId = fileMatch[1];
    const filename = fileMatch[2];
    if (!isPersonalityFile(filename)) {
      return json({ error: `File not editable via this endpoint: ${filename}` }, 400);
    }
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const filePath = resolve(agent.workspace, filename);

    if (method === "GET") {
      const toggleMap = loadToggleMap(agent.workspace);
      if (!existsSync(filePath)) {
        return json({
          name: filename,
          exists: false,
          content: "",
          sections: [],
          mtime: "",
        });
      }
      const stat = statSync(filePath);
      const content = readFileSync(filePath, "utf-8");
      const parsed = parseFileSections(content);
      const disabled = disabledHeadingsFor(toggleMap, filename);
      return json({
        name: filename,
        exists: true,
        content,
        mtime: stat.mtime.toISOString(),
        preamble: parsed.preamble,
        sections: parsed.sections.map((s) => ({
          heading: s.heading,
          body: s.body,
          enabled: !disabled.has(s.heading),
        })),
      });
    }

    if (method === "PUT") {
      let body: { content?: unknown };
      try {
        body = (await req.json()) as { content?: unknown };
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const content = body.content;
      if (typeof content !== "string") {
        return json({ error: "content must be a string" }, 400);
      }
      // Cap to a sane size — workspace identity files shouldn't grow
      // unbounded, and we want clear failure if a paste goes wrong.
      const MAX_BYTES = 256 * 1024;
      if (Buffer.byteLength(content, "utf-8") > MAX_BYTES) {
        return json({ error: `File too large (max ${MAX_BYTES} bytes)` }, 413);
      }

      writeFileSync(filePath, content, "utf-8");

      // Reconcile toggle map: drop entries for sections that no longer
      // exist after the save. New sections appear default-on (no entry
      // means enabled).
      const toggleMap = loadToggleMap(agent.workspace);
      const parsed = parseFileSections(content);
      const headings = parsed.sections.map((s) => s.heading);
      const reconciled = reconcileFileToggles(toggleMap, filename, headings);
      saveToggleMap(agent.workspace, reconciled);

      const stat = statSync(filePath);
      const disabled = disabledHeadingsFor(reconciled, filename);
      return json({
        success: true,
        name: filename,
        mtime: stat.mtime.toISOString(),
        size: stat.size,
        sections: parsed.sections.map((s) => ({
          heading: s.heading,
          enabled: !disabled.has(s.heading),
          size: s.body.length,
        })),
      });
    }

    return json({ error: `Method not allowed: ${method}` }, 405);
  }

  // Update toggle map for a single file.
  const sectionsMatch = path.match(
    /^\/api\/agents\/([\w-]+)\/workspace-files\/([\w.]+)\/sections$/
  );
  if (sectionsMatch && method === "PUT") {
    const agentId = sectionsMatch[1];
    const filename = sectionsMatch[2];
    if (!isToggleableFilename(filename)) {
      return json({ error: `File not editable via this endpoint: ${filename}` }, 400);
    }
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    let body: { sections?: unknown };
    try {
      body = (await req.json()) as { sections?: unknown };
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const sections = body.sections;
    if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
      return json({ error: "sections must be an object: { heading: boolean }" }, 400);
    }

    const toggleMap = loadToggleMap(agent.workspace);
    const existing = toggleMap[filename] ?? {};
    const next: Record<string, boolean> = { ...existing };
    for (const [heading, enabled] of Object.entries(sections as Record<string, unknown>)) {
      if (typeof enabled !== "boolean") continue;
      // Storage is monotonic — only record `false`, drop the key when on.
      if (enabled === false) {
        next[heading] = false;
      } else {
        delete next[heading];
      }
    }
    const updated: ToggleMap = { ...toggleMap, [filename]: next };

    // Reconcile against the current file content so renamed/removed
    // sections from a prior raw-edit don't linger.
    const filePath = resolve(agent.workspace, filename);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      const parsed = parseFileSections(content);
      const reconciled = reconcileFileToggles(
        updated,
        filename,
        parsed.sections.map((s) => s.heading),
      );
      saveToggleMap(agent.workspace, reconciled);
      const disabled = disabledHeadingsFor(reconciled, filename);
      return json({
        success: true,
        sections: parsed.sections.map((s) => ({
          heading: s.heading,
          enabled: !disabled.has(s.heading),
          size: s.body.length,
        })),
      });
    }

    saveToggleMap(agent.workspace, updated);
    return json({ success: true, sections: [] });
  }

  // Create a missing personality file from its template (the same templates
  // new-agent creation uses), rendered for this agent. Writes it to disk and
  // returns the new content + section metadata so the editor opens it at once.
  const scaffoldMatch = path.match(
    /^\/api\/agents\/([\w-]+)\/workspace-files\/([\w.]+)\/scaffold$/
  );
  if (scaffoldMatch && method === "POST") {
    const agentId = scaffoldMatch[1];
    const filename = scaffoldMatch[2];
    if (!isPersonalityFile(filename)) {
      return json({ error: `Not a personality file: ${filename}` }, 400);
    }
    const agent = getAgent(config, agentId);
    if (!agent) return json({ error: `Unknown agent: ${agentId}` }, 404);

    const filePath = resolve(agent.workspace, filename);
    if (existsSync(filePath)) {
      return json({ error: `${filename} already exists` }, 409);
    }

    let content: string;
    try {
      content = scaffoldWorkspaceFile(config.basePath, agent, filename);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }

    const stat = statSync(filePath);
    const parsed = parseFileSections(content);
    const disabled = disabledHeadingsFor(loadToggleMap(agent.workspace), filename);
    return json({
      success: true,
      name: filename,
      exists: true,
      content,
      mtime: stat.mtime.toISOString(),
      preamble: parsed.preamble,
      sections: parsed.sections.map((s) => ({
        heading: s.heading,
        body: s.body,
        enabled: !disabled.has(s.heading),
      })),
    });
  }

  return json({ error: `Unknown workspace-files route: ${method} ${path}` }, 404);
}
