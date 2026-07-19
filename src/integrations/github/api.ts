// GitHub engine — the composition layer over Octokit. Each function takes a
// token + args, calls one or more GitHub endpoints, and returns a SHAPED
// result (the "view"). This is the portable core: if mantle ever exposes
// GitHub to another harness, an MCP adapter wraps THESE functions unchanged.
// tools.ts is a thin native adapter; the broker supplies the token.

import { Octokit } from "@octokit/rest";
import type { IntegrationConnectionInfo } from "../types.js";

function client(token: string): Octokit {
  return new Octokit({ auth: token });
}

// Scopes that grant write/push/issue-create. Classic PATs report scopes in the
// x-oauth-scopes response header; fine-grained PATs usually report none, so we
// default writeEnabled=false (read-only) when scopes are unknown — the safe
// posture for an injectable companion.
const WRITE_SCOPES = ["repo", "public_repo", "write:issues", "issues"];

export async function verifyToken(token: string): Promise<IntegrationConnectionInfo> {
  const res = await client(token).request("GET /user");
  const scopeHeader = res.headers["x-oauth-scopes"];
  const scopes =
    typeof scopeHeader === "string" && scopeHeader.trim().length > 0
      ? scopeHeader.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  return {
    account: res.data.login,
    scopes,
    writeEnabled: scopes.some((s) => WRITE_SCOPES.includes(s)),
  };
}

export interface RepoSummary {
  fullName: string;
  private: boolean;
  description: string | null;
  url: string;
  stars: number;
  language: string | null;
  updatedAt: string;
}

export async function listRepos(token: string, opts: { limit?: number } = {}): Promise<RepoSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const { data } = await client(token).request("GET /user/repos", {
    per_page: limit,
    sort: "updated",
    affiliation: "owner,collaborator,organization_member",
  });
  return data.map((r) => ({
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    url: r.html_url,
    stars: r.stargazers_count ?? 0,
    language: r.language ?? null,
    updatedAt: r.updated_at ?? "",
  }));
}

export interface RepoDetail {
  fullName: string;
  private: boolean;
  description: string | null;
  url: string;
  stars: number;
  forks: number;
  openIssues: number;
  defaultBranch: string;
  language: string | null;
  topics: string[];
}

export async function getRepo(token: string, owner: string, repo: string): Promise<RepoDetail> {
  const { data } = await client(token).request("GET /repos/{owner}/{repo}", { owner, repo });
  return {
    fullName: data.full_name,
    private: data.private,
    description: data.description,
    url: data.html_url,
    stars: data.stargazers_count ?? 0,
    forks: data.forks_count ?? 0,
    openIssues: data.open_issues_count ?? 0,
    defaultBranch: data.default_branch,
    language: data.language ?? null,
    topics: data.topics ?? [],
  };
}

export interface IssueSummary {
  number: number;
  title: string;
  state: string;
  author?: string;
  labels: string[];
  comments: number;
  url: string;
  isPullRequest: boolean;
}

export async function listIssues(
  token: string,
  owner: string,
  repo: string,
  opts: { state?: "open" | "closed" | "all"; limit?: number } = {},
): Promise<IssueSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const { data } = await client(token).request("GET /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    state: opts.state ?? "open",
    per_page: limit,
  });
  return data.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    author: i.user?.login,
    labels: (i.labels ?? [])
      .map((l) => (typeof l === "string" ? l : l.name ?? ""))
      .filter(Boolean),
    comments: i.comments ?? 0,
    url: i.html_url,
    isPullRequest: !!i.pull_request,
  }));
}

export async function createIssue(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body?: string,
): Promise<{ number: number; url: string }> {
  const { data } = await client(token).request("POST /repos/{owner}/{repo}/issues", {
    owner,
    repo,
    title,
    body,
  });
  return { number: data.number, url: data.html_url };
}
