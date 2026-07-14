import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { ulid } from '../../src/core/id.ts';

async function setup() {
  const s = await makeServer();
  const userId = await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);
  const post = (title: string, body: unknown) =>
    s.request(`/api/knot/pages/proj/${encodeURIComponent(title)}/commits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, cookie);
  return { s, cookie, userId, post };
}

test('新規作成 → 編集 → 冪等な再送', async () => {
  const { s, post, userId } = await setup();
  const l1 = ulid();
  const create = await post('New Page', {
    commitId: ulid(), baseVersion: 0,
    ops: [{ type: 'insert', id: l1, after: '_head', text: 'New Page' }],
  });
  assert.equal(create.status, 200);
  assert.deepEqual(await create.json(), { version: 1 });

  const editId = ulid();
  const edit = { commitId: editId, baseVersion: 1, ops: [{ type: 'update', id: l1, text: 'New Page!' }] };
  const first = await post('New Page', edit);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { version: 2 });
  const resend = await post('New Page!', edit); // タイトルが変わったので URL も新タイトル
  assert.equal(resend.status, 200);
  assert.deepEqual(await resend.json(), { version: 2 }); // 冪等: 最初の version

  // 行の userId はセッションユーザー
  const project = await s.storage.getProject('proj');
  const page = await s.storage.getPageByTitle(project!.id, 'new_page!');
  assert.equal(page!.lines[0].userId, userId);
});

test('baseVersion 不一致は 409 reason version で最新状態を返す', async () => {
  const { post } = await setup();
  const l1 = ulid();
  await post('P', { commitId: ulid(), baseVersion: 0, ops: [{ type: 'insert', id: l1, after: '_head', text: 'P' }] });
  await post('P', { commitId: ulid(), baseVersion: 1, ops: [{ type: 'update', id: l1, text: 'P2' }] });
  const stale = await post('P2', { commitId: ulid(), baseVersion: 1, ops: [{ type: 'update', id: l1, text: 'P3' }] });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.error, 'conflict');
  assert.equal(body.reason, 'version');
  assert.equal(body.page.version, 2);
  assert.equal(body.page.lines[0].text, 'P2'); // rebase の latestSnapshot に使える全行
});

test('タイトル衝突は 409 reason title で占有ページを返す', async () => {
  const { post } = await setup();
  await post('Taken', { commitId: ulid(), baseVersion: 0, ops: [{ type: 'insert', id: ulid(), after: '_head', text: 'Taken' }] });
  const l1 = ulid();
  await post('Other', { commitId: ulid(), baseVersion: 0, ops: [{ type: 'insert', id: l1, after: '_head', text: 'Other' }] });
  const clash = await post('Other', { commitId: ulid(), baseVersion: 1, ops: [{ type: 'update', id: l1, text: 'Taken' }] });
  assert.equal(clash.status, 409);
  const body = await clash.json();
  assert.equal(body.reason, 'title');
  assert.equal(body.page.title, 'Taken'); // 占有している別ページ
});

test('クライアント不正は 400', async () => {
  const { post } = await setup();
  // 存在しない行への update
  await post('P', { commitId: ulid(), baseVersion: 0, ops: [{ type: 'insert', id: ulid(), after: '_head', text: 'P' }] });
  const bad = await post('P', { commitId: ulid(), baseVersion: 1, ops: [{ type: 'update', id: ulid(), text: 'x' }] });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'bad_commit');
  // 形式不正
  const malformed = await post('P', { commitId: '', baseVersion: 1, ops: [] });
  assert.equal(malformed.status, 400);
  const noJson = await post('P', undefined); // body なし
  assert.equal(noJson.status, 400);
});

test('新規作成の制約: baseVersion != 0 は 404、URL とタイトル不一致は 400', async () => {
  const { post } = await setup();
  const notFound = await post('Ghost', { commitId: ulid(), baseVersion: 3, ops: [{ type: 'update', id: ulid(), text: 'x' }] });
  assert.equal(notFound.status, 404);
  const mismatch = await post('Expected Title', {
    commitId: ulid(), baseVersion: 0,
    ops: [{ type: 'insert', id: ulid(), after: '_head', text: 'Different Title' }],
  });
  assert.equal(mismatch.status, 400);
});
