import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from '../core/id.ts';
import { StorageError, type Attachment, type AttachmentRepository } from '../storage/types.ts';

export type StoreAttachmentInput = {
  storage: AttachmentRepository;
  filesDir: string;
  projectId: string;
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  actorId: string;
  now: number;
  replaceGenericMetadata?: boolean;
  claimOwner?: string;
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

async function reconcileMetadata(
  storage: AttachmentRepository,
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

async function reuseStoredAttachment(
  input: StoreAttachmentInput,
  sha256: string,
  claimOwner: string,
): Promise<StoreAttachmentResult | null> {
  const existing = await input.storage.reuseAttachmentBySha256(input.projectId, sha256, claimOwner);
  if (existing === null) return null;
  try {
    await ensureFile(join(input.filesDir, existing.id), input.bytes, sha256);
    const attachment = await reconcileMetadata(input.storage, existing, input);
    if (input.claimOwner === undefined) await input.storage.finalizeAttachmentClaims(claimOwner);
    return { attachment, created: false };
  } catch (error) {
    if (input.claimOwner === undefined) {
      await releaseAttachmentClaims(input.storage, input.filesDir, claimOwner);
    }
    throw error;
  }
}

export async function releaseAttachmentClaims(
  storage: AttachmentRepository,
  filesDir: string,
  owner: string,
): Promise<void> {
  const removedIds = await storage.releaseAttachmentClaims(owner);
  await Promise.all(removedIds.map((id) => rm(join(filesDir, id), { force: true })));
}

export async function storeAttachment(input: StoreAttachmentInput): Promise<StoreAttachmentResult> {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');
  await mkdir(input.filesDir, { recursive: true });
  const reuseClaimOwner = input.claimOwner ?? randomUUID();
  const existing = await reuseStoredAttachment(input, sha256, reuseClaimOwner);
  if (existing !== null) return existing;

  const attachment: Attachment = {
    id: ulid(input.now * 1000),
    projectId: input.projectId,
    filename: input.filename,
    contentType: input.contentType,
    size: input.bytes.length,
    sha256,
    actorId: input.actorId,
    created: input.now,
  };
  const finalPath = join(input.filesDir, attachment.id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await replaceFile(finalPath, input.bytes);
    try {
      const result = await input.storage.tryCreateAttachment(attachment, input.claimOwner);
      if (result.kind === 'created') return { attachment, created: true };
      await rm(finalPath, { force: true });
      const raced = await reuseStoredAttachment(input, sha256, reuseClaimOwner);
      if (raced !== null) return raced;
      if (attempt === 1) throw new StorageError('attachment creation conflict could not be resolved');
    } catch (error) {
      await rm(finalPath, { force: true });
      throw error;
    }
  }
  throw new StorageError('attachment creation retry exhausted');
}
