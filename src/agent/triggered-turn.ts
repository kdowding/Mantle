// runTriggeredAgentTurn — the shared front door for every NON-interactive
// agent turn: cron jobs, sub-agent child loops, synthetic deliveries
// (background/subagent results), and channel sub-turns.
//
// Why it exists: those five sites each hand-rolled the same spin-up —
// resolve agent → resolve backend → build system prompt → filter tools →
// assemble ToolContext → runAgentLoop — and the hand-rolling is where the
// bugs lived (the channel forgot BackendDeps so local-default agents threw;
// ToolContext pinning is what keeps englyph stores per-agent; cron scraped
// usage out of events). This front door owns those steps once; per-trigger
// flavor stays in the caller via the hooks below.
//
// What it deliberately does NOT own:
//   - The agent lock. Lock SCOPE is a trigger-level decision (cron holds the
//     lock across its run; synthetic appends its message between
//     acquire and turn) — use withAgentLock (agent-lock.ts) around this call.
//   - Session construction/registration. Callers own session identity (the
//     channel passes its ChannelSessionManager; cron owns its run session)
//     and append their own user message before calling.
//   - Compaction, Englyph hooks, delivery bookkeeping — trigger-specific.
//
// The interactive chat path (ws.ts handleChat) stays separate for now: it is
// a different world (CLI-mode dispatch, voice pipeline, attachments,
// retry/edit, memory pack) and the user is watching. It already shares the
// same primitives this wraps (resolveProviderTurn, buildSystemPrompt,
// runAgentLoop).

import type { MantleConfig } from "../config/schema.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type {
  ProviderMessage,
  SystemPromptInput,
  ToolDefinition,
  ThinkingLevel,
} from "./providers/types.js";
import {
  resolveProviderTurn,
  type BackendDeps,
  type BackendId,
  type ProviderSelection,
} from "./providers/catalog.js";
import { getAgent } from "../config/loader.js";
import { buildSystemPrompt, type SystemPrompt, type PersonaProfile } from "./prompt-builder.js";
import { resolveAgentSkillsForPrompt } from "../skills/loader.js";
import type { SessionManager } from "./session.js";
import {
  runAgentLoop,
  type AgentStreamEvent,
  type ToolCallOutcome,
  type TurnOutcome,
} from "./loop.js";

// A trigger-local tool that never reaches the registry — the channel's
// channel_yield / channel_react. Its def is advertised to the model; calls
// are intercepted and handled by the trigger.
export interface PseudoTool {
  def: ToolDefinition;
  handle: (input: Record<string, unknown>) => ToolCallOutcome | Promise<ToolCallOutcome>;
}

