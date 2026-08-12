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
  claimOwner?: string;
};

export type StoreAttachmentResult = { attachment: Attachment; created: boolean };

const SQLITE_CONSTRAINT_UNIQUE = 2067;

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

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'errcode' in error
    && error.errcode === SQLITE_CONSTRAINT_UNIQUE;
}

async function reconcileMetadata(
  storage: Storage,
  attachment: Attachment,
  input: StoreAttachmentInput,
): Promise<Attachment> {
  if (
    input.replaceGenericMetadata !== true
    || attachment.contentType !== 'application/octet-stream'
    || (attachment.filename === input.filename && attachment.contentType === input.contentType)
  ) return attachment;
  await storage.updateAttachmentMetadata(attachment.id, input.filename, input.contentType);
  return { ...attachment, filename: input.filename, contentType: input.contentType };
}

export async function releaseAttachmentClaims(
  storage: Storage,
  filesDir: string,
  owner: string,
): Promise<void> {
  const removedIds = await storage.releaseAttachmentClaims(owner);
  await Promise.all(removedIds.map((id) => rm(join(filesDir, id), { force: true })));
}

export async function storeAttachment(input: StoreAttachmentInput): Promise<StoreAttachmentResult> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  await mkdir(input.filesDir, { recursive: true });
  const existing = await input.storage.reuseAttachmentBySha256(input.projectId, sha256, input.claimOwner);
  if (existing !== null) {
    await ensureFile(join(input.filesDir, existing.id), input.bytes, sha256);
    return { attachment: await reconcileMetadata(input.storage, existing, input), created: false };
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await replaceFile(finalPath, input.bytes);
    try {
      await input.storage.createAttachment(attachment, input.claimOwner);
      return { attachment, created: true };
    } catch (error) {
      await rm(finalPath, { force: true });
      const raced = await input.storage.reuseAttachmentBySha256(input.projectId, sha256, input.claimOwner);
      if (raced !== null) {
        await ensureFile(join(input.filesDir, raced.id), input.bytes, sha256);
        return { attachment: await reconcileMetadata(input.storage, raced, input), created: false };
      }
      if (!isUniqueConstraint(error) || attempt === 1) throw error;
    }
  }
  throw new Error('attachment creation retry exhausted');
}
