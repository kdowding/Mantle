// GitHub integration — the contract object. PAT auth for now (the guinea pig);
// OAuth slots into the same broker later without touching the tools. Native
// tools (the Octokit engine) by default. Per-agent visibility + write-gating
// are applied by the IntegrationRegistry + the chat tool filter; this file
// just declares the pieces.

import { existsSync } from "fs";
import { resolve } from "path";
import type { Tool } from "../../tools/types.js";
import type {
  Integration,
  IntegrationAuth,
  IntegrationConnectionInfo,
  IntegrationFootprintSection,
  IntegrationPurgeResult,
  TokenBroker,
} from "../types.js";
import { createGithubTools, GITHUB_WRITE_TOOLS } from "./tools.js";
import { verifyToken as ghVerifyToken } from "./api.js";

export class GitHubIntegration implements Integration {
  readonly id = "github";
  readonly label = "GitHub";
  readonly auth: IntegrationAuth = {
    kind: "pat",
    label: "GitHub personal access token (classic 'repo'/'public_repo' for writes; fine-grained works for reads)",
  };
  readonly writeTools = GITHUB_WRITE_TOOLS;

  constructor(
    private broker: TokenBroker,
    private basePath: string,
  ) {}

  tools(): Tool[] {
    return createGithubTools(this.broker);
  }

  verifyToken(token: string): Promise<IntegrationConnectionInfo> {
    return ghVerifyToken(token);
  }

  // GitHub keeps no per-agent state beyond the broker's token (which the
  // registry/broker delete on purge), so there's nothing extra to drop.
  async onAgentPurge(_agentId: string): Promise<IntegrationPurgeResult> {
    return { ok: true, detail: "no GitHub-side state beyond the stored token" };
  }

  footprint(agentId: string): IntegrationFootprintSection[] {
    const tokenPath = resolve(this.basePath, ".mantle", "auth", "integrations", agentId, "github.json");
    return [
      {
        label: "GitHub connection (PAT)",
        path: tokenPath,
        exists: existsSync(tokenPath),
      },
    ];
  }
}
