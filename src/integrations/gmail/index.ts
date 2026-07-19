// Gmail integration — the contract object. OAuth2 (the generic broker engine
// runs the flow from this spec; no Google-specific code in the broker). Native
// tools (fetch engine) by default. Per-agent visibility + write-gating are
// applied by the IntegrationRegistry + the chat tool filter.
//
// Requires the user's OWN Google OAuth app (Desktop-app client) in
// config.integrations.gmail.{clientId,clientSecret}. Read-only by default;
// `--write` at connect time requests the gmail.send scope.

import { existsSync } from "fs";
import { resolve } from "path";
import type { Tool } from "../../tools/types.js";
import type {
  Integration,
  IntegrationAuth,
  IntegrationFootprintSection,
  IntegrationPurgeResult,
  TokenBroker,
} from "../types.js";
import { createGmailTools, GMAIL_WRITE_TOOLS } from "./tools.js";

export class GmailIntegration implements Integration {
  readonly id = "gmail";
  readonly label = "Gmail";
  readonly auth: IntegrationAuth = {
    kind: "oauth2",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // openid+email give us the account label via the id_token; gmail.readonly
    // is the companion's default surface.
    readScopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    writeScopes: ["https://www.googleapis.com/auth/gmail.send"],
    usePkce: true,
    // access_type=offline + prompt=consent guarantee a refresh token from Google.
    extraAuthParams: { access_type: "offline", prompt: "consent" },
  };
  readonly writeTools = GMAIL_WRITE_TOOLS;

  constructor(
    private broker: TokenBroker,
    private basePath: string,
  ) {}

  tools(): Tool[] {
    return createGmailTools(this.broker);
  }

  // No Gmail-side state beyond the broker's token (deleted on purge).
  async onAgentPurge(_agentId: string): Promise<IntegrationPurgeResult> {
    return { ok: true, detail: "no Gmail-side state beyond the stored token" };
  }

  footprint(agentId: string): IntegrationFootprintSection[] {
    const p = resolve(this.basePath, ".mantle", "auth", "integrations", agentId, "gmail.json");
    return [{ label: "Gmail connection (OAuth)", path: p, exists: existsSync(p) }];
  }
}
