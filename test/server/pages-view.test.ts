import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

async function login(s: Awaited<ReturnType<typeof makeServer>>): Promise<string> {
  await s.addUser('alice', 'pw12345678');
  return s.login('alice', 'pw12345678');
}

test('GET /:project/:title: レンダリング結果・赤リンク・テロメア・関連ページを含む', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  const alphaId = await seedPage(s.storage, project.id, 'Alpha', ['see [Beta] and [Ghost]'], s.clock.t + 1);
  const res = await s.request('/proj/Alpha', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="red-link"[^>]*>Ghost</);
  assert.match(body, /href="\/proj\/Beta"[^>]*>Beta</);
  assert.match(body, /class="telomere/);
  assert.match(body, /Beta/);
  void alphaId;
});

test('初回訪問は全行 unread、再訪問（編集なし）は unread が消える', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);
  const first = await s.request('/proj/Alpha', {}, cookie);
  assert.match(await first.text(), /telomere unread/);
  const second = await s.request('/proj/Alpha', {}, cookie);
  assert.doesNotMatch(await second.text(), /telomere unread/);
});

test('ページ表示の knownPages は listKnownPages を使い listPageTitles を呼ばない', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['[Beta]'], s.clock.t);
  s.storage.listPageTitles = async () => {
    throw new Error('listPageTitles must not be called by the HTML page route');
  };

  const res = await s.request('/proj/Alpha', {}, cookie);

  assert.equal(res.status, 200);
  assert.match(await res.text(), /href="\/proj\/Beta"/);
});

test('存在しないページは 404 と新規作成の案内', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj/Nope', {}, cookie);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /Nope/);
  assert.match(body, /\/proj\/Nope\/edit/);
});

test('GET /:project/:title: 存在しないプロジェクトは layout を使った HTML 404', async () => {
  const s = await makeServer();
  const cookie = await login(s);
  const res = await s.request('/missing/Nope', {}, cookie);

  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const body = await res.text();
  assert.match(body, /<!DOCTYPE html>/);
  assert.match(body, /プロジェクトが見つかりません/);
  assert.match(body, /missing/);
});

for (const [name, headers] of [
  ['cross-site', { 'Sec-Fetch-Site': 'cross-site' }],
  ['prefetch', { 'Sec-Purpose': 'prefetch' }],
] as const) {
  test(`${name} の GET は再訪問しても unread を既読にしない`, async () => {
    const s = await makeServer();
    const cookie = await login(s);
    const project = await s.storage.ensureProject('proj', s.clock.t);
    await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);

    const first = await s.request('/proj/Alpha', { headers }, cookie);
    assert.match(await first.text(), /telomere unread/);
    const second = await s.request('/proj/Alpha', { headers }, cookie);
    assert.match(await second.text(), /telomere unread/);
  });
}
