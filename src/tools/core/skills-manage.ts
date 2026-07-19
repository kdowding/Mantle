import type { Tool } from "../types.js";
import type { MantleConfig } from "../../config/schema.js";
import { getAgent, saveConfig } from "../../config/loader.js";
import { discoverSkills } from "../../skills/loader.js";
import { resolve } from "path";
import { existsSync, rmSync } from "fs";

const DIR_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

// Skill lifecycle management (the records, not the content). Creating/editing a
// SKILL.md's body is the deck editor / diff flow; this is list / delete /
// enable / disable. Acts on the calling agent (ToolContext.agentId).
export function createSkillsManageTool(config: MantleConfig): Tool {
  return {
    name: "skills_manage",
    description: `Manage this agent's skills — lifecycle records, not content. A skill is a directory with a SKILL.md (frontmatter: name, description — description is REQUIRED, or the skill is invisible) whose body you read on demand. Actions:
- list: every skill (agent + global) with scope + enabled state
- delete: remove a skill directory — needs scope (agent|global) + dir. Destructive.
- enable / disable: turn a skill on/off FOR THIS AGENT, by name.

This tool does not write skill bodies. To CREATE one yourself, write_file a SKILL.md at {workspace}/skills/<dir>/SKILL.md (yours alone) or the global skills/ root (shared by every agent), with at least name + description frontmatter — discovery is live, so it exists on your next turn. That's usually right when the user asks you to "learn" or save a repeatable behavior. Full guide: mantle_guide docs/agent-manual/feature/skills.md.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "delete", "enable", "disable"], description: "What to do" },
        scope: { type: "string", enum: ["agent", "global"], description: "For delete: which skills root" },
        dir: { type: "string", description: "For delete: the skill's directory name" },
        name: { type: "string", description: "For enable/disable: the skill name" },
      },
      required: ["action"],
    },
    async execute(input, context) {
      const agentId = context?.agentId;
      const agent = agentId ? getAgent(config, agentId) : undefined;
      if (!agent) return { content: "No acting agent.", isError: true };
      const action = String(input.action);

      if (action === "list") {
        const skills = discoverSkills(config, agent);
        if (skills.length === 0) return { content: "No skills." };
        const globalDisabled = new Set(config.skills?.disabled ?? []);
        const agentDisabled = new Set(agent.disabledSkills ?? []);
        const agentEnabled = new Set(agent.enabledSkills ?? []);
        const lines = skills.map((s) => {
          const off = (agentDisabled.has(s.name) || (globalDisabled.has(s.name) && !agentEnabled.has(s.name)));
          const scope = s.source === "global" ? "global" : "agent";
          return `- ${s.name} [${scope}] ${off ? "(disabled)" : "(enabled)"}`;
        });
        return { content: lines.join("\n") };
      }

      if (action === "delete") {
        const scope = input.scope === "global" ? "global" : input.scope === "agent" ? "agent" : null;
        const dir = typeof input.dir === "string" ? input.dir.trim() : "";
        if (!scope) return { content: "delete needs scope 'agent' or 'global'.", isError: true };
        if (!DIR_RE.test(dir)) return { content: "Invalid skill dir.", isError: true };
        const root = scope === "global" ? resolve(config.globalSkillsDir) : resolve(agent.workspace, "skills");
        const skillDir = resolve(root, dir);
        if (!existsSync(skillDir)) return { content: `Skill ${scope}/${dir} not found.`, isError: true };
        rmSync(skillDir, { recursive: true, force: true });
        return { content: `Deleted skill ${scope}/${dir}.` };
      }

      if (action === "enable" || action === "disable") {
        const name = typeof input.name === "string" ? input.name.trim() : "";
        if (!name) return { content: `${action} needs a skill name.`, isError: true };
        // Per-agent override (same precedence the toggle endpoint uses).
        agent.disabledSkills = (agent.disabledSkills ?? []).filter((n) => n !== name);
        agent.enabledSkills = (agent.enabledSkills ?? []).filter((n) => n !== name);
        if (action === "disable") agent.disabledSkills.push(name);
        else agent.enabledSkills.push(name);
        const dis = [...agent.disabledSkills], en = [...agent.enabledSkills];
        saveConfig(config.basePath, (raw) => {
          const ra = raw.agents?.find((a: { id?: string }) => a.id === agentId);
          if (!ra) return;
          ra.disabledSkills = dis.length ? dis : undefined;
          ra.enabledSkills = en.length ? en : undefined;
        });
        return { content: `${action === "disable" ? "Disabled" : "Enabled"} skill "${name}" for ${agent.name}.` };
      }

      return { content: `Unknown action: ${action}`, isError: true };
    },
  };
}
