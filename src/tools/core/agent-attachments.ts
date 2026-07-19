import { existsSync, readFileSync, statSync } from "fs";
import { resolve, basename, extname } from "path";
import type { Tool, AgentAttachmentMeta } from "../types.js";
import type { MantleConfig } from "../../config/schema.js";
import { registerAgentAttachment } from "../../agent/attachments.js";
import { checkReservedWindowsName, containmentError } from "./fs-boundary.js";
import { safeFetch, readResponseCapped } from "./net-guard.js";

const FETCH_TIMEOUT_MS = 30_000;

// Reserved characters that are illegal in Windows filenames AND have
// special meaning in URLs / shell. Replaced with `_` when deriving a
// filename from a URL. The \x00-\x1f control-char range is intentional.
// oxlint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function metaForToolResult(
  meta: { fileId: string; originalName: string; mediaType: string; size: number; category: AgentAttachmentMeta["category"]; extractedText?: string },
  caption: string | undefined,
): AgentAttachmentMeta {
  return {
    fileId: meta.fileId,
    filename: meta.originalName,
    mediaType: meta.mediaType,
    size: meta.size,
    category: meta.category,
    caption,
    extractedText: meta.extractedText,
  };
}

// MIME types we trust the URL fetch to declare. Used as fallback when
// we can't derive a useful extension from the URL path.
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/html": ".html",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/xml": ".xml",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "application/zip": ".zip",
};

function deriveFilenameFromUrl(url: URL, mediaType: string, override?: string): string {
  if (override && override.trim()) {
    return override.trim().replace(UNSAFE_FILENAME_CHARS, "_");
  }
  // Try last path segment first
  const segments = url.pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last) {
    const decoded = decodeURIComponent(last).replace(UNSAFE_FILENAME_CHARS, "_");
    if (extname(decoded)) return decoded;
    // Has a name but no ext — append from MIME if we can
    const ext = MIME_TO_EXT[mediaType] ?? "";
    if (ext) return decoded + ext;
    return decoded;
  }
  // No path segment at all — fall back to host + MIME-derived ext
  const ext = MIME_TO_EXT[mediaType] ?? ".bin";
  return `${url.hostname.replace(/[.:]/g, "_")}${ext}`;
}

// Best-effort MIME guess from extension — fallback when fs has no
// MIME info for a local path. Mirrors the categories the UI's
// renderAttachment dispatcher cares about.
const EXT_TO_MIME: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values",
  ".json": "application/json", ".xml": "application/xml", ".html": "text/html", ".htm": "text/html",
  ".js": "text/javascript", ".ts": "text/typescript",
  ".py": "text/x-python", ".rb": "text/x-ruby", ".go": "text/x-go", ".rs": "text/x-rust",
  ".yaml": "application/x-yaml", ".yml": "application/x-yaml",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip",
};

