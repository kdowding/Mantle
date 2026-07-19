// Inference chrome logic — the backend catalog, per-agent backend memory,
// per-backend model memory, the effort/display toggles, and the send-field
// resolution. Ported from app.js's backend-picker + model + toggle helpers.
import { serverConfig, prefs, ui, type ThinkingLevel } from './state.svelte';
import { lsGet, lsSet } from './storage';
import type { Agent, Backend, MantleConfig } from './api';

const LS_REASONING = 'mantle-show-reasoning';
const LS_MEMORY = 'mantle-memory-pack';
const lsBackend = (agentId: string): string => `mantle-backend-${agentId}`;
const lsModel = (backendId: string): string => `mantle-model-${backendId}`;
const lsFast = (agentId: string): string => `mantle-fast-${agentId}`;
// Effort is remembered per (agent, model): swapping models keeps each one's
// last-set level and restores it on swap-back (degrading if the new model
// can't reach it).
const lsEffort = (agentId: string, model: string): string => `mantle-effort:${agentId}:${model}`;

// The full effort ladder, off→max. Each model offers a contiguous subset
// (effortLevelsFor); cycling + degradation step along this order.
const EFFORT_LADDER: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

// Per-(backend, model) effort ladder — the levels the picker offers and that
// cycleThinking steps through. Mirrors the server-side per-provider clamps
// (claude.ts claudeTakesEffort/clampClaudeEffort, openai*/grok mapReasoningEffort)
// so the UI never offers a level the model would reject; the server clamps too,
// as the safety net for cron/assist/API callers.
export function effortLevelsFor(backend: Backend | undefined, model: string | null): ThinkingLevel[] {
  if (!backend || !model) return ['off'];
  const m = model.toLowerCase();
  switch (backend.vendor) {
    case 'anthropic': {
      if (m.includes('haiku')) return ['off', 'low', 'medium', 'high'];
      if (m.includes('fable') || m.includes('mythos')) return [...EFFORT_LADDER];
      if (m.includes('opus')) {
        const n = Number(m.match(/opus-4-(\d+)/)?.[1] ?? 8);
        if (n >= 7) return ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
        if (n === 6) return ['off', 'low', 'medium', 'high', 'max'];
        return ['off', 'low', 'medium', 'high']; // 4.5 and older
      }
      if (m.includes('sonnet')) {
        const n = Number(m.match(/sonnet-4-(\d+)/)?.[1] ?? 6);
        return n >= 6 ? ['off', 'low', 'medium', 'high', 'max'] : ['off', 'low', 'medium', 'high'];
      }
      return ['off', 'low', 'medium', 'high'];
    }
    case 'openai':
      // API path (Chat Completions): 5.6 effort support is unverified without
      // a key, so it keeps the conservative ladder the server mapping matches.
      if (backend.mode === 'api') return ['off', 'low', 'medium', 'high'];
      // Codex subscription — per-model, from the client-version-filtered
      // catalog + live probes (2026-07-17). No codex model can disable
      // reasoning (the floor is low; the server clamps "off" there too), and
      // only the 5.6 trio takes max. "ultra" is orchestration, not a level.
      if (m.startsWith('gpt-5.6')) return ['low', 'medium', 'high', 'xhigh', 'max'];
      return ['low', 'medium', 'high', 'xhigh']; // 5.4 family + codex-spark
    case 'xai':
      // The Build subscription proxy declares effort support PER MODEL
      // (probed 2026-07-16): grok-4.5 takes low/medium/high — same engine
      // and floor as the API side; the "grok-build" alias still rejects
      // reasoning.effort with a 400, so it keeps no ladder.
      if (backend.mode === 'subscription') {
        return m === 'grok-4.5' ? ['low', 'medium', 'high'] : ['off'];
      }
      // grok-4.5 can't disable reasoning — its reasoning_effort floor is
      // "low" (the server clamps "off" there too; see grok.ts).
      if (m === 'grok-4.5') return ['low', 'medium', 'high'];
      return m === 'grok-4.3' ? ['off', 'low', 'medium', 'high'] : ['off'];
    case 'local':
      return ['off', 'high']; // llama.cpp enable_thinking is a single on/off
    default:
      return ['off'];
  }
}

// Effort ladder for the CURRENT selection — drives the picker and lets the chip
// disable itself when a model has nothing to cycle (e.g. grok-build).
export function effortLevels(): ThinkingLevel[] {
  return effortLevelsFor(selectedBackend(), prefs.model);
}

// Step a level down to the nearest one the model supports (never escalates).
function clampEffort(level: ThinkingLevel, levels: ThinkingLevel[]): ThinkingLevel {
  if (levels.includes(level)) return level;
  for (let i = EFFORT_LADDER.indexOf(level); i >= 0; i--) {
    if (levels.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i];
  }
  return levels[0] ?? 'off';
}

