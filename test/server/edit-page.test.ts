import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginAs, makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

const BASE_CSP = "default-src 'self'; img-src 'self' i.gyazo.com gyazo.com; media-src 'self'; frame-src 'none'";

function dataAttribute(body: string, name: string): string {
  const match = body.match(new RegExp(`data-${name}="([^"]*)"`));
  assert.ok(match, `data-${name} must exist`);
  return match[1]!;
}

test('既存ページの edit はエディタ用 data 属性と nonce 付き CSP を返す', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);

  const res = await s.request('/proj/Alpha/edit', {}, cookie);

  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(dataAttribute(body, 'project'), 'proj');
  assert.equal(dataAttribute(body, 'title'), 'Alpha');
  assert.equal(dataAttribute(body, 'user-name'), 'alice');
  assert.equal(dataAttribute(body, 'last-seen-version'), '0');
  const nonce = dataAttribute(body, 'csp-nonce');
  assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/);
  assert.equal(res.headers.get('content-security-policy'), `${BASE_CSP}; style-src 'self' 'nonce-${nonce}'`);
  assert.match(body, /<nav class="page-nav"><a href="\/proj">proj<\/a><\/nav>/);
  assert.match(body, /<div id="save-status"/);
  assert.match(body, /<script type="module" src="\/assets\/build\/editor\.js"><\/script>/);
});

test('不在ページの edit も URL のタイトルを使う新規作成モードで 200', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('proj', s.clock.t);

  const res = await s.request('/proj/New%20Page/edit', {}, cookie);

  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(dataAttribute(body, 'title'), 'New Page');
  assert.equal(dataAttribute(body, 'last-seen-version'), '0');
});

test('edit 以外の閲覧・一覧・ログインの CSP は既存値から 1 バイトも変わらない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);

  for (const [path, auth] of [['/proj/Alpha', cookie], ['/proj', cookie], ['/login', undefined]] as const) {
    const res = await s.request(path, {}, auth);
    assert.equal(res.headers.get('content-security-policy'), BASE_CSP, path);
  }
});

test('edit は未ログインを next 付き login へリダイレクトする', async () => {
  const s = await makeServer();
  const res = await s.request('/proj/Alpha/edit');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2Fproj%2FAlpha%2Fedit');
});

test('edit 本文はインライン script・style・イベントハンドラ属性を含まない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj/Alpha/edit', {}, cookie);
  const body = await res.text();
  assert.doesNotMatch(body, /<script(?:\s[^>]*)?>\s*(?!<\/script>)/i);
  assert.doesNotMatch(body, /<style(?:\s[^>]*)?>/i);
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
});

test('既存ページの edit は直前の visit を渡して訪問を記録する', async () => {
  const s = await makeServer();
  const userId = await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const pageId = await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);
  await s.storage.recordVisit(userId, pageId, s.clock.t - 10, 0);

  const res = await s.request('/proj/Alpha/edit', {}, cookie);

  assert.equal(dataAttribute(await res.text(), 'last-seen-version'), '0');
  assert.equal((await s.storage.getVisit(userId, pageId))?.lastSeenVersion, 1);
});

test('存在しないプロジェクトの edit は HTML 404', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const res = await s.request('/missing/Alpha/edit', {}, cookie);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /プロジェクトが見つかりません/);
});
