import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginAs, makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

void test('GET /:project: ピン留めが先頭、以降は更新順、カードにタイトル・冒頭行が出る', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
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
  assert.match(body, /<ul class="card-grid" role="list">/);
  assert.match(body, /href="\/proj\/Old">[\s\S]*?<h2>Old<\/h2>/);
});

void test('プロジェクトトップにプロジェクト一覧へ戻る導線がある', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('proj', s.clock.t);

  const body = await (await s.request('/proj', {}, cookie)).text();

  assert.match(body, /<nav class="page-nav"><a href="\/">プロジェクト一覧<\/a><\/nav>/);
});

void test('アップロード画像(/files/)はカードのサムネイルになる', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Page', ['[/files/01ABC/x.png]', 'body'], s.clock.t);

  const body = await (await s.request('/proj', {}, cookie)).text();

  assert.match(
    body,
    /<img class="card-image" src="\/files\/01ABC\/x\.png" alt="" width="320" height="100" loading="eager">/,
  );
});

void test('カードの冒頭行は記法を剥がした平文で出す', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Page', ['[Foo Bar] と #tag を含む行'], s.clock.t);

  const body = await (await s.request('/proj', {}, cookie)).text();

  assert.match(body, /Foo Bar と #tag を含む行/);
  assert.doesNotMatch(body, /\[Foo Bar\]/);
});

void test('もっと見るリンク: count が limit を超えたら次ページへのリンクが出る', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  for (let i = 0; i < 3; i += 1) {
    await seedPage(s.storage, project.id, `Page ${i}`, ['x'], s.clock.t + i);
  }

  const res = await s.request('/proj?limit=2', {}, cookie);
  const body = await res.text();

  assert.match(body, /href="\/proj\?skip=2&limit=2"/);
  assert.match(body, /もっと見る/);
});

void test('未ログインは /login へリダイレクト', async () => {
  const s = await makeServer();
  await s.storage.ensureProject('proj', s.clock.t);

  const res = await s.request('/proj');

  assert.equal(res.status, 302);
  assert.match(res.headers.get('location') ?? '', /^\/login\?next=/);
});

void test('GET /:project: 存在しないプロジェクトは layout を使った HTML 404', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const res = await s.request('/missing', {}, cookie);

  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  const body = await res.text();
  assert.match(body, /<!DOCTYPE html>/);
  assert.match(body, /プロジェクトが見つかりません/);
  assert.match(body, /missing/);
});

void test('検索ボックスと script タグが一覧ページに含まれる', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'A', ['x'], s.clock.t);
  const res = await s.request('/proj', {}, cookie);
  const body = await res.text();
  assert.match(body, /id="search-box"/);
  assert.match(body, /id="search-root"[^>]*data-project="proj"/);
  assert.match(body, /<script type="module" src="\/assets\/build\/search\.js"><\/script>/);
  assert.doesNotMatch(body, /<script>/);
});

void test('一覧ページに新規作成ボタンとタイトル入力 dialog が含まれる', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('proj', s.clock.t);

  const res = await s.request('/proj', {}, cookie);
  const body = await res.text();

  assert.match(body, /<button[^>]*id="create-page-button"[^>]*>新規作成<\/button>/);
  assert.match(body, /<dialog[^>]*id="create-page-dialog"/);
  assert.match(body, /<input[^>]*id="create-page-title"[^>]*required/);
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
});

void test('カード画像は allowedImageHosts で許可したホストだけ表示する', async () => {
  const s = await makeServer({ allowedImageHosts: ['allowed.example'] });
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Allowed', ['https://allowed.example/a.png'], s.clock.t);
  await seedPage(s.storage, project.id, 'Blocked', ['https://blocked.example/b.png'], s.clock.t + 1);

  const res = await s.request('/proj', {}, cookie);
  const body = await res.text();

  assert.match(body, /<img class="card-image" src="https:\/\/allowed\.example\/a\.png"/);
  assert.doesNotMatch(body, /<img class="card-image" src="https:\/\/blocked\.example\/b\.png"/);
});
