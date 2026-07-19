import type { McpClient } from "./client.js";
import type { ToolRegistry } from "../registry.js";
import { wrapUntrusted } from "../untrusted.js";

// Bridge MCP tools into the MANTLE tool registry. `source` stamps the
// registered tools' provenance (e.g. "mcp:brave") for the UI catalog.
export function bridgeMcpTools(client: McpClient, registry: ToolRegistry, prefix?: string, source?: string): number {
  const defs = client.getToolDefinitions();
  let count = 0;

  // All Englyph tools register into the registry. Filtering of what the
  // AGENT sees happens at agent-exposure time (see ws.ts handleChat),
  // so internal machinery (like the pre-inference pack builder) can
  // still dispatch tools the agent can't see.
  for (const def of defs) {
    const toolName = prefix ? `${prefix}_${def.name}` : def.name;

    // Skip if already registered (core tools take precedence)
    if (registry.has(toolName)) {
      console.log(`[MANTLE:mcp] Skipping ${toolName} (already registered)`);
      continue;
    }

    registry.register({
      name: toolName,
      description: def.description,
      inputSchema: def.inputSchema,
      source,
      execute: async (input, context) => {
        const signal = context?.signal;
        try {
          if (signal?.aborted) {
            return { content: `MCP tool aborted before call: ${def.name}`, isError: true };
          }
          // Signal is plumbed into the client now — on abort, the
          // pending request entry is deleted from the client's map
          // immediately and a late response over stdout is no-op'd.
          // The MCP 2024-11-05 protocol still lacks a server-side
          // cancel notification so the server keeps running, but we
          // stop holding the client-side state (the prior leak).
          const result = await client.callTool(def.name, input, { signal });
          // MCP servers return external, untrusted content (web search, fetched
          // pages, etc.) — frame it as data, not instructions.
          return { content: wrapUntrusted(result, `the "${source ?? toolName}" MCP tool`) };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: `MCP tool error (${def.name}): ${message}`, isError: true };
        }
      },
    });

    count++;
  }

  return count;
}
