/**
 * SSRF guard for the outbound-fetch tools (web_fetch, attach_url_file).
 *
 * Without this, an agent — or a prompt-injected agent following instructions
 * embedded in a fetched page — can hit `http://169.254.169.254` (cloud
 * metadata), `http://127.0.0.1:<port>` (mantle's own API / local admin
 * surfaces), or any RFC1918 / tailnet host and pivot into the internal
 * network. `safeFetch` resolves the target host, rejects private/loopback/
 * link-local/CGNAT ranges, allows only http(s), and re-validates every
 * redirect hop manually so a public URL can't 30x-bounce into a blocked one.
 *
 * Residual gap: DNS rebinding (the IP we validate may differ from the IP the
 * socket ultimately connects to). Pinning the connection to the validated IP
 * isn't exposed by fetch(); acceptable for a single-user harness, noted here.
 */

import { lookup } from "dns/promises";
import { isIP } from "net";

function ipToLong(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

// CIDR base/bits → true if ipLong falls inside.
function inRange4(ipLong: number, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const baseLong = ipToLong(base);
  if (baseLong === null) return false;
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipLong & mask) === (baseLong & mask);
}

const BLOCKED_V4_CIDRS = [
  "0.0.0.0/8", // "this" network
  "10.0.0.0/8", // RFC1918 private
  "100.64.0.0/10", // CGNAT — Tailscale's range; blocks tailnet-host pivots
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local — incl. 169.254.169.254 cloud metadata
  "172.16.0.0/12", // RFC1918 private
  "192.0.0.0/24", // IETF protocol assignments
  "192.168.0.0/16", // RFC1918 private
  "198.18.0.0/15", // benchmarking
];

function isBlockedV4(ip: string): boolean {
  const n = ipToLong(ip);
  if (n === null) return true; // unparseable → fail closed
  return BLOCKED_V4_CIDRS.some((cidr) => inRange4(n, cidr));
}

function isBlockedV6(ip: string): boolean {
  const norm = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (norm === "::1" || norm === "::") return true; // loopback / unspecified
  if (/^fe[89ab]/.test(norm)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(norm)) return true; // unique-local fc00::/7
  const mapped = norm.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedV4(mapped[1]); // v4-mapped IPv6
  return false;
}

function isBlockedIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return true; // not a recognizable IP → fail closed
}

/**
 * Validate a hostname (IP literal or DNS name). Returns an error message if
 * it is, or resolves to, a blocked address — null if it's safe to fetch.
 * Checks every resolved address (round-robin DNS can mix public + private).
 */
export async function assertPublicHost(hostname: string): Promise<string | null> {
  if (isIP(hostname) !== 0) {
    return isBlockedIp(hostname)
      ? `Blocked: ${hostname} is a private, loopback, or link-local address.`
      : null;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return `Could not resolve host: ${hostname}`;
  }
  if (addresses.length === 0) return `Could not resolve host: ${hostname}`;
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      return `Blocked: ${hostname} resolves to ${address}, a private/loopback/link-local address.`;
    }
  }
  return null;
}

// Domain-suffix match for the egress allow-list. "arxiv.org" matches arxiv.org
// and any subdomain (export.arxiv.org), but NOT a look-alike parent
// ("arxiv.org.evil.com" ends in ".evil.com", not ".arxiv.org"). Hosts + entries
// are lowercased, trailing dots stripped; an IP literal only matches itself.
// Exported for direct unit testing.
export function hostInAllowList(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  for (const raw of allowed) {
    const d = raw.toLowerCase().replace(/^\.+|\.+$/g, "").trim();
    if (!d) continue;
    if (host === d || host.endsWith("." + d)) return true;
  }
  return false;
}

export interface SafeFetchOptions extends RequestInit {
  maxRedirects?: number;
  // Optional per-run egress allow-list (domain suffixes). When set, the target
  // host AND every redirect hop must match one entry or the fetch is refused —
  // the per-job containment that turns "exfiltrate to any public host" into
  // "reach only the domains this job was pointed at". Empty/undefined = no
  // restriction (the SSRF block still applies).
  allowedHosts?: string[];
}

/**
 * fetch() with SSRF protection. Only http(s); validates the host and each
 * redirect hop against the blocked ranges. Throws on a blocked target,
 * disallowed scheme, unresolvable host, or redirect overflow. Otherwise
 * behaves like fetch() and returns the final Response.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<Response> {
  const { maxRedirects = 5, allowedHosts, ...init } = options;

  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error(`Only http(s) URLs are allowed (got ${current.protocol}).`);
    }
    const blocked = await assertPublicHost(current.hostname);
    if (blocked) throw new Error(blocked);
    if (allowedHosts && allowedHosts.length > 0 && !hostInAllowList(current.hostname, allowedHosts)) {
      throw new Error(`Blocked: ${current.hostname} is not in this run's egress allow-list (${allowedHosts.join(", ")}).`);
    }

    const resp = await fetch(current, { ...init, method, body, redirect: "manual" });

    const isRedirect = (resp.status >= 300 && resp.status < 400) || resp.type === "opaqueredirect";
    const location = resp.headers.get("location");
    if (!isRedirect || !location) return resp;
    if (hop === maxRedirects) throw new Error(`Too many redirects (> ${maxRedirects}).`);

    const next = new URL(location, current); // resolve relative Location
    // 303 always → GET; 301/302 on a non-idempotent method → GET (matches
    // browser behavior). Drop the body in those cases.
    if (resp.status === 303 || ((resp.status === 301 || resp.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }

  throw new Error("Redirect handling failed."); // unreachable
}

/**
 * Read a response body into memory but stop once `maxBytes` is exceeded, so a
 * server that lies about (or omits) Content-Length can't make an outbound-fetch
 * tool buffer an unbounded amount — the SSRF guard lets the agent aim fetches
 * at arbitrary public hosts, so the response size has to be bounded our side
 * too. Returns the bytes read and whether the cap was hit; the caller decides
 * whether that's a soft truncation (web_fetch) or a hard rejection
 * (attach_url_file). The underlying transfer is cancelled when we bail early.
 */
export async function readResponseCapped(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const body = response.body;
  if (!body) {
    // Bodyless response (204 / HEAD / etc.) — nothing to stream.
    return { bytes: new Uint8Array(0), capped: false };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let capped = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total > maxBytes) {
        capped = true;
        break;
      }
    }
  } finally {
    // Release the connection if we stopped early; ignore errors (the stream
    // may already be closed or aborted).
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, capped };
}
