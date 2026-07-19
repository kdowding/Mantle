import { test, expect, describe } from "bun:test";
import {
  resolveCronContext,
  resolveCronToolsAllow,
  cronWorkspaceFilenames,
  isCronPresetName,
  blindEgressDescription,
  SAFE_CRON_TOOLS,
  CRON_PRESETS,
} from "./presets.js";

describe("resolveCronContext", () => {
  test("an unspecified job is the security-first default (mechanical)", () => {
    const ctx = resolveCronContext({});
    expect(ctx.workspaceFiles).toEqual(["IDENTITY"]);
    expect(ctx.memoryPack).toBe(false);
    expect(ctx.skills).toBe(false);
    expect(ctx.baseline).toBe(true);
  });

  test("companion loads the full identity surface + skills + pack", () => {
    const ctx = resolveCronContext({ preset: "companion" });
    expect(ctx.workspaceFiles).toEqual(["SOUL", "IDENTITY", "USER", "MEMORY"]);
    expect(ctx.memoryPack).toBe(true);
    expect(ctx.skills).toBe(true);
  });

  test("AGENTS.md is NOT auto-loaded for scheduled runs (CRON.md is the floor)", () => {
    for (const name of Object.keys(CRON_PRESETS) as Array<keyof typeof CRON_PRESETS>) {
      expect(CRON_PRESETS[name].context.workspaceFiles).not.toContain("AGENTS");
    }
  });

  test("a per-job context override layers over the preset", () => {
    const ctx = resolveCronContext({ preset: "mechanical", context: { memoryPack: true } });
    expect(ctx.memoryPack).toBe(true); // overridden
    expect(ctx.workspaceFiles).toEqual(["IDENTITY"]); // preset default kept
  });

  test("an unknown preset falls back to the default rather than throwing", () => {
    const ctx = resolveCronContext({ preset: "bogus" as never });
    expect(ctx.workspaceFiles).toEqual(["IDENTITY"]);
  });
});

describe("resolveCronToolsAllow", () => {
  test("an unspecified job gets the safe read+report surface", () => {
    expect(resolveCronToolsAllow({})).toBe(SAFE_CRON_TOOLS);
  });

  test("the safe surface excludes the dangerous capabilities", () => {
    for (const banned of ["bash", "write_file", "edit_file", "spawn_agent", "englyph_research", "englyph_research_async", "attach_url_file", "render_session_markdown"]) {
      expect(SAFE_CRON_TOOLS).not.toContain(banned);
    }
  });

  test("the safe surface includes a real search tool (no SERP-scraping)", () => {
    // brave_web_search is read-only; its query egresses via MCP (egressDomains
    // can't fence it) but reaches Brave, not an attacker — judged low enough to
    // beat scraping a search engine's HTML through web_fetch. Stays out of
    // BLIND_EGRESS_TOOLS so the default presets raise no standing warning.
    expect(SAFE_CRON_TOOLS).toContain("brave_web_search");
  });

  test("companion runs with the full surface (undefined allow-list)", () => {
    expect(resolveCronToolsAllow({ preset: "companion" })).toBeUndefined();
  });

  test("a stored toolsAllow (privilege containment) ALWAYS wins over the preset", () => {
    // A job minted from a recall-only turn can't be widened by a companion preset.
    expect(resolveCronToolsAllow({ preset: "companion", toolsAllow: ["recall"] })).toEqual(["recall"]);
  });

  test("an empty toolsAllow does not count as containment (falls back to preset)", () => {
    expect(resolveCronToolsAllow({ preset: "mechanical", toolsAllow: [] })).toBe(SAFE_CRON_TOOLS);
  });
});

describe("helpers", () => {
  test("cronWorkspaceFilenames maps short names to .md filenames", () => {
    expect(cronWorkspaceFilenames(["AGENTS", "IDENTITY"])).toEqual(["AGENTS.md", "IDENTITY.md"]);
    expect(cronWorkspaceFilenames(undefined)).toBeUndefined();
  });

  test("isCronPresetName guards the preset union", () => {
    expect(isCronPresetName("mechanical")).toBe(true);
    expect(isCronPresetName("companion")).toBe(true);
    expect(isCronPresetName("foo")).toBe(false);
    expect(isCronPresetName(undefined)).toBe(false);
  });
});

describe("blindEgressDescription (H6 warning)", () => {
  test("the safe presets (default mechanical, aware) raise no warning", () => {
    expect(blindEgressDescription({})).toBeNull();
    expect(blindEgressDescription({ preset: "mechanical" })).toBeNull();
    expect(blindEgressDescription({ preset: "aware" })).toBeNull();
  });

  test("companion (full surface) is flagged", () => {
    expect(blindEgressDescription({ preset: "companion" })).toContain("full tool surface");
  });

  test("an explicit list naming a blind-egress tool is flagged for it", () => {
    expect(blindEgressDescription({ toolsAllow: ["recall", "bash"] })).toBe("bash");
    expect(blindEgressDescription({ toolsAllow: ["englyph_research"] })).toBe("englyph_research");
  });

  test("an explicit read-only list is safe", () => {
    expect(blindEgressDescription({ toolsAllow: ["recall", "web_fetch", "read_file"] })).toBeNull();
  });
});
