import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCosense } from '../../src/storage/import.ts';
import { releaseAttachmentClaims, storeAttachment } from '../../src/storage/attachmentFiles.ts';
import { StorageError } from '../../src/storage/types.ts';
import { makeStorage } from '../helpers/storage.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

void test('public な Cosense 添付画像を保存し、本文をローカル URL に書き換える', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const requested: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const redirectedUrl = 'https://storage.googleapis.com/scrapbox-file-distribute/project/object?signature=x';
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push({ url, redirect: init?.redirect });
    assert.ok(init?.signal instanceof AbortSignal);
    if (url.startsWith('https://scrapbox.io/')) {
      return new Response(null, { status: 302, headers: { location: redirectedUrl } });
    }
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  };
  try {
    const sourceUrl = 'https://scrapbox.io/files/abc123#.png';
    const options = {
      projectName: 'sandbox',
      now: 1_760_000_000,
      attachments: { filesDir, fetchFn, maxBytes: 10 * 1024 * 1024, timeoutMs: 10_000 },
    };
    await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}]`] }],
    }, options);

    assert.deepEqual(requested, [
      { url: sourceUrl, redirect: 'manual' },
      { url: redirectedUrl, redirect: 'error' },
    ]);
    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const attachments = await storage.listAttachments(project.id);
    assert.equal(attachments.length, 1);
    const attachment = attachments[0]!;
    assert.equal(attachment.contentType, 'image/png');
    assert.equal(attachment.filename, 'abc123.png');
    assert.deepEqual(readFileSync(join(filesDir, attachment.id)), Buffer.from(PNG));

    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.equal(page.lines[1]!.text, `[/files/${attachment.id}/abc123.png]`);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('skip する既存ページの添付は取得も保存もしない', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const sourceUrl = 'https://scrapbox.io/files/skipped#.png';
  let requests = 0;
  try {
    await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', 'original'] }],
    }, { projectName: 'sandbox', now: 1_760_000_000 });

    const summary = await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      now: 1_760_000_001,
      attachments: {
        filesDir,
        fetchFn: async () => {
          requests++;
          return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        },
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });

    assert.equal(requests, 0);
    assert.deepEqual(summary, {
      created: 0,
      overwritten: 0,
      skipped: 1,
      users: 0,
      attachments: { created: 0, reused: 0, failed: 0 },
    });
    const project = await storage.getProject('sandbox');
    assert.ok(project);
    assert.deepEqual(await storage.listAttachments(project.id), []);
    assert.equal(existsSync(filesDir), false);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('ページ検証が失敗する場合は添付を保存しない', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const sourceUrl = 'https://scrapbox.io/files/invalid#.png';
  const duplicateId = '61f0c1d2e3a4b5c6d7e8f902';
  try {
    await assert.rejects(importCosense(storage, {
      name: 'source',
      pages: [{
        title: 'Page',
        lines: [
          { id: duplicateId, text: 'Page' },
          { id: duplicateId, text: `[${sourceUrl}]` },
        ],
      }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir,
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    }), StorageError);

    const project = await storage.getProject('sandbox');
    assert.ok(project);
    assert.deepEqual(await storage.listAttachments(project.id), []);
    assert.equal(existsSync(filesDir), false);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('画像と同じ URL がコードブロックや通常リンクにあっても画像記法だけを書き換える', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const sourceUrl = 'https://scrapbox.io/files/example#.png';
  try {
    await importCosense(storage, {
      name: 'source',
      pages: [{
        title: 'Page',
        lines: ['Page', 'code:example.txt', ` ${sourceUrl}`, `[download ${sourceUrl}]`, `[${sourceUrl}]`],
      }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir: join(root, 'files'),
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });

    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.equal(page.lines[2]!.text, ` ${sourceUrl}`);
    assert.equal(page.lines[3]!.text, `[download ${sourceUrl}]`);
    assert.match(page.lines[4]!.text, /^\[\/files\/[0-9A-HJKMNP-TV-Z]{26}\/example\.png\]$/);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('改行を含む行の画像 URL を書き換えても元の行境界と後続行を保つ', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const sourceUrl = 'https://scrapbox.io/files/multiline#.png';
  try {
    await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `before\n[${sourceUrl}]`, 'after'] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir: join(root, 'files'),
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });

    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.equal(page.lines.length, 3);
    assert.match(page.lines[1]!.text, /^before\n\[\/files\/[0-9A-HJKMNP-TV-Z]{26}\/multiline\.png\]$/);
    assert.equal(page.lines[2]!.text, 'after');
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('画像リンク先に同じ URL が先行しても画像 URL だけを書き換える', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const sourceUrl = 'https://scrapbox.io/files/same-link#.png';
  try {
    await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}#click ${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir: join(root, 'files'),
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });

    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.match(
      page.lines[1]!.text,
      /^\[https:\/\/scrapbox\.io\/files\/same-link#\.png#click \/files\/[0-9A-HJKMNP-TV-Z]{26}\/same-link\.png\]$/,
    );
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('画像 URL と同じ接頭辞のリンク先が後続しても画像 URL だけを書き換える', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const sourceUrl = 'https://scrapbox.io/files/prefix-link#.png';
  try {
    await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}  ${sourceUrl}#click]`] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir: join(root, 'files'),
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });

    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.match(
      page.lines[1]!.text,
      /^\[\/files\/[0-9A-HJKMNP-TV-Z]{26}\/prefix-link\.png  https:\/\/scrapbox\.io\/files\/prefix-link#\.png#click\]$/,
    );
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('長い Unicode ファイル名をコードポイント境界で切り詰める', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const basename = `${'a'.repeat(199)}😀`;
  const sourceUrl = `https://scrapbox.io/files/${encodeURIComponent(basename)}#.png`;
  try {
    await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir: join(root, 'files'),
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });

    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const attachments = await storage.listAttachments(project.id);
    assert.equal(attachments.length, 1);
    assert.doesNotThrow(() => encodeURIComponent(attachments[0]!.filename));
    assert.equal(Array.from(attachments[0]!.filename).length, 204);
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.match(page.lines[1]!.text, /^\[\/files\/[0-9A-HJKMNP-TV-Z]{26}\//);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('既存の同一内容添付を画像用の MIME type とファイル名へ整合する', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const project = await storage.ensureProject('sandbox', 1_760_000_000);
  try {
    await storeAttachment({
      storage,
      filesDir,
      projectId: project.id,
      filename: 'blob',
      contentType: 'application/octet-stream',
      bytes: PNG,
      userId: 'u',
      now: 1_760_000_000,
    });
    const sourceUrl = 'https://scrapbox.io/files/canonical#.png';

    const summary = await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir,
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });

    assert.deepEqual(summary.attachments, { created: 0, reused: 1, failed: 0 });
    const attachments = await storage.listAttachments(project.id);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.filename, 'canonical.png');
    assert.equal(attachments[0]!.contentType, 'image/png');
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.equal(page.lines[1]!.text, `[/files/${attachments[0]!.id}/canonical.png]`);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('同一 SHA-256 の作成競合後も画像用の MIME type とファイル名へ整合する', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const createAttachment = storage.createAttachment.bind(storage);
  storage.createAttachment = async (attachment) => {
    await createAttachment({
      ...attachment,
      id: '01K742SG0009ED8TWDRA2BHH36',
      filename: 'blob',
      contentType: 'application/octet-stream',
    });
    await createAttachment(attachment);
  };
  try {
    const sourceUrl = 'https://scrapbox.io/files/raced#.png';
    const summary = await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir,
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });

    assert.deepEqual(summary.attachments, { created: 0, reused: 1, failed: 0 });
    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const attachments = await storage.listAttachments(project.id);
    assert.equal(attachments.length, 1);
    assert.equal(attachments[0]!.filename, 'raced.png');
    assert.equal(attachments[0]!.contentType, 'image/png');
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.equal(page.lines[1]!.text, `[/files/${attachments[0]!.id}/raced.png]`);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('SHA-256 作成競合の勝者が消えても作成を再試行する', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const project = await storage.ensureProject('sandbox', 1_760_000_000);
  const createAttachment = storage.createAttachment.bind(storage);
  const releaseClaims = storage.releaseAttachmentClaims.bind(storage);
  let first = true;
  storage.createAttachment = async (attachment, claimOwner) => {
    if (first) {
      first = false;
      await createAttachment({ ...attachment, id: '01K742SG0009ED8TWDRA2BHH37' }, 'winner');
      try {
        await createAttachment(attachment, claimOwner);
      } finally {
        await releaseClaims('winner');
      }
      return;
    }
    await createAttachment(attachment, claimOwner);
  };
  try {
    const stored = await storeAttachment({
      storage,
      filesDir,
      projectId: project.id,
      filename: 'retry.png',
      contentType: 'image/png',
      bytes: PNG,
      userId: 'u',
      now: 1_760_000_000,
      claimOwner: 'loser',
    });

    assert.equal(stored.created, true);
    assert.equal(existsSync(join(filesDir, stored.attachment.id)), true);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('取得中に同名ページが作成されて skip しても未参照添付を残さない', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const sourceUrl = 'https://scrapbox.io/files/race-page#.png';
  let resumeFetch: (() => void) | undefined;
  let notifyFetch: (() => void) | undefined;
  const fetching = new Promise<void>((resolve) => {
    notifyFetch = resolve;
  });
  const fetchFn: typeof fetch = async () => {
    notifyFetch?.();
    await new Promise<void>((resolve) => {
      resumeFetch = resolve;
    });
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  };
  try {
    const importing = importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      attachments: { filesDir, fetchFn, maxBytes: 1024, timeoutMs: 10_000 },
    });
    await fetching;
    await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', 'winner'] }],
    }, { projectName: 'sandbox' });
    resumeFetch?.();

    const summary = await importing;
    assert.deepEqual(summary.attachments, { created: 0, reused: 0, failed: 0 });
    assert.equal(summary.skipped, 1);
    const project = await storage.getProject('sandbox');
    assert.ok(project);
    assert.deepEqual(await storage.listAttachments(project.id), []);
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.equal(page.lines[1]!.text, 'winner');
  } finally {
    resumeFetch?.();
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('補償削除は別ページが参照している添付を残す', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const project = await storage.ensureProject('sandbox', 1_760_000_000);
  const claimOwner = 'referenced-attachment-test';
  try {
    const stored = await storeAttachment({
      storage,
      filesDir,
      projectId: project.id,
      filename: 'used.png',
      contentType: 'image/png',
      bytes: PNG,
      userId: 'u',
      now: 1_760_000_000,
      claimOwner,
    });
    await storage.importPage({
      projectId: project.id,
      page: { id: 'referencing-page', title: 'Page', created: 1, updated: 1 },
      lines: [
        { id: 'reference-title', text: 'Page', created: 1, updated: 1, userId: 'u' },
        {
          id: 'reference-body',
          text: `[/files/${stored.attachment.id}/used.png]`,
          created: 1,
          updated: 1,
          userId: 'u',
        },
      ],
      userId: 'u',
      now: 1,
      onConflict: 'skip',
      attachmentClaimOwner: claimOwner,
    });

    await releaseAttachmentClaims(storage, filesDir, claimOwner);
    assert.equal((await storage.listAttachments(project.id)).length, 1);
    assert.equal(existsSync(join(filesDir, stored.attachment.id)), true);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('補償削除は別 import が確定前に再利用した添付を残す', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const sourceUrl = 'https://scrapbox.io/files/concurrent-reuse#.png';
  const originalImportPage = storage.importPage.bind(storage);
  let resumeTarget: (() => void) | undefined;
  let resumeOther: (() => void) | undefined;
  let notifyTarget: (() => void) | undefined;
  let notifyOther: (() => void) | undefined;
  const targetWaiting = new Promise<void>((resolve) => {
    notifyTarget = resolve;
  });
  const otherWaiting = new Promise<void>((resolve) => {
    notifyOther = resolve;
  });
  const waitTarget = new Promise<void>((resolve) => {
    resumeTarget = resolve;
  });
  const waitOther = new Promise<void>((resolve) => {
    resumeOther = resolve;
  });
  storage.importPage = async (input) => {
    if (input.page.title === 'Target') {
      notifyTarget?.();
      await waitTarget;
    }
    if (input.page.title === 'Other') {
      notifyOther?.();
      await waitOther;
    }
    return originalImportPage(input);
  };
  try {
    const targetImport = importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Target', lines: ['Target', `[${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir,
        fetchFn: async () => {
          const project = await storage.getProject('sandbox');
          assert.ok(project);
          await originalImportPage({
            projectId: project.id,
            page: { id: 'target-winner', title: 'Target', created: 1, updated: 1 },
            lines: [
              { id: 'winner-title', text: 'Target', created: 1, updated: 1, userId: 'u' },
              { id: 'winner-body', text: 'winner', created: 1, updated: 1, userId: 'u' },
            ],
            userId: 'u',
            now: 1,
            onConflict: 'skip',
          });
          return new Response(PNG, { headers: { 'content-type': 'image/png' } });
        },
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });
    await targetWaiting;
    const otherImport = importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Other', lines: ['Other', `[${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir,
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    });
    await otherWaiting;
    resumeTarget?.();
    await targetImport;
    resumeOther?.();
    await otherImport;

    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const page = await storage.getPageByTitle(project.id, 'other');
    assert.ok(page);
    const attachments = await storage.listAttachments(project.id);
    assert.equal(attachments.length, 1);
    assert.equal(existsSync(join(filesDir, attachments[0]!.id)), true);
    assert.equal(page.lines[1]!.text, `[/files/${attachments[0]!.id}/concurrent-reuse.png]`);
  } finally {
    resumeTarget?.();
    resumeOther?.();
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('通常アップロードが再利用した暫定添付を補償削除しない', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const project = await storage.ensureProject('sandbox', 1_760_000_000);
  const claimOwner = 'pending-import';
  try {
    const provisional = await storeAttachment({
      storage,
      filesDir,
      projectId: project.id,
      filename: 'shared.png',
      contentType: 'image/png',
      bytes: PNG,
      userId: 'importer',
      now: 1_760_000_000,
      claimOwner,
    });
    const uploaded = await storeAttachment({
      storage,
      filesDir,
      projectId: project.id,
      filename: 'uploaded.png',
      contentType: 'image/png',
      bytes: PNG,
      userId: 'uploader',
      now: 1_760_000_001,
    });

    assert.equal(uploaded.created, false);
    assert.equal(uploaded.attachment.id, provisional.attachment.id);
    await releaseAttachmentClaims(storage, filesDir, claimOwner);
    assert.equal((await storage.listAttachments(project.id)).length, 1);
    assert.equal(existsSync(join(filesDir, provisional.attachment.id)), true);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('同じ URL は一度だけ取得し、同一 SHA-256 の別 URL は既存添付を再利用する', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const requested: string[] = [];
  const first = 'https://scrapbox.io/files/first#.png';
  const second = 'https://scrapbox.io/files/second#.png';
  const fetchFn: typeof fetch = async (input) => {
    requested.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  };
  try {
    const summary = await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${first}] [${first}] [${second}]`] }],
    }, {
      projectName: 'sandbox',
      now: 1_760_000_000,
      attachments: { filesDir: join(root, 'files'), fetchFn, maxBytes: 1024, timeoutMs: 10_000 },
    });

    assert.deepEqual(requested, [first, second]);
    assert.deepEqual(summary.attachments, { created: 1, reused: 1, failed: 0 });
    const project = await storage.getProject('sandbox');
    assert.ok(project);
    const attachments = await storage.listAttachments(project.id);
    assert.equal(attachments.length, 1);
    const localUrl = `/files/${attachments[0]!.id}/first.png`;
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.equal(page.lines[1]!.text, `[${localUrl}] [${localUrl}] [${localUrl}]`);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('添付の永続化に失敗した場合は import 自体を失敗させる', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const sourceUrl = 'https://scrapbox.io/files/persist-error#.png';
  storage.createAttachment = async () => {
    throw new Error('attachment persistence failed');
  };
  try {
    await assert.rejects(importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', `[${sourceUrl}]`] }],
    }, {
      projectName: 'sandbox',
      attachments: {
        filesDir,
        fetchFn: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }),
        maxBytes: 1024,
        timeoutMs: 10_000,
      },
    }), /attachment persistence failed/);

    const project = await storage.getProject('sandbox');
    assert.ok(project);
    assert.deepEqual(await storage.listAttachments(project.id), []);
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});

void test('取得・検証の失敗は元 URL を残して数え、許可対象外の URL は取得しない', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const names = ['status', 'redirect', 'timeout', 'type', 'magic', 'declared-large', 'stream-large'];
  const urls = names.map((name) => `https://scrapbox.io/files/${name}#.png`);
  const ignored = [
    'http://scrapbox.io/files/http#.png',
    'https://example.com/files/other#.png',
    'https://scrapbox.io:444/files/port#.png',
  ];
  const requested: string[] = [];
  const cancelled = new Set<string>();
  const pendingBody = (name: string): ReadableStream<Uint8Array> => new ReadableStream({
    start(controller) {
      controller.enqueue(PNG);
    },
    cancel() {
      cancelled.add(name);
    },
  });
  const fetchFn: typeof fetch = async (input, init) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(value);
    const name = new URL(value).pathname.split('/').at(-1);
    if (name === 'status') return new Response(pendingBody(name), { status: 403 });
    if (name === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } });
    if (name === 'timeout') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    if (name === 'type') return new Response(pendingBody(name), { headers: { 'content-type': 'text/plain' } });
    if (name === 'magic') return new Response('not png', { headers: { 'content-type': 'image/png' } });
    if (name === 'declared-large') {
      return new Response(pendingBody(name), { headers: { 'content-type': 'image/png', 'content-length': '9' } });
    }
    return new Response(new Uint8Array([...PNG, 0]), { headers: { 'content-type': 'image/png' } });
  };
  try {
    const allUrls = [...urls, ...ignored];
    const summary = await importCosense(storage, {
      name: 'source',
      pages: [{ title: 'Page', lines: ['Page', ...allUrls.map((url) => `[${url}]`)] }],
    }, {
      projectName: 'sandbox',
      now: 1_760_000_000,
      attachments: { filesDir: join(root, 'files'), fetchFn, maxBytes: PNG.length, timeoutMs: 5 },
    });

    assert.deepEqual(requested, urls);
    assert.deepEqual(cancelled, new Set(['status', 'type', 'declared-large']));
    assert.deepEqual(summary.attachments, { created: 0, reused: 0, failed: urls.length });
    const project = await storage.getProject('sandbox');
    assert.ok(project);
    assert.deepEqual(await storage.listAttachments(project.id), []);
    const page = await storage.getPageByTitle(project.id, 'page');
    assert.ok(page);
    assert.deepEqual(page.lines.slice(1).map((line) => line.text), allUrls.map((url) => `[${url}]`));
  } finally {
    await storage.close();
    rmSync(root, { recursive: true });
  }
});
