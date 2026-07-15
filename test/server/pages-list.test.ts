import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function login(s: Awaited<ReturnType<typeof makeServer>>): Promise<string> {
  await s.addUser('alice', 'pw12345678');
  return s.login('alice', 'pw12345678');
}

test('GET /:project: ピン留めが先頭、以降は更新順、カードにタイトル・冒頭行が出る', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const pinnedPageId = await seedPage(s.storage, project.id, 'Old', ['first line'], s.clock.t);
  await seedPage(s.storage, project.id, 'New', ['other line'], s.clock.t + 10);
  await s.storage.setPinned(pinnedPageId, true);

  const res = await s.request('/proj', {}, cookie);

  assert.equal(res.status, 200);
  const body = await res.text();
  const oldIndex = body.indexOf('Old');
  const newIndex = body.indexOf('New');
  assert.ok(oldIndex >= 0 && newIndex > oldIndex);
  assert.match(body, /first line/);
});

test('もっと見るリンク: count が limit を超えたら次ページへのリンクが出る', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  for (let i = 0; i < 3; i += 1) {
    await seedPage(s.storage, project.id, `Page ${i}`, ['x'], s.clock.t + i);
  }

  const res = await s.request('/proj?limit=2', {}, cookie);
  const body = await res.text();

  assert.match(body, /href="\/proj\?skip=2&limit=2"/);
  assert.match(body, /もっと見る/);
});

test('未ログインは /login へリダイレクト', async () => {
  const s = await makeServer();
  await s.storage.ensureProject('proj', s.clock.t);

  const res = await s.request('/proj');

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login');
});

test('検索ボックスと script タグが一覧ページに含まれる', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'A', ['x'], s.clock.t);
  const res = await s.request('/proj', {}, cookie);
  const body = await res.text();
  assert.match(body, /id="search-box"/);
  assert.match(body, /<script src="\/assets\/search\.js"[^>]*data-project="proj"/);
  assert.doesNotMatch(body, /<script>/);
});
