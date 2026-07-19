// GitHub native tools — the thin adapter the agent sees. Each tool pulls the
// CALLING agent's token from the broker (keyed by context.agentId) and calls
// the engine in api.ts, returning a compact, model-friendly view. Stamped
// source:"integration:github" so the UI groups them; the model can't tell
// these from any other tool.

import type { Tool, ToolResult } from "../../tools/types.js";
import type { TokenBroker } from "../types.js";
import * as gh from "./api.js";

const SOURCE = "integration:github";
const INTEGRATION_ID = "github";

function fail(message: string): ToolResult {
  return { content: message, isError: true };
}

async function tokenFor(broker: TokenBroker, agentId?: string): Promise<string> {
  if (!agentId) throw new Error("no agent context (context.agentId missing)");
  return broker.getAccessToken(INTEGRATION_ID, agentId);
}

export const GITHUB_WRITE_TOOLS = ["github_create_issue"];

export function createGithubTools(broker: TokenBroker): Tool[] {
  return [
    {
      name: "github_list_repos",
      description:
        "List the GitHub repositories the connected account can access (owner, collaborator, or org member), most-recently-updated first. Use to discover the 'owner/repo' full-names the other github_* tools take.",
      source: SOURCE,
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max repos to return (1-100, default 30)." },
        },
      },
      execute: async (input, ctx): Promise<ToolResult> => {
        try {
          const repos = await gh.listRepos(await tokenFor(broker, ctx?.agentId), {
            limit: typeof input.limit === "number" ? input.limit : undefined,
          });
          if (repos.length === 0) return { content: "No repositories found." };
          const lines = repos.map(
            (r) =>
              `- ${r.fullName}${r.private ? " (private)" : ""} - ${r.description ?? "no description"} [${r.language ?? "?"}, *${r.stars}]`,
          );
          return { content: `${repos.length} repo(s):\n${lines.join("\n")}` };
        } catch (e) {
          return fail(`github_list_repos failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: "github_get_repo",
      description:
        "Get details for one repository (description, stars, open-issue count, default branch, topics). Args: owner, repo.",
      source: SOURCE,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string", description: "Repo owner (user or org)." },
          repo: { type: "string", description: "Repository name." },
        },
        required: ["owner", "repo"],
      },
      execute: async (input, ctx): Promise<ToolResult> => {
        try {
          const owner = String(input.owner ?? "");
          const repo = String(input.repo ?? "");
          if (!owner || !repo) return fail("owner and repo are required.");
          const r = await gh.getRepo(await tokenFor(broker, ctx?.agentId), owner, repo);
          return {
            content: [
              `${r.fullName}${r.private ? " (private)" : ""}`,
              r.description ?? "(no description)",
              `stars ${r.stars} - forks ${r.forks} - open issues ${r.openIssues}`,
              `default branch: ${r.defaultBranch} - language: ${r.language ?? "?"}`,
              r.topics.length ? `topics: ${r.topics.join(", ")}` : "",
              r.url,
            ]
              .filter(Boolean)
              .join("\n"),
          };
        } catch (e) {
          return fail(`github_get_repo failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: "github_list_issues",
      description:
        "List issues (and PRs) for a repository as a compact summary. Args: owner, repo, state (open|closed|all, default open), limit.",
      source: SOURCE,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
          limit: { type: "number", description: "Max items (1-100, default 20)." },
        },
        required: ["owner", "repo"],
      },
      execute: async (input, ctx): Promise<ToolResult> => {
        try {
          const owner = String(input.owner ?? "");
          const repo = String(input.repo ?? "");
          if (!owner || !repo) return fail("owner and repo are required.");
          const state =
            input.state === "closed" || input.state === "all" ? input.state : "open";
          const issues = await gh.listIssues(await tokenFor(broker, ctx?.agentId), owner, repo, {
            state,
            limit: typeof input.limit === "number" ? input.limit : undefined,
          });
          if (issues.length === 0) return { content: `No ${state} issues in ${owner}/${repo}.` };
          const lines = issues.map(
            (i) =>
              `#${i.number} [${i.isPullRequest ? "PR" : i.state}] ${i.title} - @${i.author ?? "?"}${i.labels.length ? ` (${i.labels.join(", ")})` : ""}`,
          );
          return { content: `${issues.length} item(s) in ${owner}/${repo}:\n${lines.join("\n")}` };
        } catch (e) {
          return fail(`github_list_issues failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
    {
      name: "github_create_issue",
      description:
        "Open a new issue on a repository. WRITE action - only available when the connection was granted write scope. Args: owner, repo, title, body (optional, markdown).",
      source: SOURCE,
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string", description: "Issue body (markdown)." },
        },
        required: ["owner", "repo", "title"],
      },
      execute: async (input, ctx): Promise<ToolResult> => {
        try {
          const owner = String(input.owner ?? "");
          const repo = String(input.repo ?? "");
          const title = String(input.title ?? "");
          if (!owner || !repo || !title) return fail("owner, repo, and title are required.");
          const body = typeof input.body === "string" ? input.body : undefined;
          const res = await gh.createIssue(await tokenFor(broker, ctx?.agentId), owner, repo, title, body);
          return { content: `Opened issue #${res.number}: ${res.url}` };
        } catch (e) {
          return fail(`github_create_issue failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    },
  ];
}
