import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCosense } from '../../src/storage/import.ts';
import { makeStorage } from '../helpers/storage.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

void test('public な Cosense 添付画像を保存し、本文をローカル URL に書き換える', async () => {
  const { storage } = makeStorage();
  const root = mkdtempSync(join(tmpdir(), 'knot-import-files-'));
  const filesDir = join(root, 'files');
  const requested: string[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    requested.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal instanceof AbortSignal);
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

    assert.deepEqual(requested, [sourceUrl]);
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
  const fetchFn: typeof fetch = async (input, init) => {
    const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(value);
    const name = new URL(value).pathname.split('/').at(-1);
    if (name === 'status') return new Response(null, { status: 403 });
    if (name === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } });
    if (name === 'timeout') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    if (name === 'type') return new Response(PNG, { headers: { 'content-type': 'text/plain' } });
    if (name === 'magic') return new Response('not png', { headers: { 'content-type': 'image/png' } });
    if (name === 'declared-large') {
      return new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': '9' } });
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
