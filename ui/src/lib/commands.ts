// Slash commands — the composer's client-side command parser, ported from
// app.js (COMMANDS / parseCommand / cmd* handlers). Input starting with `/`
// is intercepted when it matches a registered command; unrecognized prefixes
// pass through as regular messages. Results render as centered system notes.
//
// Unlike the vanilla UI (input dead while streaming), the composer stays live
// during a turn — so /stop typed mid-stream works, and other commands run
// without being converted to steer-notes.
import { chat, ui, prefs, type ThinkingLevel } from './state.svelte';
import { mkMessage, stopTurn } from './ws';
import { newSession } from './sessions';
import { setThinking, setReasoning, setMemory, backendSummary } from './inference';

function note(text: string, error = false): void {
  chat.messages.push(mkMessage('system', text, { error }));
}

interface Command {
  aliases: string[];
  usage: string;
  description: string;
  handler: (args: string) => void | Promise<void>;
}

const COMMANDS: Record<string, Command> = {
  think: {
    aliases: ['thinking', 't'],
    usage: '/think [off|low|medium|high]',
    description: 'Set extended thinking level',
    handler: cmdThink,
  },
  reasoning: {
    aliases: [],
    usage: '/reasoning [on|off]',
    description: 'Toggle reasoning display',
    handler: cmdReasoning,
  },
  memorypack: {
    aliases: ['mp', 'memory'],
    usage: '/memorypack [on|off]',
    description: 'Toggle pre-inference memory pack',
    handler: cmdMemoryPack,
  },
  clear: {
    aliases: ['cls'],
    usage: '/clear',
    description: 'Clear chat display',
    handler: () => {
      chat.messages = [];
    },
  },
  new: {
    aliases: [],
    usage: '/new',
    description: 'New session',
    handler: () => {
      newSession();
    },
  },
  compact: {
    aliases: [],
    usage: '/compact',
    description: 'Compact session context',
    handler: cmdCompact,
  },
  stop: {
    aliases: ['abort'],
    usage: '/stop',
    description: 'Stop current stream',
    handler: () => {
      if (!chat.isStreaming) {
        note('No active stream');
        return;
      }
      stopTurn();
    },
  },
  model: {
    aliases: [],
    usage: '/model',
    description: 'Show current backend/model',
    handler: () => {
      note(`Backend: ${backendSummary()}`);
    },
  },
  tools: {
    aliases: [],
    usage: '/tools',
    description: 'List available tools',
    handler: cmdTools,
  },
  status: {
    aliases: [],
    usage: '/status',
    description: 'System status',
    handler: cmdStatus,
  },
  usage: {
    aliases: [],
    usage: '/usage',
    description: 'ChatGPT subscription usage',
    handler: cmdUsage,
  },
  help: {
    aliases: ['?', 'commands'],
    usage: '/help',
    description: 'List commands',
    handler: () => {
      note(Object.values(COMMANDS).map((c) => `${c.usage}  -  ${c.description}`).join('\n'));
    },
  },
};

