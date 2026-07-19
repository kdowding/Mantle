// Attachment composer + upload logic. Staged files live in `composer.pending`
// (with blob previews); on send they're uploaded and turned into rendered
// Attachments. Ported from app.js's addFileAttachment / uploadAttachments /
// inferAttachmentCategory.
import { composer, type Attachment } from './state.svelte';
import { uploadFiles, uploadUrl, type UploadedFile } from './api';

let idCounter = 0;

function kindFromMime(type: string): Attachment['kind'] {
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'file';
}

// Server category (authoritative) → kind; text/pdf/binary collapse to a card.
export function kindFromCategory(category: string, mediaType: string): Attachment['kind'] {
  if (category === 'image') return 'image';
  if (category === 'audio') return 'audio';
  if (category === 'video') return 'video';
  if (category) return 'file';
  return kindFromMime(mediaType);
}

export function addFile(file: File): void {
  const kind = kindFromMime(file.type);
  composer.pending.push({
    id: idCounter++,
    kind,
    name: file.name,
    size: file.size,
    file,
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : '',
  });
}

// Long pasted text → a staged .txt attachment (rides the normal upload path).
export function addTextFile(text: string): void {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  addFile(new File([text], `paste-${ts}.txt`, { type: 'text/plain' }));
}

export function removePending(id: number): void {
  const i = composer.pending.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [removed] = composer.pending.splice(i, 1);
  if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
}

export function clearPending(): void {
  for (const p of composer.pending) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
  composer.pending = [];
}

// Upload all staged files; returns server fileIds (for the WS payload) + the
// rendered Attachments (for the user bubble).
export async function uploadPending(
  agentId: string,
  sessionId: string,
): Promise<{ fileIds: string[]; attachments: Attachment[] }> {
  const uploaded = await uploadFiles(agentId, sessionId, composer.pending.map((p) => p.file));
  return {
    fileIds: uploaded.map((u) => u.fileId),
    attachments: uploaded.map((u) => uploadedToAttachment(agentId, sessionId, u)),
  };
}

function uploadedToAttachment(agentId: string, sessionId: string, u: UploadedFile): Attachment {
  return {
    kind: kindFromCategory(u.category, u.mediaType),
    name: u.originalName,
    size: u.size,
    url: uploadUrl(agentId, sessionId, u.fileId),
    mediaType: u.mediaType,
    extractedText: u.extractedText,
  };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
