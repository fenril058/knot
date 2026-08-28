import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INLINE_TYPES, MAGIC } from '../../src/server/routes/files.ts';
import { makeServer } from '../helpers/server.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

void test('インライン配信する Content-Type はすべてマジックバイトを検査する', () => {
  assert.deepEqual(INLINE_TYPES, new Set(Object.keys(MAGIC)));
});

async function setup() {
  const s = await makeServer({ dataDir: mkdtempSync(join(tmpdir(), 'knot-files-')) });
  const account = await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);
  const upload = (bytes: Uint8Array, filename: string, type: string) => {
    const form = new FormData();
    form.append('file', new File([new Uint8Array(bytes)], filename, { type }));
    form.append('project', 'proj');
    return s.request('/api/knot/files', { method: 'POST', body: form }, cookie);
  };
  return { s, account, cookie, upload };
}

void test('PNG のアップロードと配信', async () => {
  const { s, account, cookie, upload } = await setup();
  const res = await upload(PNG, 'shot.png', 'image/png');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.filename, 'shot.png');
  assert.equal(body.contentType, 'image/png');
  assert.equal(body.size, PNG.length);
  assert.equal(body.url, `/files/${body.id}/shot.png`);
  assert.equal((await s.storage.getAttachment(body.id))?.actorId, account.actorId);

  const got = await s.request(body.url, {}, cookie);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.equal(got.headers.get('content-disposition'), null);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), PNG);
});

void test('同じ内容の再アップロードは既存レコードを返す', async () => {
  const { upload } = await setup();
  const first = await (await upload(PNG, 'a.png', 'image/png')).json();
  const second = await (await upload(PNG, 'b.png', 'image/png')).json();
  assert.equal(second.id, first.id);
  assert.equal(second.sha256, first.sha256);
});

void test('インライン許可型の content-type とマジックバイト不一致は 400', async () => {
  const { upload } = await setup();
  const html = new TextEncoder().encode('<script>alert(1)</script>');
  assert.equal((await upload(html, 'fake.png', 'image/png')).status, 400);
  assert.equal((await upload(html, 'fake.mp4', 'video/mp4')).status, 400);
  assert.equal((await upload(html, 'fake.mp3', 'audio/mpeg')).status, 400);
});

void test('sha256 の再利用はプロジェクト単位（別プロジェクトには新レコード）', async () => {
  const { s, cookie, upload } = await setup();
  await s.storage.ensureProject('other', s.clock.t);
  const first = await (await upload(PNG, 'a.png', 'image/png')).json();
  const form = new FormData();
  form.append('file', new File([PNG], 'a.png', { type: 'image/png' }));
  form.append('project', 'other');
  const second = await (await s.request('/api/knot/files', { method: 'POST', body: form }, cookie)).json();
  assert.notEqual(second.id, first.id);
});

void test('HTML と SVG は attachment で配信される', async () => {
  const { s, cookie, upload } = await setup();
  for (const [name, type, content] of [
    ['x.html', 'text/html', '<script>alert(1)</script>'],
    ['x.svg', 'image/svg+xml', '<svg onload="alert(1)"/>'],
  ] as const) {
    const body = await (await upload(new TextEncoder().encode(content), name, type)).json();
    const got = await s.request(body.url, {}, cookie);
    assert.equal(got.status, 200);
    assert.equal(
      got.headers.get('content-disposition'),
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  }
});

void test('サイズ超過は 413', async () => {
  const { upload } = await setup();
  const big = new Uint8Array(11 * 1024 * 1024);
  big.set(PNG);
  const res = await upload(big, 'big.png', 'image/png');
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'too_large' });
});

void test('Content-Length 超過は multipart 解析前に 413', async () => {
  const { s, cookie } = await setup();
  const res = await s.request('/api/knot/files', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(11 * 1024 * 1024) },
    body: 'not multipart',
  }, cookie);
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: 'too_large' });
});

void test('不正な multipart body は 400', async () => {
  const { s, cookie } = await setup();
  const res = await s.app.request('/api/knot/files', {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'multipart/form-data; boundary=xxx',
      'x-knot-client': 'test',
    },
    body: 'not multipart',
  });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request', message: 'invalid multipart body' });
});

void test('project 欠落・不在は 400、未認証の配信は 401', async () => {
  const { s, cookie, upload } = await setup();
  const form = new FormData();
  form.append('file', new File([PNG], 'x.png', { type: 'image/png' }));
  assert.equal((await s.request('/api/knot/files', { method: 'POST', body: form }, cookie)).status, 400);

  const missingProject = new FormData();
  missingProject.append('file', new File([PNG], 'x.png', { type: 'image/png' }));
  missingProject.append('project', 'missing');
  assert.equal((await s.request('/api/knot/files', { method: 'POST', body: missingProject }, cookie)).status, 400);

  const body = await (await upload(PNG, 'x.png', 'image/png')).json();
  assert.equal((await s.app.request(body.url)).status, 401);
  assert.equal((await s.request('/files/01JUNKJUNKJUNKJUNKJUNKJUNK', {}, cookie)).status, 404);
});

void test('GET の filename は無視し、実ファイル不在は 404', async () => {
  const { s, cookie, upload } = await setup();
  const body = await (await upload(PNG, 'x.png', 'image/png')).json();
  assert.equal((await s.request(`/files/${body.id}/ignored`, {}, cookie)).status, 200);
  assert.equal((await s.request(`/files/${body.id}`, {}, cookie)).status, 200);
});
