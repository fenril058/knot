import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from '../core/id.ts';
import type { Attachment, Storage } from './types.ts';

export type StoreAttachmentInput = {
  storage: Storage;
  filesDir: string;
  projectId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  userId: string;
  now: number;
  replaceGenericMetadata?: boolean;
};

export type StoreAttachmentResult = { attachment: Attachment; created: boolean };

export function attachmentUrl(attachment: Pick<Attachment, 'id' | 'filename'>): string {
  return `/files/${attachment.id}/${encodeURIComponent(attachment.filename)}`;
}

async function replaceFile(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function ensureFile(path: string, bytes: Uint8Array, sha256: string): Promise<void> {
  try {
    const current = await readFile(path);
    if (createHash('sha256').update(current).digest('hex') === sha256) return;
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await replaceFile(path, bytes);
}

export async function storeAttachment(input: StoreAttachmentInput): Promise<StoreAttachmentResult> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  await mkdir(input.filesDir, { recursive: true });
  const existing = await input.storage.findAttachmentBySha256(input.projectId, sha256);
  if (existing !== null) {
    await ensureFile(join(input.filesDir, existing.id), input.bytes, sha256);
    if (
      input.replaceGenericMetadata === true
      && existing.contentType === 'application/octet-stream'
      && (existing.filename !== input.filename || existing.contentType !== input.contentType)
    ) {
      await input.storage.updateAttachmentMetadata(existing.id, input.filename, input.contentType);
      return {
        attachment: { ...existing, filename: input.filename, contentType: input.contentType },
        created: false,
      };
    }
    return { attachment: existing, created: false };
  }

  const attachment: Attachment = {
    id: ulid(input.now * 1000),
    projectId: input.projectId,
    filename: input.filename,
    contentType: input.contentType,
    size: input.bytes.length,
    sha256,
    userId: input.userId,
    created: input.now,
  };
  const finalPath = join(input.filesDir, attachment.id);
  await replaceFile(finalPath, input.bytes);
  try {
    await input.storage.createAttachment(attachment);
    return { attachment, created: true };
  } catch (error) {
    await rm(finalPath, { force: true });
    const raced = await input.storage.findAttachmentBySha256(input.projectId, sha256);
    if (raced !== null) {
      await ensureFile(join(input.filesDir, raced.id), input.bytes, sha256);
      return { attachment: raced, created: false };
    }
    throw error;
  }
}