function guessMimeFromPath(path: string): string {
  return EXT_TO_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function createAgentAttachmentTools(
  baseMantleDir: string,
  config: MantleConfig,
): Tool[] {
  const maxBytes = (config.session.agentAttachmentMaxSizeMB ?? 50) * 1024 * 1024;

  const attachLocalFile: Tool = {
    name: "attach_local_file",
    description:
      "Attach a file from the host machine to your reply so the user can see/download it in chat. Use for SENDING a file you can read off the host (a document at C:\\Users\\..., an image on disk, anything mantle's process can read). Returns silently — your follow-up text appears next to the attachment in the chat bubble. Do NOT use for files you fetched from a URL (use attach_url_file). Path can be absolute or relative to your workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or workspace-relative path to the file on the host machine.",
        },
        caption: {
          type: "string",
          description: "Optional one-line description of what this file is. Shown alongside the attachment.",
        },
      },
      required: ["path"],
    },
    async execute(input, context) {
      const rawPath = String(input.path ?? "").trim();
      const caption = input.caption ? String(input.caption) : undefined;
      if (!rawPath) {
        return { content: "Error: 'path' is required.", isError: true };
      }
      if (!context?.agentId || !context?.sessionId) {
        return { content: "Error: tool needs agent + session context to attach a file.", isError: true };
      }

      const reserved = checkReservedWindowsName(rawPath);
      if (reserved) return { content: reserved, isError: true };

      const absPath = resolve(context.workspacePath ?? process.cwd(), rawPath);
      const contained = containmentError(absPath, rawPath);
      if (contained) return { content: contained, isError: true };
      if (!existsSync(absPath)) {
        return { content: `File not found: ${absPath}`, isError: true };
      }

      let stat;
      try {
        stat = statSync(absPath);
      } catch (err) {
        return { content: `Cannot stat file: ${err instanceof Error ? err.message : err}`, isError: true };
      }
      if (stat.isDirectory()) {
        return { content: `Path is a directory, not a file: ${absPath}`, isError: true };
      }
      if (stat.size > maxBytes) {
        return {
          content: `File ${formatSize(stat.size)} exceeds the ${config.session.agentAttachmentMaxSizeMB}MB cap for agent attachments.`,
          isError: true,
        };
      }
      if (stat.size === 0) {
        return { content: `File is empty: ${absPath}`, isError: true };
      }

      let buffer: Buffer;
      try {
        buffer = readFileSync(absPath);
      } catch (err) {
        return { content: `Failed to read file: ${err instanceof Error ? err.message : err}`, isError: true };
      }

      const filename = basename(absPath);
      const mediaType = guessMimeFromPath(absPath);

      let meta;
      try {
        meta = await registerAgentAttachment({
          baseMantleDir,
          agentId: context.agentId,
          sessionId: context.sessionId,
          originalName: filename,
          mediaType,
          buffer,
        });
      } catch (err) {
        return { content: `Failed to register attachment: ${err instanceof Error ? err.message : err}`, isError: true };
      }

      const summary = `Attached "${filename}" (${formatSize(meta.size)}, ${meta.category}). Visible in chat.`;
      return {
        content: summary,
        attachments: [metaForToolResult(meta, caption)],
      };
    },
  };

  const attachUrlFile: Tool = {
    name: "attach_url_file",
    description:
      "Fetch a file from an http(s) URL and attach it to your reply so the user can see/download it. Use for SENDING a file from the internet (an image you found, a downloadable document, etc.). The URL is fetched server-side — the file ends up on the user's chat. Do NOT use for files already on the host (use attach_local_file). Only http and https schemes are allowed.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full http(s) URL to fetch. Must be a direct file URL — not a webpage.",
        },
        filename: {
          type: "string",
          description: "Optional override for the displayed filename. If omitted, derived from the URL path or Content-Disposition header.",
        },
        caption: {
          type: "string",
          description: "Optional one-line description of what this file is. Shown alongside the attachment.",
        },
      },
      required: ["url"],
    },
    async execute(input, context) {
      const rawUrl = String(input.url ?? "").trim();
      const filenameOverride = input.filename ? String(input.filename) : undefined;
      const caption = input.caption ? String(input.caption) : undefined;
      if (!rawUrl) {
        return { content: "Error: 'url' is required.", isError: true };
      }
      if (!context?.agentId || !context?.sessionId) {
        return { content: "Error: tool needs agent + session context to attach a file.", isError: true };
      }

      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return { content: `Invalid URL: ${rawUrl}`, isError: true };
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { content: `Only http(s) URLs are allowed (got ${url.protocol}).`, isError: true };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      // Compose the turn's signal with the local timeout so /stop cancels
      // the download immediately instead of waiting out the full 30s.
      const fetchSignal = context.signal
        ? AbortSignal.any([controller.signal, context.signal])
        : controller.signal;

      let response: Response;
      try {
        // safeFetch blocks private/loopback/metadata targets and re-validates
        // every redirect hop (no public→internal 30x bounce).
        response = await safeFetch(url.href, {
          signal: fetchSignal,
          headers: { "User-Agent": "rev-mantle/agent-attachment" },
          // Per-job egress containment (cron) — only allow-listed domains; unset
          // for chat (the SSRF block still applies either way).
          allowedHosts: context?.egressAllowList,
        });
      } catch (err) {
        clearTimeout(timer);
        const reason = context.signal?.aborted
          ? "cancelled"
          : err instanceof Error && err.name === "AbortError"
            ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
            : err instanceof Error ? err.message : String(err);
        return { content: `Fetch failed: ${reason}`, isError: true };
      }
      clearTimeout(timer);

      if (!response.ok) {
        return { content: `Fetch returned ${response.status} ${response.statusText}`, isError: true };
      }

      // Length check before reading the body — don't load 500MB into
      // memory only to reject it. Some servers don't send Content-Length;
      // we re-check after reading too.
      const declaredLen = Number(response.headers.get("content-length") ?? 0);
      if (declaredLen > maxBytes) {
        return {
          content: `Remote file ${formatSize(declaredLen)} exceeds the ${config.session.agentAttachmentMaxSizeMB}MB cap.`,
          isError: true,
        };
      }

      const contentType = (response.headers.get("content-type") ?? "application/octet-stream")
        .split(";")[0]
        .trim();

      // Pull filename from Content-Disposition if the caller didn't
      // override and the URL itself doesn't carry a usable name.
      let cdFilename: string | undefined;
      const cd = response.headers.get("content-disposition");
      if (cd) {
        const utf = cd.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
        if (utf) {
          try { cdFilename = decodeURIComponent(utf[1]); } catch { /* ignore */ }
        }
        if (!cdFilename) {
          const ascii = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
          if (ascii) cdFilename = ascii[1].trim();
        }
      }

      const filename = filenameOverride ?? cdFilename ?? deriveFilenameFromUrl(url, contentType);

      let buffer: Buffer;
      try {
        // Stream with a hard cap so a server that lies about / omits
        // Content-Length can't make us buffer past the limit (the precheck
        // above only catches honest servers). A capped read returns ~maxBytes,
        // which trips the size check below.
        const { bytes } = await readResponseCapped(response, maxBytes);
        buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch (err) {
        return { content: `Failed to read response body: ${err instanceof Error ? err.message : err}`, isError: true };
      }

      if (buffer.byteLength === 0) {
        return { content: `Fetched 0 bytes from ${url.href}`, isError: true };
      }
      if (buffer.byteLength > maxBytes) {
        return {
          content: `Downloaded ${formatSize(buffer.byteLength)} exceeds the ${config.session.agentAttachmentMaxSizeMB}MB cap.`,
          isError: true,
        };
      }

      let meta;
      try {
        meta = await registerAgentAttachment({
          baseMantleDir,
          agentId: context.agentId,
          sessionId: context.sessionId,
          originalName: filename,
          mediaType: contentType,
          buffer,
        });
      } catch (err) {
        return { content: `Failed to register attachment: ${err instanceof Error ? err.message : err}`, isError: true };
      }

      const summary = `Fetched "${filename}" (${formatSize(meta.size)}, ${meta.category}) from ${url.host} and attached. Visible in chat.`;
      return {
        content: summary,
        attachments: [metaForToolResult(meta, caption)],
      };
    },
  };

  return [attachLocalFile, attachUrlFile];
}
