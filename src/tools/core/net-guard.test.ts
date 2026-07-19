import { test, expect, describe } from "bun:test";
import { hostInAllowList } from "./net-guard.js";

describe("hostInAllowList (egress allow-list matching)", () => {
  const allow = ["arxiv.org", "news.ycombinator.com"];

  test("exact host matches", () => {
    expect(hostInAllowList("arxiv.org", allow)).toBe(true);
    expect(hostInAllowList("news.ycombinator.com", allow)).toBe(true);
  });

  test("subdomains match the domain suffix", () => {
    expect(hostInAllowList("export.arxiv.org", allow)).toBe(true);
    expect(hostInAllowList("a.b.arxiv.org", allow)).toBe(true);
  });

  test("a look-alike parent domain does NOT match (the exfil bypass)", () => {
    // arxiv.org.evil.com ends in .evil.com — the classic allow-list escape.
    expect(hostInAllowList("arxiv.org.evil.com", allow)).toBe(false);
    expect(hostInAllowList("notarxiv.org", allow)).toBe(false);
    expect(hostInAllowList("evil.com", allow)).toBe(false);
  });

  test("matching is case-insensitive and ignores a trailing dot", () => {
    expect(hostInAllowList("ArXiv.ORG", allow)).toBe(true);
    expect(hostInAllowList("arxiv.org.", allow)).toBe(true);
    expect(hostInAllowList("EXPORT.ArXiv.org", allow)).toBe(true);
  });

  test("list entries are normalized (leading/trailing dots, whitespace, case)", () => {
    expect(hostInAllowList("arxiv.org", [".ArXiv.org."])).toBe(true);
    expect(hostInAllowList("x.arxiv.org", ["  arxiv.org  "])).toBe(true);
  });

  test("empty / non-matching lists deny", () => {
    expect(hostInAllowList("arxiv.org", [])).toBe(false);
    expect(hostInAllowList("arxiv.org", ["example.com"])).toBe(false);
    expect(hostInAllowList("arxiv.org", [""])).toBe(false);
  });
});
