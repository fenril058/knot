import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeAttachment } from '../../src/application/attachments.ts';
import type {
  Attachment,
  AttachmentRepository,
  CreateAttachmentResult,
} from '../../src/storage/types.ts';

class FakeAttachmentRepository implements AttachmentRepository {
  attachments = new Map<string, Attachment>();
  reused: Attachment | null = null;
  finalized: string[] = [];
  released: string[] = [];
  createError: Error | null = null;

  async tryCreateAttachment(attachment: Attachment): Promise<CreateAttachmentResult> {
    if (this.createError !== null) throw this.createError;
    this.attachments.set(attachment.id, attachment);
    return { kind: 'created' };
  }

  async updateAttachmentMetadata(id: string, filename: string, contentType: string): Promise<void> {
    const attachment = this.attachments.get(id) ?? this.reused;
    if (attachment !== null && attachment !== undefined) {
      const updated = { ...attachment, filename, contentType };
      this.attachments.set(id, updated);
      if (this.reused?.id === id) this.reused = updated;
    }
  }

  async releaseAttachmentClaims(owner: string): Promise<string[]> {
    this.released.push(owner);
    return [];
  }

  async finalizeAttachmentClaims(owner: string): Promise<void> {
    this.finalized.push(owner);
  }

  async reuseAttachmentBySha256(): Promise<Attachment | null> {
    return this.reused;
  }
}

const bytes = new Uint8Array([1, 2, 3, 4]);

void test('添付の metadata と blob を SQLite なしで保存する', async () => {
  const repository = new FakeAttachmentRepository();
  const root = mkdtempSync(join(tmpdir(), 'knot-application-attachment-'));
  try {
    const result = await storeAttachment({
      storage: repository,
      filesDir: root,
      projectId: 'project',
      filename: 'image.bin',
      contentType: 'application/octet-stream',
      bytes,
      actorId: 'actor',
      now: 1_700_000_000,
    });

    assert.equal(result.created, true);
    assert.equal(repository.attachments.get(result.attachment.id)?.actorId, 'actor');
    assert.equal(existsSync(join(root, result.attachment.id)), true);
  } finally {
    rmSync(root, { recursive: true });
  }
});

void test('既存の暫定添付を再利用した通常 upload は claim を finalize する', async () => {
  const repository = new FakeAttachmentRepository();
  repository.reused = {
    id: 'attachment',
    projectId: 'project',
    filename: 'image.bin',
    contentType: 'application/octet-stream',
    size: bytes.length,
    sha256: 'unused-by-fake',
    actorId: 'actor',
    created: 1_700_000_000,
  };
  const root = mkdtempSync(join(tmpdir(), 'knot-application-attachment-'));
  try {
    const result = await storeAttachment({
      storage: repository,
      filesDir: root,
      projectId: 'project',
      filename: 'image.bin',
      contentType: 'application/octet-stream',
      bytes,
      actorId: 'actor',
      now: 1_700_000_000,
    });

    assert.equal(result.created, false);
    assert.equal(repository.finalized.length, 1);
    assert.equal(repository.released.length, 0);
    assert.equal(existsSync(join(root, 'attachment')), true);
  } finally {
    rmSync(root, { recursive: true });
  }
});

void test('metadata 永続化の失敗時は書きかけの blob を残さない', async () => {
  const repository = new FakeAttachmentRepository();
  repository.createError = new Error('metadata failed');
  const root = mkdtempSync(join(tmpdir(), 'knot-application-attachment-'));
  try {
    await assert.rejects(storeAttachment({
      storage: repository,
      filesDir: root,
      projectId: 'project',
      filename: 'image.bin',
      contentType: 'application/octet-stream',
      bytes,
      actorId: 'actor',
      now: 1_700_000_000,
    }), /metadata failed/);

    assert.deepEqual(readdirSync(root), []);
    assert.deepEqual(repository.attachments, new Map());
  } finally {
    rmSync(root, { recursive: true });
  }
});
