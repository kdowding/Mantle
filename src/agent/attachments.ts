import { resolve, extname } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import type { ProviderMessage } from "../agent/providers/types.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type FileCategory = "image" | "text" | "pdf" | "audio" | "video" | "binary";

export interface FileMetadata {
  fileId: string;
  originalName: string;
  mediaType: string;
  size: number;
  category: FileCategory;
  extractedText?: string;
}

interface MetaSidecar {
  files: Record<string, FileMetadata>;
}

// ── File categorization ─────────────────────────────────────────────────────

const IMAGE_TYPES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml",
]);

// Browser-playable audio/video. The UI renders these as inline <audio>
// / <video controls> elements in the message bubble — no extra
// dependencies needed, every modern browser knows how to play them.
const AUDIO_TYPES = new Set([
  "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave",
  "audio/ogg", "audio/webm", "audio/mp4", "audio/m4a", "audio/x-m4a",
  "audio/aac", "audio/flac", "audio/opus",
]);
const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "ogg", "m4a", "aac", "flac", "opus",
]);

const VIDEO_TYPES = new Set([
  "video/mp4", "video/webm", "video/ogg", "video/quicktime",
]);
const VIDEO_EXTENSIONS = new Set([
  "mp4", "webm", "mov", "ogv",
]);

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "json", "yaml", "yml", "xml", "csv", "tsv",
  "js", "ts", "jsx", "tsx", "mjs", "cjs",
  "py", "rb", "go", "rs", "java", "kt", "scala", "swift",
  "c", "cpp", "h", "hpp", "cs",
  "html", "css", "scss", "less", "sass",
  "sql", "sh", "bash", "zsh", "ps1", "bat", "cmd",
  "toml", "ini", "cfg", "conf", "env", "properties",
  "log", "diff", "patch",
  "r", "m", "lua", "pl", "pm", "ex", "exs", "erl",
  "graphql", "gql", "proto", "tf", "hcl",
  "dockerfile", "makefile", "cmake",
]);

// Files commonly committed without an extension. extname() returns ""
// for these so they'd otherwise fall through to "binary" and lose
// preview / inline text behavior. Match the lowercased basename.
const TEXT_BASENAMES = new Set([
  // Convention files (typically capitalized in repos)
  "dockerfile", "makefile", "rakefile", "gemfile", "procfile", "vagrantfile",
  "license", "readme", "changelog", "authors", "copying",
  "install", "notice", "todo", "contributing", "maintainers",
  // Common dotfiles
  ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig",
  ".npmrc", ".yarnrc", ".babelrc", ".eslintrc", ".prettierrc",
  ".bashrc", ".zshrc", ".profile", ".env",
]);

export function categorizeFile(mediaType: string, filename: string): FileCategory {
  if (IMAGE_TYPES.has(mediaType)) return "image";
  if (mediaType === "application/pdf") return "pdf";
  if (AUDIO_TYPES.has(mediaType)) return "audio";
  if (VIDEO_TYPES.has(mediaType)) return "video";
  if (mediaType.startsWith("text/")) return "text";

  const ext = extname(filename).slice(1).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (TEXT_EXTENSIONS.has(ext)) return "text";

  // Whole-filename allow-list for files without extensions (Dockerfile,
  // Makefile, LICENSE) and dotfiles (.gitignore, .editorconfig). Strip
  // any directory just in case — uploads strip directories anyway.
  const basename = filename.split(/[/\\]/).pop()?.toLowerCase() || "";
  if (TEXT_BASENAMES.has(basename)) return "text";

  // Some text files have generic MIME types
  if (mediaType === "application/json" || mediaType === "application/xml") return "text";
  if (mediaType === "application/javascript" || mediaType === "application/typescript") return "text";
  if (mediaType === "application/x-yaml" || mediaType === "application/x-sh") return "text";

  return "binary";
}

