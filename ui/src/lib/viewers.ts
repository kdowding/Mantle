// File-preview dispatch + parse helpers — the Svelte port of ui/viewers.js.
// Targets live on `overlay` (state.svelte.ts); components/DocViewer +
// TextViewer render them; the shared Attachments card calls openFilePreview.
// Dispatch: image → lightbox · PDF → doc viewer · text-like → text viewer
// (extractedText when present, else fetched) · anything else → new tab.
import { overlay, type Attachment } from './state.svelte';

// Mirrors the server's categorizeFile text allow-list (src/server/attachments.ts).
const TEXT_EXTS = new Set([
  'md', 'markdown', 'txt', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml',
  'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'svelte', 'vue',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'sh', 'bash',
  'ps1', 'bat', 'toml', 'ini', 'cfg', 'conf', 'env', 'sql', 'lua', 'php',
  'swift', 'kt', 'diff', 'patch',
]);

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

export function openFilePreview(att: Attachment): void {
  if (att.kind === 'image') {
    overlay.lightboxUrl = att.url;
    return;
  }
  const ext = extOf(att.name);
  if (att.mediaType === 'application/pdf' || ext === 'pdf') {
    overlay.doc = { url: att.url, name: att.name };
    return;
  }
  if ((att.mediaType ?? '').startsWith('text/') || TEXT_EXTS.has(ext)) {
    void openTextPreview(att);
    return;
  }
  window.open(att.url, '_blank', 'noopener');
}

async function openTextPreview(att: Attachment): Promise<void> {
  if (att.extractedText) {
    overlay.text = { name: att.name, content: att.extractedText };
    return;
  }
  try {
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(String(res.status));
    overlay.text = { name: att.name, content: await res.text() };
  } catch {
    window.open(att.url, '_blank', 'noopener');
  }
}

// Minimal CSV parser — quoted fields containing the separator or newlines,
// `""` as an escaped quote. Not RFC-4180-perfect; covers what people actually
// drop into a chat. Ported verbatim from ui/viewers.js.
export function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      cell += ch;
    } else {
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === sep) { row.push(cell); cell = ''; continue; }
      if (ch === '\r') continue;
      if (ch === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; continue; }
      cell += ch;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].length > 0));
}

export function prettyJson(text: string): { pretty: string; valid: boolean } {
  try {
    return { pretty: JSON.stringify(JSON.parse(text), null, 2), valid: true };
  } catch {
    return { pretty: text, valid: false };
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Lightweight regex JSON highlighter (runs on escaped text, hence &quot;).
// Covers the 99% case for human-readable JSON; rendered via {@html}.
export function highlightJson(json: string): string {
  return escapeHtml(json)
    .replace(/(&quot;[^&]*?&quot;)\s*:/g, '<span class="json-key">$1</span>:')
    .replace(/:\s*(&quot;[^&]*?&quot;)/g, ': <span class="json-string">$1</span>')
    .replace(/:\s*(true|false|null)\b/g, ': <span class="json-keyword">$1</span>')
    .replace(/:\s*(-?\d+\.?\d*([eE][+-]?\d+)?)/g, ': <span class="json-number">$1</span>');
}
