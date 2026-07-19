#!/usr/bin/env bun
/**
 * Phase 2 smoke test — exercise OpenAICodexProvider end-to-end through the
 * normalized ProviderEvent stream. Confirms:
 *   1. Provider constructs with basePath, no apiKey needed
 *   2. ensureValidCodexAccess hot path works (auth comes from .mantle/auth/...)
 *   3. SDK call with our headers + strict input shape gets accepted
 *   4. SSE events map to text_delta / message_end correctly
 *
 *   bun run scripts/codex-provider-smoke.ts
 *
 * Pre-req: `bun run src/cli.ts auth login` has been done.
 */

import { OpenAICodexProvider } from "../src/agent/providers/openai-codex.js";

const provider = new OpenAICodexProvider(process.cwd());

const t0 = Date.now();
let firstEventAt: number | null = null;
let textOut = "";
const events: string[] = [];

console.log("[smoke] Streaming a single-turn 'say hello' through OpenAICodexProvider...\n");

for await (const event of provider.stream({
  model: "gpt-5.6-luna",
  systemPrompt: { stable: "You are a terse assistant. Respond with one word." },
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Reply with just one word: Hello." }],
    },
  ],
  tools: [],
})) {
  if (firstEventAt === null) firstEventAt = Date.now();
  switch (event.type) {
    case "text_delta":
      textOut += event.text;
      events.push(`text_delta(${JSON.stringify(event.text)})`);
      break;
    case "thinking_delta":
      events.push(`thinking_delta(${event.text.length}chars)`);
      break;
    case "thinking_end":
      events.push("thinking_end");
      break;
    case "tool_call_start":
      events.push(`tool_call_start(${event.name}, ${event.id})`);
      break;
    case "tool_call_delta":
      events.push(`tool_call_delta(${event.id})`);
      break;
    case "tool_call_end":
      events.push(`tool_call_end(${event.id})`);
      break;
    case "message_end":
      events.push(`message_end(${event.stopReason}, in=${event.usage.inputTokens}, out=${event.usage.outputTokens}, cache=${event.usage.cacheReadTokens})`);
      break;
    case "error":
      events.push(`error(${event.error})`);
      break;
  }
}

const totalMs = Date.now() - t0;
const ttfbMs = firstEventAt !== null ? firstEventAt - t0 : null;

console.log("[smoke] Events received (in order):");
for (const e of events) console.log(`  - ${e}`);
console.log("\n[smoke] Assembled assistant text:", JSON.stringify(textOut));
console.log("[smoke] TTFB:", ttfbMs, "ms");
console.log("[smoke] Total:", totalMs, "ms");