// First-touch effort for models whose catalog declares a default the ladder
// floor wouldn't land on (codex catalog default_reasoning_level, 2026-07-17).
// Only consulted when nothing is remembered AND the current level isn't valid
// for the model — carrying a supported level across a swap still wins.
const DEFAULT_EFFORT: Record<string, ThinkingLevel> = {
  'gpt-5.6-terra': 'medium',
  'gpt-5.6-luna': 'medium',
};

// After the model resolves, restore this (agent, model)'s remembered effort —
// or, lacking one, the model's own catalog default — or clamp the current
// level down to what the model supports.
function restoreEffort(): void {
  const agentId = ui.currentAgentId;
  const levels = effortLevelsFor(selectedBackend(), prefs.model);
  if (agentId && prefs.model) {
    const remembered = lsGet(lsEffort(agentId, prefs.model)) as ThinkingLevel | null;
    if (remembered && levels.includes(remembered)) {
      prefs.thinkingLevel = remembered;
      return;
    }
  }
  if (!levels.includes(prefs.thinkingLevel)) {
    const def = prefs.model ? DEFAULT_EFFORT[prefs.model] : undefined;
    if (def && levels.includes(def)) {
      prefs.thinkingLevel = def;
      return;
    }
  }
  prefs.thinkingLevel = clampEffort(prefs.thinkingLevel, levels);
}

// Persisted display/effort prefs at boot (backend/model are per-agent, resolved
// on agent select).
export function initPrefs(): void {
  // Effort is per-(agent, model) now — restored by restoreEffort() once a model
  // resolves (resolveBackendForAgent / refreshModel / selectModel), not a global.
  prefs.showReasoning = lsGet(LS_REASONING) !== 'false';
  prefs.memoryPack = lsGet(LS_MEMORY) !== 'off';
}

export function loadServerConfig(cfg: MantleConfig): void {
  serverConfig.backends = cfg.backends ?? [];
  serverConfig.vendorLabels = cfg.vendorLabels ?? {};
  serverConfig.defaultProvider = cfg.defaultProvider ?? null;
  serverConfig.modelContextWindows = cfg.session?.modelContextWindows ?? {};
  serverConfig.defaultContextWindow = cfg.session?.defaultContextWindow ?? 200000;
  serverConfig.compactionFraction = cfg.session?.compactionFraction ?? 0.6;
  serverConfig.features = cfg.features ?? {};
  serverConfig.providerKeys = cfg.providerKeys ?? {};
  serverConfig.user = cfg.user ?? { name: '' };
}

export function backendById(id: string | null): Backend | undefined {
  if (!id) return undefined;
  return serverConfig.backends.find((b) => b.id === id);
}
export function selectedBackend(): Backend | undefined {
  return backendById(prefs.backendId);
}

function firstConfigured(): Backend | undefined {
  return serverConfig.backends.find((b) => b.configured) ?? serverConfig.backends[0];
}

// Resolve the backend for an agent: remembered (if still configured) → the
// AGENT's own default → the global default → first configured. The agent's
// default must beat the global default (a Claude agent shouldn't open on Grok).
// Model resolution prefers the agent's defaultModel when nothing else fits.
export function resolveBackendForAgent(agent: Agent | undefined): void {
  const remembered = agent ? backendById(lsGet(lsBackend(agent.id))) : undefined;
  const agentDefault = backendById(agent?.defaultProvider ?? null);
  const globalDefault = backendById(serverConfig.defaultProvider);
  const pick =
    (remembered?.configured ? remembered : undefined) ??
    (agentDefault?.configured ? agentDefault : undefined) ??
    (globalDefault?.configured ? globalDefault : undefined) ??
    firstConfigured();
  prefs.backendId = pick?.id ?? null;
  prefs.fastMode = agent ? lsGet(lsFast(agent.id)) === 'on' : false;
  refreshModel(agent?.defaultModel);
}

export function selectBackend(id: string): void {
  prefs.backendId = id;
  if (ui.currentAgentId) lsSet(lsBackend(ui.currentAgentId), id);
  refreshModel();
}

// Resolve the model for the active backend: remembered (per-backend) →
// `preferred` (the agent's defaultModel, when it fits this backend) → backend
// default → first available → null (server then falls back to the agent default).
export function refreshModel(preferred?: string): void {
  const b = selectedBackend();
  const list = b?.models ?? [];
  const stored = prefs.backendId ? lsGet(lsModel(prefs.backendId)) : null;
  if (stored && list.includes(stored)) prefs.model = stored;
  else if (preferred && list.includes(preferred)) prefs.model = preferred;
  else if (b?.defaultModel && list.includes(b.defaultModel)) prefs.model = b.defaultModel;
  else prefs.model = list[0] ?? null;
  restoreEffort();
}

export function selectModel(model: string): void {
  prefs.model = model;
  if (prefs.backendId) lsSet(lsModel(prefs.backendId), model);
  restoreEffort();
}

export function setThinking(level: ThinkingLevel): void {
  prefs.thinkingLevel = level;
  if (ui.currentAgentId && prefs.model) lsSet(lsEffort(ui.currentAgentId, prefs.model), level);
}

