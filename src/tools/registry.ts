import type { Tool, ToolContext, ToolResult } from "./types.js";
import type { ToolDefinition } from "../agent/providers/types.js";
import { classifyToolResult } from "./result-classification.js";

// Lightweight JSON-Schema validator targeting the subset of schemas
// tools declare in mantle today: object with properties + required.
// Not a general-purpose validator — covers required-field presence
// and basic type matching, which catches >95% of real-world bad-args
// failures (the model dropped a required field, or sent a number
// where a string was expected). Nested properties, enums, min/max,
// format strings, anyOf/oneOf — all unchecked; the tool's own
// execute() is still the last line of defense.
function validateInput(input: Record<string, unknown>, schema: Record<string, unknown>): string | null {
  if (!schema || typeof schema !== "object") return null;
  const properties = (schema.properties as Record<string, { type?: string | string[] }> | undefined) ?? {};
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  // Required-field check. `null`/`undefined` count as missing —
  // `0`/`""`/`false` are legitimately present and pass through.
  for (const field of required) {
    const v = input[field];
    if (v === undefined || v === null) {
      return `missing required parameter \`${field}\``;
    }
  }

  // Type check for declared properties. Tools without a `type` field
  // in their property definition skip this — the validator stays
  // permissive when the schema doesn't constrain. JSON Schema allows
  // `type` to be a string OR an array of strings; we handle both.
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue; // null/undefined already gated by required
    const def = properties[field];
    if (!def?.type) continue;
    const expected = Array.isArray(def.type) ? def.type : [def.type];
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (!expected.some((t) => typeMatches(actual, t))) {
      return `parameter \`${field}\` must be ${expected.join(" or ")}, got ${actual}`;
    }
  }

  return null;
}

function typeMatches(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  // JSON Schema "integer" — JS doesn't distinguish int from float at
  // typeof level, so we accept "number" as a match. Strict integer
  // validation would need a value-level isInteger check; the tool's
  // own logic typically handles that more usefully (e.g., `Number(x)`
  // with NaN check), so we let it through here.
  if (expected === "integer" && actual === "number") return true;
  return false;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    console.log(`[MANTLE:tools] Registered: ${tool.name}`);
  }

  registerMany(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  // Returns tool definitions formatted for the LLM provider API (no execute function)
  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  // Returns tool name + description pairs for the system prompt
  getDescriptions(): string[] {
    return Array.from(this.tools.values()).map(
      (t) => `**${t.name}**: ${t.description}`
    );
  }

  // Full catalog incl. provenance — for the UI/management surface ONLY
  // (getDefinitions stays provider-shaped; source must never reach a model
  // request payload).
  getCatalog(): Array<ToolDefinition & { source: string }> {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      source: t.source ?? "core",
    }));
  }

  async execute(name: string, input: Record<string, unknown>, context?: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    // Stamp every return path with a {status, tag} via the pure classifier so
    // the loop-detector (failing-tool signal) and the UI chip get a richer
    // signal than the bare isError boolean. classifyToolResult tolerates an
    // unknown tool name (the not-found path below).
    const stamp = (r: ToolResult): ToolResult => {
      const c = classifyToolResult(name, r);
      return { ...r, status: c.status, tag: c.tag };
    };

    // Execution-time allow-list gate. When the caller constrained the tool
    // surface (cron / triggered runs stamp context.allowedToolNames with the
    // ADVERTISED set), a tool that wasn't advertised must not run. Advertisement
    // filtering alone is advisory — a prompt-injected autonomous model can emit
    // ANY registered tool name (bash/write_file/englyph_research) regardless of
    // what it was offered, and the bare registry lookup below would happily run
    // it. This turns "excluded by omission" into a real deny. Unconstrained
    // turns (chat, the companion cron preset) leave allowedToolNames undefined,
    // so the full registry surface still applies. Pseudo-tools are intercepted
    // by the loop BEFORE reaching the registry, so they're never blocked here.
    if (context?.allowedToolNames && !context.allowedToolNames.includes(name)) {
      return stamp({
        content: `Tool "${name}" is not in this run's allowed tool surface and was blocked. This scheduled/triggered run was granted a restricted set of tools; ${name} is not among them.`,
        isError: true,
      });
    }

    if (!tool) {
      return stamp({ content: `Unknown tool: ${name}`, isError: true });
    }

    // JSON parse-fail short-circuit. The agent loop tags input with
    // `_parseError: true` when it couldn't parse the model's
    // tool_use args block. Without this branch, validateInput sees
    // an object with `_raw`/`_parseError` instead of the real args
    // and reports "missing required parameter X" — which makes the
    // model think it forgot a field when really its whole JSON was
    // malformed. Surface the actual symptom + the raw text so the
    // model can see and fix what it emitted. Grok's biggest tool-use
    // failure mode is this exact case (trailing prose after the
    // JSON object, missing closing braces, unescaped quotes).
    if (input._parseError === true) {
      const raw = typeof input._raw === "string" ? input._raw : "";
      const truncated = raw.length > 500 ? raw.slice(0, 500) + "...[truncated]" : raw;
      return stamp({
        content:
          `Invalid JSON in tool arguments for \`${name}\`. Your arguments couldn't be parsed as JSON. ` +
          `Raw text you sent (${raw.length} chars):\n\n${truncated}\n\n` +
          `Make sure your arguments are a valid JSON object like {"path": "..."}. ` +
          `Common issues: trailing prose after the JSON, missing closing braces, unescaped quotes inside strings.`,
        isError: true,
      });
    }

    // Validate input against the tool's declared inputSchema BEFORE
    // dispatching. Without this, a model that emits bad JSON args
    // (Grok's most common failure mode) hits the tool's own error
    // handling — which usually surfaces as "Tool error: <something>"
    // with no hint about what's wrong. Pre-validation returns a
    // structured message naming the offending field, which the
    // model can act on next iteration.
    const validationError = validateInput(input, tool.inputSchema);
    if (validationError) {
      return stamp({ content: `Invalid arguments for ${name}: ${validationError}`, isError: true });
    }

    try {
      return stamp(await tool.execute(input, context));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return stamp({ content: `Tool error (${name}): ${message}`, isError: true });
    }
  }

  get size(): number {
    return this.tools.size;
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }
}
