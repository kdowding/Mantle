// Standalone smoke test for the xAI Realtime client.
//
// Run with:
//   bun run src/realtime/smoke-test.ts
//
// Reads XAI_API_KEY from env or .mantle/config.json (providers.grok.apiKey).
// Opens a WS to wss://api.x.ai/v1/realtime, sends a session.update with
// minimal instructions, asks the model to say one short sentence via
// text input, then prints every server event for ~15 seconds before
// closing. Audio chunks are reported by size only (not printed).
//
// Costs roughly $0.01-$0.02 per run depending on response length. NOT
// part of mantle's normal lifecycle; invoke manually to validate the
// connection + auth + protocol.

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { RealtimeClient } from "./client.js";
import type { ServerEvent } from "./protocol.js";

function loadApiKey(): string {
  if (process.env.XAI_API_KEY) return process.env.XAI_API_KEY;

  const configPath = resolve(process.cwd(), ".mantle", "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const key = config?.providers?.grok?.apiKey;
      if (typeof key === "string" && key.length > 0) return key;
    } catch {
      // fall through to error
    }
  }
  throw new Error(
    "Set XAI_API_KEY env var or configure providers.grok.apiKey in .mantle/config.json",
  );
}

async function main(): Promise<void> {
  const apiKey = loadApiKey();
  console.log("[smoke] connecting to wss://api.x.ai/v1/realtime ...");

  let eventCount = 0;
  let audioBytesIn = 0;
  let textOut = "";

  const client = new RealtimeClient({
    apiKey,
    model: "grok-voice-latest",
    debugLogPrefix: "[smoke]",
    onEvent: (event: ServerEvent) => {
      eventCount++;
      // xAI renamed the audio events to `response.output_audio.*`
      // (2026-05); the old `response.audio.*` names are matched too so
      // this stays useful against either protocol generation.
      if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
        const d = (event as { delta?: string }).delta ?? "";
        audioBytesIn += d.length;
      } else if (
        event.type === "response.audio_transcript.delta" ||
        event.type === "response.output_audio_transcript.delta"
      ) {
        const d = (event as { delta?: string }).delta ?? "";
        textOut += d;
        process.stdout.write(d);
      } else if (event.type === "response.text.delta") {
        const d = (event as { delta?: string }).delta ?? "";
        textOut += d;
        process.stdout.write(d);
      } else if (event.type === "error") {
        const err = (event as { error?: { message?: string } }).error;
        console.error("\n[smoke] ! error:", JSON.stringify(err, null, 2));
      }
    },
    onOpen: () => console.log("[smoke] WS opened"),
    onClose: (code, reason) =>
      console.log(`[smoke] WS closed code=${code} reason="${reason || "—"}"`),
    onError: (err) => console.error("[smoke] error callback:", err.message),
  });

  await client.open();
  console.log("[smoke] WS upgrade complete — sending session.update");

  client.updateSession({
    modalities: ["text", "audio"],
    instructions: "You are a brief test assistant. Reply with one short sentence.",
    voice: "eve",
    output_audio_format: "audio/pcm",
    output_audio_sample_rate: 24000,
    turn_detection: { type: "server_vad" },
  });

  setTimeout(() => {
    console.log("\n[smoke] → user text: \"Say hello in one short sentence.\"");
    client.sendUserText("Say hello in one short sentence.");
  }, 500);

  setTimeout(() => {
    console.log(
      `\n[smoke] summary: ${eventCount} events, ${audioBytesIn}b audio (b64), ` +
      `transcript=${JSON.stringify(textOut.trim())}`,
    );
    console.log("[smoke] closing");
    client.close();
    setTimeout(() => process.exit(0), 250);
  }, 15000);
}

main().catch((err: unknown) => {
  console.error("[smoke] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