// Cycle through the levels the CURRENT model supports (off → … → ceiling → off).
export function cycleThinking(): void {
  const levels = effortLevelsFor(selectedBackend(), prefs.model);
  if (levels.length <= 1) return; // only "off" — nothing to cycle
  const i = levels.indexOf(prefs.thinkingLevel);
  setThinking(levels[(i + 1) % levels.length]);
}

// Codex models whose catalog entry advertises the `priority` ("Fast") service
// tier — mirror of the server-side CODEX_FAST_MODELS (openai-codex.ts), pinned
// to the 2026-07-17 capture. The chip hides (not disables) off this set.
const CODEX_FAST_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4']);

// Fast mode applies to the CURRENT selection? Gates both the profile-bar chip
// and whether the payload ships `fastMode` (a stored preference for an
// inapplicable model must not leak onto the wire).
export function fastModeAvailable(): boolean {
  return prefs.backendId === 'openai/subscription' && !!prefs.model && CODEX_FAST_MODELS.has(prefs.model);
}

export function setFastMode(on: boolean): void {
  prefs.fastMode = on;
  if (ui.currentAgentId) lsSet(lsFast(ui.currentAgentId), on ? 'on' : 'off');
}

export function toggleFastMode(): void {
  setFastMode(!prefs.fastMode);
}

export function setReasoning(on: boolean): void {
  prefs.showReasoning = on;
  lsSet(LS_REASONING, String(on));
}

export function toggleReasoning(): void {
  setReasoning(!prefs.showReasoning);
}

export function setMemory(on: boolean): void {
  prefs.memoryPack = on;
  lsSet(LS_MEMORY, on ? 'on' : 'off');
}

export function toggleMemory(): void {
  setMemory(!prefs.memoryPack);
}

export function contextWindow(): number {
  return (prefs.model ? serverConfig.modelContextWindows[prefs.model] : undefined) ?? serverConfig.defaultContextWindow;
}

// "Grok · API · Grok 4.3" for the picker button.
export function backendSummary(): string {
  const b = selectedBackend();
  if (!b) return 'no backend';
  const vendor = serverConfig.vendorLabels[b.vendor] || b.vendor;
  const mode = modeLabel(b);
  const parts = [vendor];
  if (mode && mode !== vendor) parts.push(mode);
  if (prefs.model) parts.push(modelMeta(prefs.model).name);
  return parts.join(' · ');
}

// Mode chip from the label ("Grok · Build" → "Build").
export function modeLabel(b: Backend): string {
  const parts = b.label.split('·');
  return (parts[parts.length - 1] || b.mode).trim();
}

export function displayModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
}

// Display names + one-line hints for the model picker. Curated for the cloud
// lineups; anything unlisted (notably local GGUF ids) falls back to the raw id
// via displayModel. Hints describe the model's ROLE in its lineup, not specs
// the server would contradict (context windows differ per access mode).
const MODEL_META: Record<string, { name: string; hint?: string }> = {
  // ChatGPT — codex subscription + API (2026-07-17 lineup)
  'gpt-5.6-sol': { name: 'GPT-5.6 Sol', hint: 'flagship — deepest reasoning' },
  'gpt-5.6-terra': { name: 'GPT-5.6 Terra', hint: 'balanced — everyday default' },
  'gpt-5.6-luna': { name: 'GPT-5.6 Luna', hint: 'fast + affordable' },
  'gpt-5.5': { name: 'GPT-5.5', hint: 'previous frontier' },
  'gpt-5.4': { name: 'GPT-5.4', hint: 'previous gen — everyday work' },
  'gpt-5.4-mini': { name: 'GPT-5.4 Mini', hint: 'small + quick' },
  'gpt-5.3-codex-spark': { name: 'GPT-5.3 Codex Spark', hint: 'ultra-fast, lighter context' },
  // Claude
  'claude-sonnet-4-6': { name: 'Sonnet 4.6', hint: 'balanced — everyday default' },
  'claude-opus-4-8': { name: 'Opus 4.8', hint: 'deep reasoning' },
  'claude-haiku-4-5-20251001': { name: 'Haiku 4.5', hint: 'fast + affordable' },
  // Grok
  'grok-4.5': { name: 'Grok 4.5', hint: 'frontier — always reasons' },
  'grok-4.3': { name: 'Grok 4.3', hint: 'previous gen' },
  'grok-build': { name: 'Grok Build', hint: 'subscription default alias' },
  'grok-4.20-0309-reasoning': { name: 'Grok 4.20 Reasoning' },
  'grok-4.20-0309-non-reasoning': { name: 'Grok 4.20' },
  'grok-4-1-fast-reasoning': { name: 'Grok 4.1 Fast Reasoning' },
  'grok-4-1-fast-non-reasoning': { name: 'Grok 4.1 Fast' },
};

export function modelMeta(id: string): { name: string; hint?: string } {
  return MODEL_META[id] ?? { name: displayModel(id) };
}