export interface TriggeredTurnParams {
  config: MantleConfig;
  registry: ToolRegistry;
  // Runtime backend deps (localModelManager). Forgetting this is exactly the
  // CHAN-6 bug — it's a single named field here so it can't be mis-threaded.
  deps?: BackendDeps;
  agentId: string;
  // Caller-built (and caller-registered) session. The user/task message must
  // already be appended; the loop reads the transcript from here.
  session: SessionManager;
  // Composed abort: the lock's preemption controller and/or the trigger's
  // own signal. The loop threads it into streams and tools.
  signal?: AbortSignal;
  // Backend selection overrides, merged over the agent + global defaults.
  // Pass an explicit `undefined` field to suppress a default (a caller does
  // this for agentDefaultModel when it pins its own provider).
  providerSelection?: Partial<ProviderSelection>;
  // When false, standing skills + the skills catalog are omitted from the
  // prompt (the channel keeps hangout turns lean). Default true.
  includeSkills?: boolean;
  // Prompt-scope overrides — which identity files render + whether the MANTLE.md
  // baseline loads. Cron presets use this to scope a scheduled run's context.
  promptScope?: { workspaceFiles?: string[]; includeBaseline?: boolean; cronMode?: boolean };
  // Interactive-chat prompt inputs, passed straight into buildSystemPrompt
  // so persona stays its own CACHEABLE zone (riding it through
  // composeSystemPrompt's dynamic hook would break per-mask caching).
  promptExtras?: {
    persona?: { name: string; profile: PersonaProfile };
    personaTransition?: { from: string; to: string };
    memoryPack?: string;
    voiceMode?: boolean;
  };
  // Trigger hook to reshape the built prompt (the channel appends its
  // "# Channel" block to the dynamic zone).
  composeSystemPrompt?: (base: SystemPrompt) => SystemPromptInput;
  // Tool-surface allow-list by name; absent = the full registry. Mechanical:
  // tools not listed never reach the model.
  toolAllowList?: string[];
  // Free-form tool-surface shaping when an allow-list is too rigid — chat
  // uses a deny-list (hide raw englyph_* + write wrappers). Applied INSTEAD
  // of toolAllowList semantics, only when toolAllowList is absent. A
  // filtered surface is treated as unconstrained for the purposes of
  // ToolContext.allowedToolNames (it's near-full, not a containment).
  toolFilter?: (defs: ToolDefinition[]) => ToolDefinition[];
  pseudoTools?: PseudoTool[];
  // Extra ToolContext fields (subagentManager/subagentDepth/backgroundRunner
  // etc.). agentId/sessionId/workspacePath are pinned here and CANNOT be
  // overridden — per-agent isolation depends on them.
  toolContextExtra?: Partial<ToolContext>;
  maxIterations?: number;
  thinkingLevel?: ThinkingLevel;
  fastMode?: boolean;
  transformMessages?: (messages: ProviderMessage[]) => Promise<ProviderMessage[]>;
  onEvent?: (event: AgentStreamEvent) => void;
}

export type TriggeredTurnResult =
  | { ok: true; outcome: TurnOutcome; backendId: BackendId; model: string }
  | { ok: false; reason: "agent_unknown" | "backend_unresolved"; error: string };

// Resolve the advertised registry surface for a turn: the caller's allow-list
// (mechanical — only listed names survive) OR its free-form filter (chat's
// memory deny-list), THEN the hard per-agent disable gate over whatever
// remained. Order matters — the disable gate runs LAST, so a tool the user
// disabled for this agent is removed from EVERY surface (chat/cron/channel/
// subagent) even when a trigger's own allow-list (a cron job's toolsAllow)
// explicitly named it. Internal
// registry.execute calls (memory pack, archivist, recall_* wrapper delegation)
// bypass this — they don't go through the advertised surface. Pure + exported
// so the precedence is unit-tested directly (triggered-turn.test.ts).
export function applyToolSurface(
  defs: ToolDefinition[],
  opts: {
    toolAllowList?: string[];
    toolFilter?: (defs: ToolDefinition[]) => ToolDefinition[];
    disabledTools?: string[];
  },
): ToolDefinition[] {
  let tools = defs;
  if (opts.toolAllowList) {
    const allowed = new Set(opts.toolAllowList);
    tools = tools.filter((t) => allowed.has(t.name));
  } else if (opts.toolFilter) {
    tools = opts.toolFilter(tools);
  }
  if (opts.disabledTools && opts.disabledTools.length > 0) {
    const disabled = new Set(opts.disabledTools);
    tools = tools.filter((t) => !disabled.has(t.name));
  }
  return tools;
}