const lookup = new Map<string, Command>();
for (const cmd of Object.values(COMMANDS)) {
  lookup.set(cmd.usage.slice(1).split(/[\s[]/)[0], cmd);
  for (const alias of cmd.aliases) lookup.set(alias, cmd);
}

// Returns true when the input was a recognized command (caller skips the send).
// Palette listing — name + usage + description per command (read-only view).
export function listCommands(): Array<{ name: string; usage: string; description: string }> {
  return Object.entries(COMMANDS).map(([name, c]) => ({ name, usage: c.usage, description: c.description }));
}

export function tryCommand(input: string): boolean {
  const match = input.match(/^\/(\S+)\s*(.*)?$/);
  if (!match) return false;
  const cmd = lookup.get(match[1].toLowerCase());
  if (!cmd) return false;
  void cmd.handler((match[2] ?? '').trim());
  return true;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function cmdThink(args: string): void {
  if (!args) {
    note(`Thinking level: ${prefs.thinkingLevel}`);
    return;
  }
  const levels: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];
  if (!(levels as string[]).includes(args)) {
    note(`Invalid level. Use: ${levels.join(', ')}`, true);
    return;
  }
  setThinking(args as ThinkingLevel);
  note(`Thinking set to: ${args}`);
}

function cmdReasoning(args: string): void {
  if (!args) {
    note(`Reasoning display: ${prefs.showReasoning ? 'on' : 'off'}`);
    return;
  }
  if (args === 'on' || args === 'off') {
    setReasoning(args === 'on');
    note(`Reasoning display ${args === 'on' ? 'enabled' : 'disabled'}`);
  } else {
    note('Usage: /reasoning [on|off]', true);
  }
}

function cmdMemoryPack(args: string): void {
  if (!args) {
    note(`Memory pack: ${prefs.memoryPack ? 'on' : 'off'}`);
    return;
  }
  if (args === 'on' || args === 'off') {
    setMemory(args === 'on');
    note(`Memory pack ${args === 'on' ? 'enabled' : 'disabled'}`);
  } else {
    note('Usage: /memorypack [on|off]', true);
  }
}

async function cmdCompact(): Promise<void> {
  if (!chat.sessionId || !ui.currentAgentId) {
    note('No active session', true);
    return;
  }
  note('Compacting session…');
  try {
    const res = await fetch(`/api/agents/${ui.currentAgentId}/sessions/${chat.sessionId}/compact`, { method: 'POST' });
    const data = (await res.json()) as { success?: boolean; before?: number; after?: number; reason?: string };
    if (data.success) note(`Compacted: ${data.before} → ${data.after} tokens`);
    else note(data.reason ?? 'Compaction not needed');
  } catch {
    note('Compaction failed', true);
  }
}

async function cmdTools(): Promise<void> {
  try {
    const res = await fetch('/api/tools');
    const data = (await res.json()) as { tools: Array<{ name: string }> };
    note(`Tools (${data.tools.length}): ${data.tools.map((t) => t.name).join(', ')}`);
  } catch {
    note('Failed to fetch tools', true);
  }
}

async function cmdStatus(): Promise<void> {
  try {
    const res = await fetch('/api/config');
    const config = (await res.json()) as { englyph?: { enabled?: boolean } };
    note([
      `Backend: ${backendSummary()}`,
      `Agent: ${ui.currentAgentId ?? 'none'}`,
      `Session: ${chat.sessionId ? `${chat.sessionId.slice(0, 8)}…` : 'none'}`,
      `Thinking: ${prefs.thinkingLevel}`,
      `Memory pack: ${prefs.memoryPack ? 'on' : 'off'}`,
      `Englyph: ${config.englyph?.enabled ? 'connected' : 'disabled'}`,
    ].join(' | '));
  } catch {
    note('Failed to fetch status', true);
  }
}

// Full usage snapshot (windows + reset countdowns) as a system note. Works
// regardless of the active backend — "what's my Plus budget look like" while
// chatting with claude/grok. Fetches the same endpoint as the codex auth row
// (inlined here: core doesn't import rooms).
async function cmdUsage(): Promise<void> {
  try {
    const res = await fetch('/api/auth/openai-codex/status');
    const data = (await res.json()) as {
      loggedIn?: boolean;
      email?: string;
      accountId?: string;
      plan?: string;
      usage?: {
        primaryUsedPercent?: number | null;
        secondaryUsedPercent?: number | null;
        primaryResetAfterSeconds?: number | null;
        secondaryResetAfterSeconds?: number | null;
      };
    };
    if (!data.loggedIn) {
      note('Not signed in to ChatGPT. Use the Sign in button in the backend picker (ChatGPT · Codex).', true);
      return;
    }
    if (!data.usage) {
      note(`Plan: ${data.plan ?? 'unknown'} (${data.email ?? '-'}) | usage data unavailable`);
      return;
    }
    const u = data.usage;
    const fmt = (s: number | null | undefined): string =>
      s == null ? '?' : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`;
    note([
      `Plan: ${data.plan ?? 'unknown'} (${data.email ?? data.accountId?.slice(0, 8)})`,
      `5h window: ${u.primaryUsedPercent}% used, resets in ${fmt(u.primaryResetAfterSeconds)}`,
      `7d window: ${u.secondaryUsedPercent}% used, resets in ${fmt(u.secondaryResetAfterSeconds)}`,
    ].join(' | '));
  } catch {
    note('Failed to fetch usage', true);
  }
}
