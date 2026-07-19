import { resolve } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { AgentConfig } from "../config/schema.js";

// Shared template rendering for an agent's workspace files. Both new-agent
// scaffolding (api-agents) and per-file create-from-template (api-workspace-
// files) go through here, so the two can never render `{{placeholders}}`
// differently — the drift that birthed the Personality tab in the first place.

// Substitute `{{key}}` placeholders; an unknown key is left verbatim so a
// missing var is visible in the output rather than silently blanked.
export function renderTemplate(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_match, key) => vars[key] ?? `{{${key}}}`);
}

// The template variables baked into an agent's workspace files at CREATION
// time. These are immutable per-agent: `name` (the agent's own name) and
// `date` (when it was hatched); `accent` falls back to the seed accent used at
// first scaffold. `user` is deliberately NOT here — the human's preferred name
// is resolved LIVE at prompt-build time (prompt-builder.ts setUserName), so
// `{{user}}` is left verbatim in the scaffolded files and reflects the current
// Settings → You profile on every turn rather than freezing at creation.
export function templateVars(
  opts: { name: string; accent?: string },
): Record<string, string> {
  return {
    name: opts.name.trim(),
    date: new Date().toISOString().slice(0, 10),
    accent: opts.accent || "#00d4aa",
  };
}

// Create a single workspace file from its template, rendered for THIS agent,
// and write it into the workspace. Returns the rendered content. Throws if no
// template exists for the filename. Powers the Personality tab's "create from
// template" button — the same templates new-agent creation copies.
export function scaffoldWorkspaceFile(
  basePath: string,
  agent: AgentConfig,
  filename: string,
): string {
  const templatePath = resolve(basePath, "templates", "agent-workspace", filename);
  if (!existsSync(templatePath)) {
    throw new Error(`No template for ${filename}`);
  }
  const raw = readFileSync(templatePath, "utf-8");
  const content = renderTemplate(
    raw,
    templateVars({ name: agent.name, accent: agent.accentColor }),
  );
  writeFileSync(resolve(agent.workspace, filename), content, "utf-8");
  return content;
}
