// The POV transcript transform — THE core trick that lets one shared,
// multi-party channel transcript be replayed from a single agent's point of
// view, so that agent answers in character as itself.
//
// For speaking agent X over the shared rows:
//   - X's own rows replay AS AUTHORED: assistant rows stay `assistant` (text +
//     tool_use kept), X's tool_result rows stay `user` (tool_result kept) — so
//     X's own recall round-trips actually return to it mid-turn. Rows are
//     author-stamped at append time (ChannelSessionManager), so "own" is
//     decidable even for in-progress rows.
//   - every other row (the user AND other agents) → `user`, with text blocks
//     prefixed "Name: " so X can tell who said what. Others' tool traffic is
//     dropped — it isn't X's to answer.
//   - runs of consecutive same-role messages COLLAPSE into ONE message
//     (block-joined) so the provider sees strict user/assistant alternation
//   - only the newest rows that fit MAX_PROJECTED_CHARS are replayed (the
//     channel has no compaction; without a window the projection grows until
//     the provider's context hard-fails)
//
// The collapse is the load-bearing correctness property: without it, two
// adjacent non-X rows would emit two consecutive `user` messages and the
// provider 400s. A final sanitizeProviderMessages pass (shared with the core
// SessionManager) drops tool pairs broken by the window cut or an aborted
// sub-turn, for the same reason.
//
// Runs in runAgentLoop's `transformMessages` hook (which replaces the base
// transcript), reading the RAW author-tagged channel rows — so the core loop
// and SessionManager are untouched.

import type { ProviderMessage, MessageContent } from "../../agent/providers/types.js";
import { sanitizeProviderMessages } from "../../agent/session.js";
import { getUserName } from "../../agent/prompt-builder.js";
import type { ChannelMessage } from "./types.js";

// How much of the shared transcript a speaker replays, counted in content
// chars from the newest row backwards (~12k tokens at 4 chars/token). A
// hangout reply needs recent context, not the whole history; this also keeps
// per-sub-turn cost flat as a channel ages. Rows past the window are replaced
// by a single omission marker.
const MAX_PROJECTED_CHARS = 48_000;

// Approximate a row's projected size. Cheap and slightly generous (others'
// tool traffic gets dropped later) — precision doesn't matter here, only that
// the window can't blow the context.
function rowChars(row: ChannelMessage): number {
  let n = 40; // per-row overhead so degenerate zero-text rows still count
  for (const b of row.content) {
    if (b.type === "text" || b.type === "thinking") n += b.text.length;
    else if (b.type === "tool_result") n += b.content.length;
    else if (b.type === "tool_use") n += JSON.stringify(b.input).length;
  }
  return n;
}

export function projectForAgent(rows: ChannelMessage[], selfId: string): ProviderMessage[] {
  // Whisper boundary FIRST (before the window, so invisible rows can't eat
  // the char budget): a whisper-scoped row exists only for the user + the
  // agents in its `to` set. For everyone else the aside never happened — the
  // role-collapse below then merges the rows around the hole seamlessly.
  // Own rows always survive (an agent is by construction in the scope of
  // every whisper row it authored; the self check is belt-and-suspenders).
  rows = rows.filter((row) => {
    if (!row.whisper) return true;
    if (row.author?.kind === "agent" && row.author.agentId === selfId) return true;
    return row.whisper.to.includes(selfId);
  });

  // Window: walk back from the newest row until the char budget is spent.
  // Always include at least the final row (a single pathological row larger
  // than the whole budget must still be sent — truncation.ts already caps
  // tool results, so in practice this is a user paste).
  let start = rows.length;
  let used = 0;
  while (start > 0 && used + rowChars(rows[start - 1]) <= MAX_PROJECTED_CHARS) {
    used += rowChars(rows[start - 1]);
    start--;
  }
  if (start === rows.length && rows.length > 0) start = rows.length - 1;
  const omitted = start > 0;

  const out: ProviderMessage[] = [];

  for (const row of rows.slice(start)) {
    const isSelf = row.author?.kind === "agent" && row.author.agentId === selfId;

    let role: "assistant" | "user";
    let blocks: MessageContent[];
    if (isSelf) {
      // Own rows replay as authored. Assistant rows keep text + tool_use;
      // tool_result rows (persisted role "user", Anthropic convention) keep
      // their tool_result blocks. Thinking stays private.
      role = row.role === "assistant" ? "assistant" : "user";
      blocks = row.content.filter((b) => b.type !== "thinking");
    } else {
      // Prefix every text block with the speaker's name so X can tell who
      // said what. Other content (other agents' tool_use/tool_result, images)
      // is dropped — recall-only tools make these rare and they aren't X's
      // to answer.
      role = "user";
      const name = row.author?.kind === "agent" ? row.author.name : getUserName();
      blocks = [];
      for (const b of row.content) {
        if (b.type === "text" && b.text.trim()) {
          blocks.push({ type: "text", text: `${name}: ${b.text}` });
        }
      }
    }

    if (blocks.length === 0) continue; // skip empty rows (e.g. thinking-only)

    // Coalesce into the previous message when the role matches — collapses
    // consecutive non-self rows (the common case) AND self tool_result rows
    // followed by another speaker's text (tool_result blocks stay FIRST in
    // the merged user message, which Anthropic requires — a non-self row can
    // never precede its own pair's tool_result on disk because a sub-turn has
    // exactly one writer). This guarantees strict user/assistant alternation
    // by construction — the provider 400s otherwise.
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  }

  // Heal tool pairs broken by the window cut or an aborted sub-turn (an
  // assistant tool_use whose tool_result never landed) — same rules the core
  // SessionManager applies to 1:1 transcripts.
  const { messages: clean } = sanitizeProviderMessages(out);

  // The provider conversation must open on a user turn. An unwindowed
  // transcript always does (the user's message is appended before any agent
  // turn); a windowed one can open mid-volley on a self row. The marker also
  // tells the model why older context is missing. Unshifting text into an
  // existing user message is safe — a leading valid tool_result can't survive
  // sanitation without its assistant partner before it, so clean[0] (user)
  // never starts with one.
  if (omitted || clean[0]?.role === "assistant") {
    const marker: MessageContent = {
      type: "text",
      text: "[Earlier channel history omitted — replying to the recent conversation.]",
    };
    if (clean[0]?.role === "user") clean[0].content.unshift(marker);
    else clean.unshift({ role: "user", content: [marker] });
  }

  return clean;
}
