// Transcript replay — convert the raw /api/sessions/:id message array into
// ChatMessage[] for static render. Mirrors app.js loadTranscript:
//   - consecutive assistant turns (split by tool-result user messages) group
//     into ONE bubble;
//   - tool_result blocks (user role) fill the matching tool_use by id rather
//     than rendering as their own bubble;
//   - assistant content blocks → ordered parts (thinking / text) + tools;
//   - image/file blocks → attachments (user uploads + agent-attached files).
// Replayed parts carry their content (`text`) so components render statically.
import type { RawMessage, RawBlock } from './api';
import { uploadUrl } from './api';
import type { ChatMessage, ToolCall, Attachment } from './state.svelte';
import { kindFromCategory } from './attachments';
import { truncate } from './format';

function uuid(): string {
  return crypto.randomUUID();
}

function blankAssistant(): ChatMessage {
  return {
    id: uuid(),
    role: 'assistant',
    text: '',
    parts: [],
    tools: [],
    toolsOpen: false,
    attachments: [],
    streaming: false,
    error: false,
    blank: false,
  };
}

function blocksToAttachments(blocks: RawBlock[], agentId: string, sessionId: string): Attachment[] {
  return blocks
    .filter((b) => b.type === 'image' || b.type === 'file')
    .map((b) => ({
      kind: b.type === 'image' ? ('image' as const) : kindFromCategory('', b.mediaType ?? ''),
      name: b.filename ?? 'file',
      size: b.size ?? 0,
      url: b.fileId ? uploadUrl(agentId, sessionId, b.fileId) : '',
      mediaType: b.mediaType,
      extractedText: b.extractedText,
    }));
}

// Strip the loop's persistence wrapper from a steer-while-busy note so replay
// shows what the user actually typed (see loop.ts persistNotes).
function unwrapNote(text: string): string {
  return text
    .replace(/^\[Mid-turn note from the user[^\]]*\]\s*/, '')
    .replace(/\s*\[Take it into account\.[^\]]*\]\s*$/, '')
    .trim();
}

export function buildTranscript(raw: RawMessage[], agentId: string, sessionId: string): ChatMessage[] {
  const out: ChatMessage[] = [];
  let current: ChatMessage | null = null; // assistant bubble being grouped

  for (const msg of raw) {
    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const ts = msg.timestamp ? Date.parse(msg.timestamp) || undefined : undefined;

    // Harness background/heartbeat delivery — a framed system seam, never a
    // user bubble (it isn't something the user typed).
    if (msg.role === 'user' && msg.origin === 'system-delivery') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      if (text) {
        out.push({
          id: uuid(),
          role: 'user',
          text,
          parts: [],
          tools: [],
          toolsOpen: false,
          attachments: [],
          streaming: false,
          error: false,
          blank: false,
          origin: 'delivery',
          ts,
        });
        current = null;
      }
      continue;
    }

    // Steer-while-busy note — compact note bubble in chronological position.
    // It interrupts assistant grouping (the continuation is visibly "after").
    if (msg.role === 'user' && msg.origin === 'note') {
      const text = unwrapNote(blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'));
      if (text) {
        out.push({
          id: uuid(),
          role: 'user',
          text,
          parts: [],
          tools: [],
          toolsOpen: false,
          attachments: [],
          streaming: false,
          error: false,
          blank: false,
          origin: 'note',
          noteState: 'delivered',
          ts,
        });
        current = null;
      }
      continue;
    }

    if (msg.role === 'user') {
      // Fill tool results into the open assistant bubble's tools.
      const results = blocks.filter((b) => b.type === 'tool_result');
      if (results.length && current) {
        for (const tr of results) {
          const tool = current.tools.find((t) => t.id === tr.toolUseId);
          if (tool) {
            tool.isError = tr.isError === true;
            tool.status = tool.isError ? 'error' : 'success';
            tool.result = truncate(tr.content ?? '', 2000);
          }
        }
      }

      // A real user turn (text and/or attachments) ends the grouping + renders.
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      const atts = blocksToAttachments(blocks, agentId, sessionId);
      if (text || atts.length) {
        out.push({
          id: uuid(),
          role: 'user',
          text,
          parts: [],
          tools: [],
          toolsOpen: false,
          attachments: atts,
          streaming: false,
          error: false,
          blank: false,
          ts,
        });
        current = null;
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
      const thinking = blocks.filter((b) => b.type === 'thinking').map((b) => b.text ?? '').join('\n');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const atts = blocksToAttachments(blocks, agentId, sessionId);
      if (!text && !thinking && toolUses.length === 0 && atts.length === 0) continue;

      if (!current) {
        current = blankAssistant();
        current.ts = ts;
        out.push(current);
      }

      if (thinking) {
        current.parts.push({ kind: 'thinking', id: uuid(), status: 'done', durationSec: 0, collapsed: true, text: thinking });
      }
      if (text) {
        current.parts.push({ kind: 'text', id: uuid(), active: false, text });
      }
      if (atts.length) current.attachments.push(...atts);
      for (const tc of toolUses) {
        current.tools.push(mkReplayTool(tc));
      }

      // Tools mean a continuation may follow — keep grouping.
      if (toolUses.length === 0) current = null;
    }
  }

  return out;
}

function mkReplayTool(block: RawBlock): ToolCall {
  return {
    id: block.id ?? uuid(),
    name: block.name ?? 'tool',
    input: block.input ?? null,
    result: null,
    isError: false,
    status: 'pending', // upgraded to success/error when its tool_result lands
    label: '',
    tag: '',
    output: '',
    startedAt: 0,
    collapsed: true,
  };
}
