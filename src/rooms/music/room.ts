// MusicRoom — the Room-contract wrapper around the music feature: the
// kie.ai generation manager, the /api/music REST surface, the agent-facing
// tools, and (new with the contract) purge + footprint participation.
// Server capabilities (broadcast) arrive injected; this module never
// imports src/server.

import { existsSync } from "fs";
import { join } from "path";
import type { MantleConfig } from "../../config/schema.js";
import type { VoiceManager } from "../../voice/manager.js";
import type { Tool } from "../../tools/types.js";
import type { Room, RoomFootprintSection, RoomPurgeResult } from "../types.js";
import { MusicManager } from "./manager.js";
import { handleMusicApi } from "./api.js";
import {
  createGenerateMusicTool,
  createListMusicTool,
  createGetMusicTrackTool,
  createGetMusicLyricsTool,
} from "./tools.js";
import { sanitizeSegment } from "./paths.js";
import { walkMp3 } from "./metadata.js";

export class MusicRoom implements Room {
  readonly id = "music";
  readonly restPrefix = "/api/music/";
  readonly manager: MusicManager;

  constructor(
    private config: MantleConfig,
    private basePath: string,
    private broadcast: (msg: Record<string, unknown>) => void,
    private voiceManager?: VoiceManager,
  ) {
    this.manager = new MusicManager(config, basePath, broadcast);
  }

  handleApi = (req: Request, url: URL): Promise<Response> =>
    handleMusicApi(req, url, this.config, this.manager, this.voiceManager, this.broadcast);

  tools(): Tool[] {
    if (!this.config.music.enabled) return [];
    // Read tools register regardless of key — they only inspect what's on
    // disk. generate_music only when generation is configured (key present),
    // so no dead generate tool is advertised.
    const tools: Tool[] = [
      createListMusicTool(this.manager, this.config),
      createGetMusicTrackTool(this.manager, this.config),
      createGetMusicLyricsTool(this.manager, this.config),
    ];
    if (this.manager.isEnabled()) {
      tools.push(createGenerateMusicTool(this.manager));
    }
    return tools;
  }

  async onAgentPurge(agentId: string): Promise<RoomPurgeResult> {
    const r = this.manager.purgeAgent(agentId);
    const bits: string[] = [];
    if (r.droppedTasks > 0) bits.push(`dropped ${r.droppedTasks} pending generation(s)`);
    bits.push(r.bucketDeleted ? "bucket deleted" : "no bucket on disk");
    return { ok: true, detail: bits.join("; ") };
  }

  footprint(agentId: string): RoomFootprintSection[] {
    const bucket = join(this.basePath, ".mantle", "music", sanitizeSegment(agentId));
    const exists = existsSync(bucket);
    let fileCount = 0;
    if (exists) {
      try {
        fileCount = [...walkMp3(bucket)].length;
      } catch {
        /* unreadable — report exists with 0 */
      }
    }
    const pending = this.manager.generating().filter((t) => t.agentId === agentId).length;
    return [
      {
        label: "music bucket",
        path: bucket,
        exists,
        fileCount,
        note: pending > 0 ? `${pending} in-flight generation(s) will be dropped` : undefined,
      },
    ];
  }

  start(): void {
    this.manager.start();
  }

  stop(): void {
    this.manager.stop();
  }
}