// RFC 6266 + RFC 5987-compliant Content-Disposition value. The legacy
// `filename=` field is ASCII-only and breaks if the name contains a
// quote/backslash/non-ASCII byte; `filename*=UTF-8''...` carries the
// real name and is what modern browsers actually use. Sending both is
// the standard pattern — old clients fall back to the ASCII form, new
// clients recover the full Unicode name.
export function buildContentDisposition(
  filename: string,
  type: "inline" | "attachment" = "inline",
): string {
  const ascii = filename
    .replace(/[^\x20-\x7E]/g, "_")  // non-printable / non-ASCII → _
    .replace(/[\\"]/g, "_");        // backslash + double-quote → _
  const utf8 = encodeURIComponent(filename);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// ── Upload handling ─────────────────────────────────────────────────────────

function getUploadDir(baseMantleDir: string, agentId: string, sessionId: string): string {
  return resolve(baseMantleDir, "uploads", agentId, sessionId);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadMetaSidecar(uploadDir: string): MetaSidecar {
  const metaPath = resolve(uploadDir, "_meta.json");
  if (!existsSync(metaPath)) return { files: {} };
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return { files: {} };
  }
}

// Serialized, atomic _meta.json updates (replaces the old bare-write
// saveMetaSidecar). The upload handlers used to load → (await file
// writes) → save, so two concurrent uploads into the same session dir
// read the same snapshot and the last writer dropped the other's
// entries. The mutate body runs inside a per-dir promise chain with the
// load and the (tmp+rename) save in one synchronous block.
const metaChains = new Map<string, Promise<void>>();

function updateMetaSidecar(uploadDir: string, mutate: (meta: MetaSidecar) => void): Promise<void> {
  const metaPath = resolve(uploadDir, "_meta.json");
  const prev = metaChains.get(metaPath) ?? Promise.resolve();
  const next = prev.then(() => {
    const meta = loadMetaSidecar(uploadDir);
    mutate(meta);
    const tmp = `${metaPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(meta, null, 2), "utf-8");
    renameSync(tmp, metaPath);
  }).catch((err) => {
    console.warn(
      `[MANTLE:uploads] _meta.json update failed (${uploadDir}): ${err instanceof Error ? err.message : err}`,
    );
  });
  metaChains.set(metaPath, next);
  void next.finally(() => {
    if (metaChains.get(metaPath) === next) metaChains.delete(metaPath);
  });
  return next;
}

export async function handleUpload(
  formData: FormData,
  baseMantleDir: string,
  agentId: string,
  sessionId: string,
  maxSizeMB: number,
): Promise<FileMetadata[]> {
  const uploadDir = getUploadDir(baseMantleDir, agentId, sessionId);
  ensureDir(uploadDir);

  const results: FileMetadata[] = [];
  const maxBytes = maxSizeMB * 1024 * 1024;

  for (const value of formData.values()) {
    if (typeof value === "string") continue;

    const file = value as File;
    if (file.size > maxBytes) {
      throw new Error(`File "${file.name}" exceeds ${maxSizeMB}MB limit (${(file.size / 1024 / 1024).toFixed(1)}MB)`);
    }

    const ext = extname(file.name) || "";
    const fileId = `${crypto.randomUUID()}${ext}`;
    const category = categorizeFile(file.type || "application/octet-stream", file.name);

    // Write file to disk
    const filePath = resolve(uploadDir, fileId);
    const buffer = await file.arrayBuffer();
    await Bun.write(filePath, buffer);

    // Extract text content for text files
    let extractedText: string | undefined;
    if (category === "text") {
      try {
        extractedText = new TextDecoder("utf-8").decode(buffer);
      } catch {
        // Not valid UTF-8, treat as binary
      }
    } else if (category === "pdf") {
      extractedText = extractPdfText(Buffer.from(buffer));
    }

    const fileMeta: FileMetadata = {
      fileId,
      originalName: file.name,
      mediaType: file.type || "application/octet-stream",
      size: file.size,
      category,
      extractedText,
    };

    results.push(fileMeta);
  }

  await updateMetaSidecar(uploadDir, (meta) => {
    for (const fm of results) meta.files[fm.fileId] = fm;
  });
  return results;
}

// Register a file an agent produced (read from disk via attach_local_file
// or fetched from a URL via attach_url_file) into the same uploads tree
// user-uploaded files use. The existing /api/uploads/.../:fileId endpoint
// then serves it without needing any new server route, and the UI's
// renderAttachment dispatcher renders it identically to a user upload.
//
// Returns the same FileMetadata shape handleUpload produces, so the
// agent-loop / WS layer can treat both paths uniformly downstream.
export async function registerAgentAttachment(params: {
  baseMantleDir: string;
  agentId: string;
  sessionId: string;
  originalName: string;
  mediaType: string;
  buffer: Buffer | ArrayBuffer | Uint8Array;
}): Promise<FileMetadata> {
  const { baseMantleDir, agentId, sessionId, originalName, mediaType, buffer } = params;
  const uploadDir = getUploadDir(baseMantleDir, agentId, sessionId);
  ensureDir(uploadDir);

  const ext = extname(originalName) || "";
  const fileId = `${crypto.randomUUID()}${ext}`;
  const category = categorizeFile(mediaType, originalName);

  const bytes = buffer instanceof Buffer
    ? buffer
    : Buffer.from(buffer as ArrayBuffer);
  const size = bytes.byteLength;

  await Bun.write(resolve(uploadDir, fileId), bytes);

  let extractedText: string | undefined;
  if (category === "text") {
    try {
      extractedText = new TextDecoder("utf-8").decode(bytes);
    } catch {
      // Not valid UTF-8 — leave undefined, file still serves via download
    }
  } else if (category === "pdf") {
    extractedText = extractPdfText(bytes);
  }

  const fileMeta: FileMetadata = {
    fileId,
    originalName,
    mediaType,
    size,
    category,
    extractedText,
  };
  await updateMetaSidecar(uploadDir, (meta) => {
    meta.files[fileId] = fileMeta;
  });

  return fileMeta;
}

// ── File serving ────────────────────────────────────────────────────────────

export function getFilePath(baseMantleDir: string, agentId: string, sessionId: string, fileId: string): string {
  return resolve(baseMantleDir, "uploads", agentId, sessionId, fileId);
}

export function getFileMetadata(baseMantleDir: string, agentId: string, sessionId: string, fileId: string): FileMetadata | null {
  const uploadDir = getUploadDir(baseMantleDir, agentId, sessionId);
  const meta = loadMetaSidecar(uploadDir);
  return meta.files[fileId] ?? null;
}

// ── PDF text extraction (best-effort, no dependencies) ──────────────────────

function extractPdfText(buffer: Buffer): string | undefined {
  try {
    const raw = buffer.toString("latin1");
    const textParts: string[] = [];

    // Find text between BT (begin text) and ET (end text) operators
    const btEtRegex = /BT\s([\s\S]*?)ET/g;
    let match;

    while ((match = btEtRegex.exec(raw)) !== null) {
      const block = match[1];

      // Extract Tj (show text) operands
      const tjRegex = /\(([^)]*)\)\s*Tj/g;
      let tjMatch;
      while ((tjMatch = tjRegex.exec(block)) !== null) {
        textParts.push(tjMatch[1]);
      }

      // Extract TJ (show text with positioning) operands
      const tjArrayRegex = /\[([\s\S]*?)\]\s*TJ/g;
      let tjArrayMatch;
      while ((tjArrayMatch = tjArrayRegex.exec(block)) !== null) {
        const inner = tjArrayMatch[1];
        const strRegex = /\(([^)]*)\)/g;
        let strMatch;
        while ((strMatch = strRegex.exec(inner)) !== null) {
          textParts.push(strMatch[1]);
        }
      }
    }

    if (textParts.length === 0) return undefined;

    // Unescape PDF string escapes
    const text = textParts
      .join("")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")")
      .replace(/\\\\/g, "\\");

    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

// ── Provider attachment resolution ──────────────────────────────────────────

// Read a file's bytes as base64, memoized per cache key (the upload fileId).
// resolveAttachmentsForProvider runs on every agent-loop iteration, so a
// per-turn cache avoids re-reading + re-encoding immutable upload bytes on
// each pass. No cache passed = read every time (back-compat default).
function readFileBase64(filePath: string, cacheKey: string, cache?: Map<string, string>): string {
  const hit = cache?.get(cacheKey);
  if (hit !== undefined) return hit;
  const base64 = readFileSync(filePath).toString("base64");
  cache?.set(cacheKey, base64);
  return base64;
}

export async function resolveAttachmentsForProvider(
  messages: ProviderMessage[],
  vendor: string,
  baseMantleDir: string,
  agentId: string,
  sessionId: string,
  base64Cache?: Map<string, string>,
): Promise<ProviderMessage[]> {
  const uploadDir = getUploadDir(baseMantleDir, agentId, sessionId);

  // Quick check: any image/file blocks at all?
  const hasAttachments = messages.some(m =>
    m.content.some(b => b.type === "image" || b.type === "file")
  );
  if (!hasAttachments) return messages;

  const result: ProviderMessage[] = [];

  for (const msg of messages) {
    const hasAnyAttachment = msg.content.some(b => b.type === "image" || b.type === "file");
    if (!hasAnyAttachment) {
      result.push(msg);
      continue;
    }

    // Assistant-role attachments came from attach_local_file /
    // attach_url_file — i.e., the model just sent them to the user.
    // The model already saw the tool's success result, so we don't
    // need to re-embed the binary. Collapse to a short text marker
    // for context. Keeps Grok compat (no image blocks in assistant
    // messages on OpenAI-shaped APIs) and saves tokens.
    if (msg.role === "assistant") {
      const collapsed: any[] = [];
      for (const block of msg.content) {
        if (block.type === "image" || block.type === "file") {
          const sizeStr = block.size < 1024
            ? `${block.size} B`
            : block.size < 1024 * 1024
              ? `${(block.size / 1024).toFixed(1)} KB`
              : `${(block.size / (1024 * 1024)).toFixed(1)} MB`;
          collapsed.push({
            type: "text",
            text: `[Attached to user: ${block.filename} (${sizeStr})]`,
          });
        } else {
          collapsed.push(block);
        }
      }
      result.push({ role: msg.role, content: collapsed });
      continue;
    }

    const resolvedContent: any[] = [];

    for (const block of msg.content) {
      if (block.type === "image") {
        const filePath = resolve(uploadDir, block.fileId);
        try {
          const base64 = readFileBase64(filePath, block.fileId, base64Cache);

          if (vendor === "anthropic") {
            resolvedContent.push({
              type: "image",
              source: {
                type: "base64",
                media_type: block.mediaType,
                data: base64,
              },
            });
          } else {
            // Grok / OpenAI format
            resolvedContent.push({
              type: "image_url",
              image_url: {
                url: `data:${block.mediaType};base64,${base64}`,
              },
            });
          }
        } catch {
          // File missing, insert text fallback
          resolvedContent.push({
            type: "text",
            text: `[Image not found: ${block.filename}]`,
          });
        }
      } else if (block.type === "file") {
        if (block.extractedText) {
          resolvedContent.push({
            type: "text",
            text: `[File: ${block.filename}]\n\n${block.extractedText}`,
          });
        } else if (block.mediaType === "application/pdf" && vendor === "anthropic") {
          // Claude supports native PDF blocks
          const filePath = resolve(uploadDir, block.fileId);
          try {
            const base64 = readFileBase64(filePath, block.fileId, base64Cache);
            resolvedContent.push({
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: base64,
              },
            });
          } catch {
            resolvedContent.push({
              type: "text",
              text: `[PDF not found: ${block.filename}]`,
            });
          }
        } else {
          // Binary or unextractable file
          const sizeStr = block.size < 1024
            ? `${block.size} B`
            : block.size < 1024 * 1024
              ? `${(block.size / 1024).toFixed(1)} KB`
              : `${(block.size / (1024 * 1024)).toFixed(1)} MB`;
          resolvedContent.push({
            type: "text",
            text: `[Attached file: ${block.filename} (${sizeStr}, ${block.mediaType})]`,
          });
        }
      } else {
        resolvedContent.push(block);
      }
    }

    result.push({ role: msg.role, content: resolvedContent });
  }

  return result;
}
