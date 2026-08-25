import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

async function setup() {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);
  const put = (title: string, body: unknown) =>
    s.request(`/api/knot/pages/proj/${encodeURIComponent(title)}/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, cookie);
  const getText = (title: string) => s.request(`/api/pages/proj/${encodeURIComponent(title)}/text`, {}, cookie);
  return { s, put, getText };
}

void test('新規作成 → 全文置換 → GET text で往復', async () => {
  const { put, getText } = await setup();
  const create = await put('Doc', { baseVersion: 0, text: 'Doc\nline one\nline two' });
  assert.equal(create.status, 200);
  const created = await create.json();
  assert.equal(created.version, 1);
  assert.match(created.commitId, /^[0-9A-HJKMNP-TV-Z]{26}$/);

  const update = await put('Doc', { baseVersion: 1, text: 'Doc\nline one changed\nline two\nline three' });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).version, 2);
  assert.equal(await (await getText('Doc')).text(), 'Doc\nline one changed\nline two\nline three');
});

void test('変更のない PUT はコミットを作らない', async () => {
  const { put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nsame' });
  const noop = await put('Doc', { baseVersion: 1, text: 'Doc\nsame' });
  assert.equal(noop.status, 200);
  assert.deepEqual(await noop.json(), { version: 1, commitId: null });
});

void test('baseVersion 不一致は 409 で最新状態を返す', async () => {
  const { put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nv1' });
  await put('Doc', { baseVersion: 1, text: 'Doc\nv2' });
  const stale = await put('Doc', { baseVersion: 1, text: 'Doc\nv3' });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.reason, 'version');
  assert.equal(body.page.lines.map((l: { text: string }) => l.text).join('\n'), 'Doc\nv2');
});

void test('編集で残った行の ID とメタデータは保持される', async () => {
  const { s, put } = await setup();
  await put('Doc', { baseVersion: 0, text: 'Doc\nkeep me\ndrop me' });
  const project = await s.storage.getProject('proj');
  const before = await s.storage.getPageByTitle(project!.id, 'doc');
  const keepId = before!.lines[1]!.id;
  await put('Doc', { baseVersion: 1, text: 'Doc\nkeep me\nnew line' });
  const after = await s.storage.getPageByTitle(project!.id, 'doc');
  assert.equal(after!.lines[1]!.id, keepId); // 不変の行は ID が変わらない
});

void test('形式不正は 400', async () => {
  const { put } = await setup();
  assert.equal((await put('Doc', { baseVersion: 0, text: '' })).status, 400);
  assert.equal((await put('Doc', { baseVersion: 0 })).status, 400);
  assert.equal((await put('Doc', { baseVersion: -1, text: 'Doc' })).status, 400);
  // 新規作成で先頭行が URL タイトルと不一致
  assert.equal((await put('Doc', { baseVersion: 0, text: 'Other\nbody' })).status, 400);
  // ページ不在で baseVersion != 0
  assert.equal((await put('Ghost', { baseVersion: 2, text: 'Ghost' })).status, 404);
});
