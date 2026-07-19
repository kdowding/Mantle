// ChannelRoom — the Room-contract wrapper around the multi-agent group-chat
// feature: the /api/channels REST surface plus (new with the contract)
// purge + footprint participation. The WS inbound family (channel_message /
// channel_retry / channel_stop) stays a thin marked branch in ws.ts that
// calls routeChannelMessage directly — see bridge.ts.
//
// No tools(): the channel's agent surface is pseudo-tools (channel_yield /
// channel_react) injected per sub-turn through the triggered-turn front
// door, never registry tools.

import type { MantleConfig } from "../../config/schema.js";
import type { Room, RoomFootprintSection, RoomPurgeResult } from "../types.js";
import { ChannelStore } from "./channel-store.js";
import { handleChannelApi } from "./api.js";

export class ChannelRoom implements Room {
  readonly id = "channel";
  readonly restPrefix = "/api/channels/";

  constructor(private config: MantleConfig) {}

  handleApi = (req: Request, url: URL): Promise<Response> =>
    handleChannelApi(req, url, this.config);

  // Drop the purged agent from every roster + live-mic list, and clear a
  // stale lastActiveAgentId. Without this every future volley in those
  // channels emitted "<id> is no longer a known agent" noise forever (the
  // roster kept routing to a ghost).
  async onAgentPurge(agentId: string): Promise<RoomPurgeResult> {
    const store = new ChannelStore(this.config.basePath);
    let touched = 0;
    for (const meta of store.list()) {
      const member = meta.participants.includes(agentId) || meta.autoRespond.includes(agentId);
      const wasLastActive = meta.lastActiveAgentId === agentId;
      if (!member && !wasLastActive) continue;
      if (member) store.dismiss(meta.id, agentId);
      if (wasLastActive) {
        store.update(meta.id, (m) => {
          if (m.lastActiveAgentId === agentId) m.lastActiveAgentId = undefined;
        });
      }
      touched++;
    }
    return {
      ok: true,
      detail: touched > 0 ? `dismissed from ${touched} channel(s)` : "no channel memberships",
    };
  }

  footprint(agentId: string): RoomFootprintSection[] {
    const store = new ChannelStore(this.config.basePath);
    const memberOf = store
      .list()
      .filter((m) => m.participants.includes(agentId))
      .map((m) => m.title || m.id);
    return [
      {
        label: "channel membership",
        exists: memberOf.length > 0,
        note: memberOf.length > 0
          ? `member of ${memberOf.length} channel(s): ${memberOf.join(", ")} — will be dismissed (transcripts kept)`
          : "not in any channel",
      },
    ];
  }
}
