import type { Tool } from "../types.js";
import type { MantleConfig } from "../../config/schema.js";
import { getAgent } from "../../config/loader.js";
import { CATALOG, configuredBackends } from "../../agent/providers/catalog.js";
import type { EnglyphManager } from "../../englyph/manager.js";
import type { VoiceManager } from "../../voice/manager.js";
import type { LocalModelManager } from "../../local/manager.js";

// Read-only introspection of the running MANTLE install — the agent-facing
// counterpart to the Connections settings tab (/api/connections) plus the
// config/backend summary. Lets an agent answer "is my setup working / what do
// I have" for the user before touching anything. It reads the SAME sources the
// REST surface does (CATALOG / configuredBackends / the subsystem managers);
// only the presentation differs (markdown for the model, JSON for the UI), so
// there's nothing to share — the source functions already are.
export interface MantleStatusDeps {
  englyphManager?: EnglyphManager;
  voiceManager?: VoiceManager;
  localModelManager?: LocalModelManager;
}

export function createMantleStatusTool(config: MantleConfig, deps: MantleStatusDeps): Tool {
  const { englyphManager, voiceManager, localModelManager } = deps;

  // The backend an agent resolves to for display — its own override, else the
  // global default. (Honest config read, not the full per-turn resolution.)
  const agentBackend = (agentId?: string) => {
    const agent = agentId ? getAgent(config, agentId) : undefined;
    return {
      name: agent?.name ?? agentId ?? "this agent",
      provider: agent?.defaultProvider ?? config.defaultProvider ?? "(unset)",
      model: agent?.defaultModel ?? null,
    };
  };

  return {
    name: "mantle_status",
    description: `Read-only introspection of this MANTLE install — answer "is my setup working / what do I have" before changing anything. Areas:
- overview (default): a health digest across inference, memory (Englyph), voice, and local models, plus the agent count
- backends: the inference catalog — which vendor×mode backends are configured, the defaults, and this agent's backend/model
- agents: the configured agents and the backend each uses
- local: the local-model runtime — is the binary present, which models are registered, which is loaded`,
    inputSchema: {
      type: "object",
      properties: {
        area: {
          type: "string",
          enum: ["overview", "backends", "agents", "local"],
          description: "Which slice to read. Default: overview.",
        },
      },
      required: [],
    },
    async execute(input, context) {
      const area = typeof input.area === "string" ? input.area : "overview";

      if (area === "backends") {
        const ready = configuredBackends(config, { localModelManager });
        const me = agentBackend(context?.agentId);
        const lines = CATALOG.map((b) => {
          const ok = b.isConfigured(config, { localModelManager });
          const isDefault = b.id === config.defaultProvider ? " (global default)" : "";
          return `- \`${b.id}\` — ${b.label} — ${ok ? "configured" : "not configured"}${isDefault}`;
        });
        return {
          content:
            `# Inference backends (${ready.length}/${CATALOG.length} configured)\n\n` +
            `Global default: \`${config.defaultProvider ?? "(unset)"}\`. ` +
            `This agent (${me.name}): \`${me.provider}\`${me.model ? ` / ${me.model}` : ""}.\n\n` +
            lines.join("\n"),
        };
      }

      if (area === "agents") {
        const agents = config.agents ?? [];
        if (agents.length === 0) return { content: "No agents are configured." };
        const lines = agents.map((a) => {
          const provider = a.defaultProvider ?? config.defaultProvider ?? "(unset)";
          const model = a.defaultModel ? ` / ${a.defaultModel}` : "";
          const isDefault = a.id === config.defaultAgent ? " — default" : "";
          return `- **${a.name}** (\`${a.id}\`)${isDefault} — \`${provider}\`${model}`;
        });
        return { content: `# Agents (${agents.length})\n\n${lines.join("\n")}` };
      }

      if (area === "local") {
        const enabled = config.localModels?.enabled ?? false;
        const hasBinary = localModelManager?.hasBinary() ?? false;
        const binPath = localModelManager?.binaryPathAbs() ?? "";
        const ids = localModelManager?.listModelIds() ?? [];
        const active = localModelManager?.status().activeModelId ?? null;
        const def = localModelManager?.getDefaultModelId() ?? null;
        const head =
          `# Local models\n\n` +
          `Enabled: ${enabled ? "yes" : "no"}. ` +
          `Runtime binary: ${hasBinary ? "present" : `MISSING (${binPath})`}. ` +
          `${ids.length} model(s) registered${def ? `, default \`${def}\`` : ""}. ` +
          `Active (loaded): ${active ?? "none"}.`;
        if (ids.length === 0) return { content: head };
        const lines = ids.map((id) => {
          const tags = [id === active ? "loaded" : "", id === def ? "default" : ""].filter(Boolean);
          return `- \`${id}\`${tags.length ? ` (${tags.join(", ")})` : ""}`;
        });
        return { content: `${head}\n\n${lines.join("\n")}` };
      }

      // overview (default)
      const ready = configuredBackends(config, { localModelManager });
      const me = agentBackend(context?.agentId);

      let englyphReachable = false;
      if (config.englyph?.enabled && englyphManager) {
        try {
          englyphReachable = await englyphManager.probeDaemon();
        } catch {
          englyphReachable = false;
        }
      }
      const englyphLine = !config.englyph?.enabled
        ? "disabled"
        : englyphReachable
          ? "up"
          : "enabled but UNREACHABLE (daemon not responding)";

      const voiceEnabled = voiceManager?.isEnabled() ?? false;
      const voiceAlive = voiceManager?.isAlive() ?? false;
      const voiceLine = !voiceEnabled
        ? "disabled"
        : voiceAlive
          ? "running"
          : "enabled but NOT running (sidecar down)";

      const localEnabled = config.localModels?.enabled ?? false;
      const localModels = localModelManager?.listModelIds().length ?? 0;
      const localBinary = localModelManager?.hasBinary() ?? false;
      const localActive = localModelManager?.status().activeModelId ?? null;
      const localLine = !localEnabled
        ? "disabled"
        : `${localModels} registered, ${localBinary ? "binary present" : "binary MISSING"}${localActive ? `, \`${localActive}\` loaded` : ""}`;

      const agentCount = (config.agents ?? []).length;

      return {
        content:
          `# rev://MANTLE — status overview\n\n` +
          `- **Inference:** ${ready.length}/${CATALOG.length} backends configured. This agent (${me.name}) uses \`${me.provider}\`${me.model ? ` / ${me.model}` : " (provider default)"}.\n` +
          `- **Memory (Englyph):** ${englyphLine}.\n` +
          `- **Voice (TTS sidecar):** ${voiceLine}.\n` +
          `- **Local models:** ${localLine}.\n` +
          `- **Agents:** ${agentCount} configured.\n\n` +
          `Use \`mantle_status\` with area \`backends\`, \`agents\`, or \`local\` for detail.`,
      };
    },
  };
}
