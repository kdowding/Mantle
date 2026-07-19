// Tool-surface precedence for the shared front door. applyToolSurface is the
// pure core of every turn's advertised-tool selection — allow-list vs filter,
// and the hard per-agent disable gate layered last. The ordering invariants
// here are load-bearing: disable must win over a trigger's own allow-list, and
// an allow-list must short-circuit the filter.

import { describe, test, expect } from "bun:test";
import { applyToolSurface } from "./triggered-turn.js";
import type { ToolDefinition } from "./providers/types.js";

const def = (name: string): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
});
const names = (defs: ToolDefinition[]): string[] => defs.map((d) => d.name).sort();
const ALL = [def("read_file"), def("bash"), def("recall"), def("englyph_search"), def("cron_jobs")];
const noEnglyph = (d: ToolDefinition[]): ToolDefinition[] => d.filter((t) => !t.name.startsWith("englyph_"));

describe("applyToolSurface", () => {
  test("no constraints returns the full surface", () => {
    expect(names(applyToolSurface(ALL, {}))).toEqual(names(ALL));
  });

  test("allow-list keeps only listed names", () => {
    expect(names(applyToolSurface(ALL, { toolAllowList: ["read_file", "bash"] }))).toEqual(["bash", "read_file"]);
  });

  test("filter shapes the surface when no allow-list is given", () => {
    const out = applyToolSurface(ALL, { toolFilter: noEnglyph });
    expect(out.find((t) => t.name === "englyph_search")).toBeUndefined();
    expect(out.find((t) => t.name === "recall")).toBeDefined();
  });

  test("allow-list short-circuits the filter (filter is NOT applied)", () => {
    const out = applyToolSurface(ALL, { toolAllowList: ["englyph_search"], toolFilter: noEnglyph });
    expect(names(out)).toEqual(["englyph_search"]); // filter would have dropped it; allow-list path wins
  });

  test("disable gate wins over an allow-list that named the tool", () => {
    const out = applyToolSurface(ALL, { toolAllowList: ["read_file", "bash"], disabledTools: ["bash"] });
    expect(names(out)).toEqual(["read_file"]);
  });

  test("disable gate strips from a filtered surface", () => {
    const out = applyToolSurface(ALL, { toolFilter: noEnglyph, disabledTools: ["recall"] });
    expect(out.find((t) => t.name === "recall")).toBeUndefined();
  });

  test("disable gate strips from the unconstrained surface", () => {
    const out = applyToolSurface(ALL, { disabledTools: ["read_file", "cron_jobs"] });
    expect(names(out)).toEqual(["bash", "englyph_search", "recall"]);
  });

  test("empty disabledTools is a no-op", () => {
    expect(names(applyToolSurface(ALL, { disabledTools: [] }))).toEqual(names(ALL));
  });
});
