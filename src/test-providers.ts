/**
 * Manual provider stream check.
 * Streams one response from a configured backend to confirm wiring.
 *
 * Usage: bun run src/test-providers.ts [claude|grok|both]
 */
import { loadConfig } from "./config/loader.js";
import { resolveProviderTurn } from "./agent/providers/catalog.js";
import type { Provider } from "./agent/providers/types.js";
import { resolve } from "path";

const BASE_PATH = resolve(import.meta.dir, "..");
const config = loadConfig(BASE_PATH);

async function testProvider(provider: Provider, model: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${provider.name} (${model})`);
  console.log("=".repeat(60));

  const stream = provider.stream({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello! Who are you? Reply in one sentence." }],
      },
    ],
    systemPrompt: "You are a helpful AI assistant called MANTLE. Be brief.",
    tools: [],
    model,
  });

  process.stdout.write("\nResponse: ");
  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.text);
        break;
      case "message_end":
        console.log(`\n\nStop reason: ${event.stopReason}`);
        console.log(`Usage: ${event.usage.inputTokens} in / ${event.usage.outputTokens} out`);
        break;
      case "error":
        console.error(`\nError: ${event.error}`);
        break;
    }
  }
}

async function runOne(label: string, requestedProvider: string) {
  const resolved = resolveProviderTurn(config, {}, {
    requestedProvider,
    globalDefaultProvider: config.defaultProvider,
  });
  if (!resolved.ok) {
    console.error(`\n${label}: ${resolved.error}`);
    return;
  }
  await testProvider(resolved.provider, resolved.model);
}

async function main() {
  const target = process.argv[2] ?? "both";
  if (target === "claude" || target === "both") await runOne("Claude", "claude");
  if (target === "grok" || target === "both") await runOne("Grok", "grok");
  console.log("\nDone.");
}

main();
