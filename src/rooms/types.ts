// The ROOM contract — the formalization of mantle's bolt-on principle.
//
// The core agentic loop (src/agent + src/tools + the server transport) is
// the foundation; everything else — music, channels, future hubs — is a
// ROOM: a feature that can be torn down and rebuilt without risking the
// core. Until this contract existed the principle held only at the import
// level: every room invented its own lifecycle and none participated in
// agent purge or the footprint manifest, so purging an agent left music
// buckets, channel rosters, and pending generations pointing at a ghost.
//
// Rules a room implementation must follow:
//   - Rooms may import CORE modules (src/agent, src/tools, src/config,
//     src/local, src/voice) but NEVER src/server — server capabilities
//     (broadcast, managers) are injected at construction. `scripts/
//     check-arch.ts` enforces this.
//   - Core (src/agent, src/tools, src/cron) never imports
//     src/rooms. The composition root (src/index.ts) and the server layer
//     are the only places that may reference a room.
//   - Deleting a room's directory should leave only its registration line
//     in index.ts (plus, for the channel, the "channel" lock rank and the
//     channel_* ClientMessage members — type-only residue, accepted).

import type { Tool } from "../tools/types.js";

// One section of the purge-preview manifest (GET /api/agents/:id/footprint).
export interface RoomFootprintSection {
  // Short human label, e.g. "music bucket" / "channel membership".
  label: string;
  // Absolute path purge would remove, when the section is path-shaped.
  path?: string;
  exists: boolean;
  fileCount?: number;
  // Free-form detail ("member of 2 channels: …").
  note?: string;
}

export interface RoomPurgeResult {
  ok: boolean;
  detail?: string;
}

export interface Room {
  // Stable identifier ("music", "channel") — used in purge/footprint
  // reporting and logs.
  id: string;

  // REST namespace this room owns, e.g. "/api/music/". When set, the
  // server dispatches any matching request to handleApi. A room may omit
  // both to be tools-only.
  restPrefix?: string;
  handleApi?(req: Request, url: URL): Promise<Response>;

  // Agent-facing tools to register at boot. Called once; the room decides
  // internally what to expose (e.g. music registers generate_music only
  // when an API key is configured).
  tools?(): Tool[];

  // THE hook the bolt-on principle was missing: when an agent is purged,
  // every room drops its references (rosters, pending tasks) and deletes
  // its on-disk per-agent state. Must be safe to call for unknown ids.
  onAgentPurge(agentId: string): Promise<RoomPurgeResult>;

  // What purge WOULD touch — feeds the footprint manifest the UI shows
  // before a destructive delete.
  footprint?(agentId: string): RoomFootprintSection[];

  // Boot/shutdown lifecycle (resume pollers, close timers). Optional.
  start?(): void;
  stop?(): void | Promise<void>;
}

// Boot builds one registry; the server dispatches REST by prefix, purge +
// footprint + shutdown iterate it. Deliberately a thin list — rooms are
// few and independence is the point.
export class RoomRegistry {
  private rooms: Room[] = [];

  register(room: Room): void {
    this.rooms.push(room);
  }

  list(): Room[] {
    return [...this.rooms];
  }

  get(id: string): Room | undefined {
    return this.rooms.find((r) => r.id === id);
  }

  // REST dispatch by prefix. Returns null when no room owns the path.
  async dispatchApi(req: Request, url: URL): Promise<Response | null> {
    for (const room of this.rooms) {
      if (!room.restPrefix || !room.handleApi) continue;
      if (
        url.pathname.startsWith(room.restPrefix) ||
        // "/api/music/" also owns the bare "/api/music".
        url.pathname === room.restPrefix.replace(/\/$/, "")
      ) {
        return room.handleApi(req, url);
      }
    }
    return null;
  }

  // Run every room's purge hook; failures are reported, never thrown —
  // one room's failure must not strand the rest of the purge.
  async purgeAgent(agentId: string): Promise<Array<{ room: string; ok: boolean; detail?: string }>> {
    const results: Array<{ room: string; ok: boolean; detail?: string }> = [];
    for (const room of this.rooms) {
      try {
        const r = await room.onAgentPurge(agentId);
        results.push({ room: room.id, ok: r.ok, detail: r.detail });
      } catch (err) {
        results.push({
          room: room.id,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  footprint(agentId: string): Array<{ room: string; sections: RoomFootprintSection[] }> {
    const out: Array<{ room: string; sections: RoomFootprintSection[] }> = [];
    for (const room of this.rooms) {
      if (!room.footprint) continue;
      try {
        out.push({ room: room.id, sections: room.footprint(agentId) });
      } catch {
        out.push({ room: room.id, sections: [] });
      }
    }
    return out;
  }

  startAll(): void {
    for (const room of this.rooms) {
      try {
        room.start?.();
      } catch (err) {
        console.warn(`[MANTLE:rooms] ${room.id}.start() threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const room of this.rooms) {
      try {
        await room.stop?.();
      } catch (err) {
        console.warn(`[MANTLE:rooms] ${room.id}.stop() threw: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