export async function runTriggeredAgentTurn(params: TriggeredTurnParams): Promise<TriggeredTurnResult> {
  const {
    config, registry, deps, agentId, session, signal,
    providerSelection, includeSkills = true, promptScope,
    promptExtras, composeSystemPrompt, toolAllowList, toolFilter,
    pseudoTools, toolContextExtra,
    maxIterations, thinkingLevel, fastMode, transformMessages, onEvent,
  } = params;

  const agent = getAgent(config, agentId);
  if (!agent) {
    return { ok: false, reason: "agent_unknown", error: `Unknown agent: ${agentId}` };
  }

  const selection: ProviderSelection = {
    agentDefaultProvider: agent.defaultProvider,
    agentDefaultModel: agent.defaultModel,
    globalDefaultProvider: config.defaultProvider,
    // Spread last so a caller's explicit `undefined` suppresses a default.
    ...providerSelection,
  };
  const resolved = resolveProviderTurn(config, deps ?? {}, selection);
  if (!resolved.ok) {
    return { ok: false, reason: "backend_unresolved", error: resolved.error };
  }
  const { provider, model, backendId } = resolved;

  // System prompt: the full companion prompt, with the trigger's
  // optional compose hook layered on the result.
  const { standingSkills, skillsCatalog } = includeSkills
    ? resolveAgentSkillsForPrompt(config, agent)
    : { standingSkills: "", skillsCatalog: "" };
  const base = buildSystemPrompt({
    workspacePath: agent.workspace,
    standingSkills: standingSkills || undefined,
    skillsCatalog: skillsCatalog || undefined,
    persona: promptExtras?.persona,
    personaTransition: promptExtras?.personaTransition,
    memoryPack: promptExtras?.memoryPack,
    voiceMode: promptExtras?.voiceMode,
    workspaceFiles: promptScope?.workspaceFiles,
    includeBaseline: promptScope?.includeBaseline,
    cronMode: promptScope?.cronMode,
  });
  const systemPrompt: SystemPromptInput = composeSystemPrompt ? composeSystemPrompt(base) : base;

  // Tool surface: registry definitions, optionally allow-listed (or shaped
  // by the caller's filter), plus the trigger's pseudo-tools (advertised
  // but intercepted below).
  let tools = applyToolSurface(registry.getDefinitions(), {
    toolAllowList,
    toolFilter,
    disabledTools: agent.disabledTools,
  });
  // The effective REGISTRY surface of this turn (pseudo-tools excluded —
  // they're trigger-local and meaningless to future work). Stamped into
  // ToolContext only when the surface was actually constrained, so tools
  // that mint future work (cron_jobs create) propagate the constraint
  // instead of escalating to the full registry. Unconstrained turns keep
  // it undefined — their created jobs stay unconstrained, tracking the
  // registry as it grows.
  const effectiveToolNames = toolAllowList ? tools.map((t) => t.name) : undefined;
  const pseudoByName = new Map((pseudoTools ?? []).map((p) => [p.def.name, p]));
  if (pseudoByName.size > 0) {
    // A pseudo-tool intercepts its name BEFORE the registry (see
    // executeToolCall below), so an allow-listed registry tool with the
    // same name would be unreachable — drop the shadowed def rather than
    // advertising a duplicate the provider may reject. Pseudo defs are
    // PINNED: provider-side tool curation (local core/custom modes) must
    // not strip them — they're how the trigger steers the turn.
    tools = [
      ...tools.filter((t) => !pseudoByName.has(t.name)),
      ...(pseudoTools ?? []).map((p) => ({ ...p.def, pinned: true })),
    ];
  }

  const outcome = await runAgentLoop({
    provider,
    session,
    systemPrompt,
    tools,
    model,
    signal,
    maxIterations,
    thinkingLevel,
    fastMode,
    transformMessages,
    onEvent,
    executeToolCall: async (name, input, opts) => {
      const pseudo = pseudoByName.get(name);
      if (pseudo) return pseudo.handle(input);
      const r = await registry.execute(name, input, {
        ...toolContextExtra,
        // Pinned AFTER the extras — these are the isolation boundary.
        agentId,
        sessionId: session.sessionId,
        workspacePath: agent.workspace,
        allowedToolNames: effectiveToolNames,
        signal: opts.signal,
        progress: opts.progress,
        toolCallId: opts.toolCallId,
      });
      // Structured return (no throw) so the loop keeps the classifier's
      // {status, tag} for the loop-detector + UI chip.
      return {
        result: r.content,
        status: r.status,
        tag: r.tag,
        isError: r.isError,
        attachments: r.attachments,
      };
    },
  });

  return { ok: true, outcome, backendId, model };
}
