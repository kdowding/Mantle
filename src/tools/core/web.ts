import type { Tool } from "../types.js";
import { wrapUntrusted } from "../untrusted.js";
import { safeFetch, readResponseCapped } from "./net-guard.js";

const MAX_RESPONSE_SIZE = 50_000; // 50KB of (post-strip) text handed to the model
// Hard ceiling on bytes buffered from the body before we truncate. Generous
// enough that real pages strip down to a full MAX_RESPONSE_SIZE, bounded enough
// that a huge/malicious response can't be read entirely into memory first.
const MAX_FETCH_BYTES = 5 * 1024 * 1024; // 5MB

// Headers a caller (including a prompt-injected agent) must not control on an
// outbound request: hop-by-hop / connection headers that fetch() manages
// itself, Host (would let a request smuggle to a different vhost behind a
// public IP that already passed the SSRF check), and Cookie (a credential
// header with no legitimate web_fetch use). Authorization is intentionally NOT
// stripped — fetching an authenticated API with a user-provided token is valid.
const FORBIDDEN_FETCH_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive", "upgrade",
  "transfer-encoding", "proxy-authorization", "proxy-connection", "cookie",
]);

function sanitizeFetchHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!FORBIDDEN_FETCH_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

export function createWebTool(): Tool {
  return {
    name: "web_fetch",
    description: "Make an HTTP request and return the response. For HTML pages, returns the text content.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch" },
        method: { type: "string", description: "HTTP method (default: GET)", enum: ["GET", "POST", "PUT", "DELETE", "PATCH"] },
        headers: { type: "object", description: "Request headers as key-value pairs" },
        body: { type: "string", description: "Request body (for POST/PUT/PATCH)" },
      },
      required: ["url"],
    },
    async execute(input, context) {
      const url = String(input.url);
      const method = String(input.method ?? "GET");
      const headers = (input.headers ?? {}) as Record<string, string>;
      const body = input.body ? String(input.body) : undefined;

      try {
        // safeFetch enforces http(s)-only + blocks private/loopback/metadata
        // targets (and re-checks each redirect hop) before the request goes out.
        const response = await safeFetch(url, {
          method,
          headers: sanitizeFetchHeaders(headers),
          body: method !== "GET" ? body : undefined,
          // /stop kills the request mid-flight instead of waiting for
          // the server to respond. fetch() honors AbortSignal natively.
          signal: context?.signal,
          // Per-job egress containment (cron) — when set, only these domains are
          // reachable; unset for chat (the SSRF block still applies either way).
          allowedHosts: context?.egressAllowList,
        });

        const contentType = response.headers.get("content-type") ?? "";

        // Stream the body with a hard byte cap. safeFetch lets the agent aim at
        // arbitrary public hosts, so without this a malicious or accidentally
        // huge response would be fully buffered (response.text()) before we
        // ever truncate — a memory-DoS matching the threat model this tool is
        // hardened against.
        const { bytes, capped } = await readResponseCapped(response, MAX_FETCH_BYTES);
        let text = new TextDecoder().decode(bytes);

        // Strip HTML tags for HTML responses to save tokens
        if (contentType.includes("text/html")) {
          text = stripHtml(text);
        }

        // Truncate the (possibly stripped) text to the model-facing cap.
        let note = "";
        if (text.length > MAX_RESPONSE_SIZE) {
          text = text.slice(0, MAX_RESPONSE_SIZE);
          note = `\n\n[Response truncated at ${MAX_RESPONSE_SIZE} chars]`;
        } else if (capped) {
          note = `\n\n[Response body capped at ${MAX_FETCH_BYTES} bytes]`;
        }

        const headerInfo = `Status: ${response.status} ${response.statusText}\nContent-Type: ${contentType}`;
        // Frame the body as untrusted external data so a fetched page can't pose
        // as instructions (the structural half of the injection defense; the
        // truncation note stays outside the envelope — it's mantle's annotation).
        let sourceLabel = "a fetched web page";
        try { sourceLabel = `a fetched web page (${new URL(url).host})`; } catch { /* keep the generic label */ }
        return { content: `${headerInfo}\n\n${wrapUntrusted(text, sourceLabel)}${note}`, isError: response.status >= 400 };
      } catch (err) {
        return { content: `Fetch error: ${err}`, isError: true };
      }
    },
  };
}

function stripHtml(html: string): string {
  // Remove script and style blocks
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  // Replace common block elements with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|br)[^>]*>/gi, "\n");
  text = text.replace(/<br[^>]*\/?>/gi, "\n");

  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode basic HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Clean up whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  return text;
}
