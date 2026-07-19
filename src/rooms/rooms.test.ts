// Room contract tests (M4): registry dispatch by prefix, purge-hook
// isolation (one failing room can't strand the rest), and footprint
// aggregation.

import { describe, test, expect } from "bun:test";
import { RoomRegistry, type Room, type RoomPurgeResult } from "./types.js";

function fakeRoom(over: Partial<Room> & { id: string }): Room {
  return {
    onAgentPurge: async (): Promise<RoomPurgeResult> => ({ ok: true }),
    ...over,
  };
}

describe("RoomRegistry.dispatchApi", () => {
  const mk = () => {
    const reg = new RoomRegistry();
    reg.register(fakeRoom({
      id: "music",
      restPrefix: "/api/music/",
      handleApi: async () => new Response("music", { status: 200 }),
    }));
    reg.register(fakeRoom({
      id: "channel",
      restPrefix: "/api/channels/",
      handleApi: async () => new Response("channel", { status: 200 }),
    }));
    return reg;
  };
  const req = (path: string) => [new Request(`http://x${path}`), new URL(`http://x${path}`)] as const;

  test("prefix match dispatches to the owning room", async () => {
    const reg = mk();
    const [r1, u1] = req("/api/music/tray");
    expect(await (await reg.dispatchApi(r1, u1))!.text()).toBe("music");
    const [r2, u2] = req("/api/channels/chan-12345678/messages");
    expect(await (await reg.dispatchApi(r2, u2))!.text()).toBe("channel");
  });

  test("the BARE prefix (no trailing slash) also routes", async () => {
    const reg = mk();
    const [r, u] = req("/api/channels");
    expect(await (await reg.dispatchApi(r, u))!.text()).toBe("channel");
  });

  test("unclaimed paths return null", async () => {
    const reg = mk();
    const [r, u] = req("/api/agents/juno");
    expect(await reg.dispatchApi(r, u)).toBeNull();
  });
});

describe("RoomRegistry.purgeAgent", () => {
  test("runs every hook; a throwing room reports failure without stranding the rest", async () => {
    const reg = new RoomRegistry();
    const calls: string[] = [];
    reg.register(fakeRoom({
      id: "boom",
      onAgentPurge: async () => { calls.push("boom"); throw new Error("disk on fire"); },
    }));
    reg.register(fakeRoom({
      id: "fine",
      onAgentPurge: async () => { calls.push("fine"); return { ok: true, detail: "cleaned" }; },
    }));

    const results = await reg.purgeAgent("ghost");
    expect(calls).toEqual(["boom", "fine"]);
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.room === "boom")!.ok).toBe(false);
    expect(results.find((r) => r.room === "boom")!.detail).toContain("disk on fire");
    expect(results.find((r) => r.room === "fine")!.ok).toBe(true);
  });
});

describe("RoomRegistry.footprint", () => {
  test("aggregates per-room sections; rooms without the hook are skipped", () => {
    const reg = new RoomRegistry();
    reg.register(fakeRoom({ id: "silent" })); // no footprint hook
    reg.register(fakeRoom({
      id: "music",
      footprint: () => [{ label: "music bucket", exists: true, fileCount: 3 }],
    }));
    const fp = reg.footprint("juno");
    expect(fp).toHaveLength(1);
    expect(fp[0].room).toBe("music");
    expect(fp[0].sections[0].fileCount).toBe(3);
  });
});
