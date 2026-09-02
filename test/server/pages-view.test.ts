import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginAs, makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

void test('GET /:project/:title: レンダリング結果・空リンク・テロメア・関連ページを含む', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  const alphaId = await seedPage(s.storage, project.id, 'Alpha', ['see [Beta] and [Ghost]'], s.clock.t + 1);
  const res = await s.request('/proj/Alpha', {}, cookie);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="empty-link"[^>]*>Ghost</);
  assert.match(body, /href="\/proj\/Beta"[^>]*>Beta</);
  assert.match(body, /class="telomere/);
  assert.match(body, /Beta/);
  assert.match(body, /id="edit-page-button"[^>]*>編集<\/button>/);
  assert.match(body, /<nav class="page-nav"><a href="\/proj">proj<\/a><\/nav>/);
  assert.match(body, /data-known-pages="[^"]*Beta[^"]*"/);
  void alphaId;
});

void test('深いインデントを深さ分のDOM要素へ展開しない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Deep', [`${' '.repeat(1000)}nested`], s.clock.t);

  const body = await (await s.request('/proj/Deep', {}, cookie)).text();

  assert.equal(body.match(/class="line-indent"/g)?.length ?? 0, 0);
  assert.match(body, /class="line-indent-prefix"/);
});

void test('1-hop と 2-hop の関連ページを一覧と同じカードで表示する', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['[/files/01ABC/beta.png]', '[Beta Link] の説明'], s.clock.t);
  await seedPage(
    s.storage,
    project.id,
    'Gamma',
    ['[/files/01ABC/gamma.png]', '[Ghost]', 'Gamma の説明'],
    s.clock.t + 1,
  );
  await seedPage(s.storage, project.id, 'Alpha', ['[Beta] と [Ghost]'], s.clock.t + 2);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  assert.match(body, /<section class="related-pages"><h2>関連ページ<\/h2><ul class="card-grid" role="list">/);
  assert.match(body, /<li><a class="card" href="\/proj\/Beta">/);
  assert.match(body, /href="\/proj\/Beta">[\s\S]*?<h3>Beta<\/h3>/);
  assert.match(
    body,
    /<img class="card-image" src="\/files\/01ABC\/beta\.png" alt="" width="320" height="100" loading="eager">/,
  );
  assert.match(body, /Beta Link の説明/);
  assert.match(body, /<section class="related-pages"><h2>2-hop リンク<\/h2><ul class="card-grid" role="list">/);
  assert.match(body, /<li><a class="card" href="\/proj\/Gamma">/);
  assert.match(
    body,
    /<img class="card-image" src="\/files\/01ABC\/gamma\.png" alt="" width="320" height="100" loading="lazy">/,
  );
  assert.match(body, /Gamma の説明/);
});

void test('関連ページの外部画像は allowedImageHosts で許可したホストだけ表示する', async () => {
  const s = await makeServer({ allowedImageHosts: ['allowed.example'] });
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Allowed', ['https://allowed.example/a.png'], s.clock.t);
  await seedPage(s.storage, project.id, 'Blocked', ['https://blocked.example/b.png'], s.clock.t + 1);
  await seedPage(s.storage, project.id, 'Alpha', ['[Allowed] [Blocked]'], s.clock.t + 2);

  const body = await (await s.request('/proj/Alpha', {}, cookie)).text();

  assert.match(body, /<img class="card-image" src="https:\/\/allowed\.example\/a\.png"/);
  assert.doesNotMatch(body, /<img class="card-image" src="https:\/\/blocked\.example\/b\.png"/);
});

void test('閲覧画面に操作メニューと複製・リネーム・削除 dialog がありインラインハンドラを使わない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['body'], s.clock.t);

  const res = await s.request('/proj/Alpha', {}, cookie);
  const body = await res.text();

  assert.match(
    body,
    /id="page-menu-root"[^>]*data-project="proj"[^>]*data-title="Alpha"[^>]*data-page-id="[^"]+"[^>]*data-version="1"/,
  );
  assert.match(body, /<details[^>]*id="page-actions"/);
  assert.match(body, /<dialog[^>]*id="duplicate-dialog"/);
  assert.match(body, /<dialog[^>]*id="rename-dialog"/);
  assert.match(body, /<dialog[^>]*id="delete-dialog"/);
  assert.match(body, /<script type="module" src="\/assets\/build\/page-menu\.js"><\/script>/);
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
});

void test('初回訪問は全行 unread、再訪問（編集なし）は unread が消える', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);
  const first = await s.request('/proj/Alpha', {}, cookie);
  assert.match(await first.text(), /telomere unread/);
  const second = await s.request('/proj/Alpha', {}, cookie);
  assert.doesNotMatch(await second.text(), /telomere unread/);
});

void test('ページ表示の knownPages は listKnownPages を使い listPageTitles を呼ばない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
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

void test('存在しないページは 404 と新規作成の案内', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Beta', ['x'], s.clock.t);
  const res = await s.request('/proj/Nope', {}, cookie);
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /Nope/);
  assert.match(body, /id="edit-page-button"[^>]*>このタイトルで新規作成する<\/button>/);
  assert.match(body, /data-known-pages="[^"]*Beta[^"]*"/);
});

void test('GET /:project/:title: 存在しないプロジェクトは layout を使った HTML 404', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
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
  void test(`${name} の GET は再訪問しても unread を既読にしない`, async () => {
    const s = await makeServer();
    const cookie = await loginAs(s);
    const project = await s.storage.ensureProject('proj', s.clock.t);
    await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);

    const first = await s.request('/proj/Alpha', { headers }, cookie);
    assert.match(await first.text(), /telomere unread/);
    const second = await s.request('/proj/Alpha', { headers }, cookie);
    assert.match(await second.text(), /telomere unread/);
  });
}
