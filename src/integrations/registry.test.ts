import { describe, expect, it } from "bun:test";
import { IntegrationRegistry, type Integration, type TokenBroker, type IntegrationConnectionInfo } from "./types.js";
import type { Tool } from "../tools/types.js";

function fakeBroker(info: IntegrationConnectionInfo | null): TokenBroker {
  return {
    async getAccessToken() {
      return "tok";
    },
    connectionInfo: () => info,
  };
}

function sendTool(): { tool: Tool; sent: () => boolean } {
  let sent = false;
  return {
    sent: () => sent,
    tool: {
      name: "gmail_send_message",
      description: "send mail",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        sent = true;
        return { content: "sent" };
      },
    },
  };
}

function integration(tool: Tool): Integration {
  return {
    id: "gmail",
    label: "Gmail",
    auth: { kind: "oauth2", authorizeUrl: "x", tokenUrl: "y", readScopes: [], writeScopes: ["send"] },
    tools: () => [tool],
    writeTools: ["gmail_send_message"],
    async onAgentPurge() {
      return { ok: true };
    },
  };
}

describe("IntegrationRegistry write-scope execution guard", () => {
  it("blocks a write tool when the connection lacks write scope (read-only token)", async () => {
    const spy = sendTool();
    const reg = new IntegrationRegistry(fakeBroker({ scopes: ["read"], writeEnabled: false }));
    reg.register(integration(spy.tool));

    const guarded = reg.tools().find((t) => t.name === "gmail_send_message")!;
    const r = await guarded.execute({ to: "attacker@evil.com" }, { agentId: "a", sessionId: "s" });

    expect(r.isError).toBe(true);
    expect(r.content).toContain("write access");
    expect(spy.sent()).toBe(false); // the SDK call must never fire
  });

  it("blocks a write tool when the agent has no connection at all", async () => {
    const spy = sendTool();
    const reg = new IntegrationRegistry(fakeBroker(null));
    reg.register(integration(spy.tool));

    const guarded = reg.tools().find((t) => t.name === "gmail_send_message")!;
    const r = await guarded.execute({}, { agentId: "a", sessionId: "s" });

    expect(r.isError).toBe(true);
    expect(spy.sent()).toBe(false);
  });

  it("allows a write tool when write scope IS enabled (explicit opt-in)", async () => {
    const spy = sendTool();
    const reg = new IntegrationRegistry(fakeBroker({ scopes: ["read", "send"], writeEnabled: true }));
    reg.register(integration(spy.tool));

    const guarded = reg.tools().find((t) => t.name === "gmail_send_message")!;
    const r = await guarded.execute({}, { agentId: "a", sessionId: "s" });

    expect(r.isError).toBeFalsy();
    expect(spy.sent()).toBe(true);
  });

  it("default-denies a write tool in an autonomous (cron) run even with write scope", async () => {
    const prev = process.env.MANTLE_ALLOW_AUTONOMOUS_WRITES;
    delete process.env.MANTLE_ALLOW_AUTONOMOUS_WRITES;
    try {
      const spy = sendTool();
      const reg = new IntegrationRegistry(fakeBroker({ scopes: ["read", "send"], writeEnabled: true }));
      reg.register(integration(spy.tool));

      const guarded = reg.tools().find((t) => t.name === "gmail_send_message")!;
      const r = await guarded.execute({}, { agentId: "a", sessionId: "s", autonomous: true });

      expect(r.isError).toBe(true);
      expect(r.content).toContain("autonomous");
      expect(spy.sent()).toBe(false); // unattended injected run can't exfil
    } finally {
      if (prev !== undefined) process.env.MANTLE_ALLOW_AUTONOMOUS_WRITES = prev;
    }
  });

  it("allows a write tool in an autonomous run when the operator opted in", async () => {
    const prev = process.env.MANTLE_ALLOW_AUTONOMOUS_WRITES;
    process.env.MANTLE_ALLOW_AUTONOMOUS_WRITES = "1";
    try {
      const spy = sendTool();
      const reg = new IntegrationRegistry(fakeBroker({ scopes: ["read", "send"], writeEnabled: true }));
      reg.register(integration(spy.tool));

      const guarded = reg.tools().find((t) => t.name === "gmail_send_message")!;
      const r = await guarded.execute({}, { agentId: "a", sessionId: "s", autonomous: true });

      expect(r.isError).toBeFalsy();
      expect(spy.sent()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MANTLE_ALLOW_AUTONOMOUS_WRITES;
      else process.env.MANTLE_ALLOW_AUTONOMOUS_WRITES = prev;
    }
  });
});
