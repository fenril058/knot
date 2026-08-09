import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginAs, makeServer } from '../helpers/server.ts';
import { seedPage } from '../helpers/pages.ts';

const BASE_CSP = "default-src 'self'; img-src 'self' i.gyazo.com gyazo.com scrapbox.io; media-src 'self'; frame-src 'none'";

function dataAttribute(body: string, name: string): string {
  const match = body.match(new RegExp(`data-${name}="([^"]*)"`));
  assert.ok(match, `data-${name} must exist`);
  return match[1]!;
}

void test('既存ページの正規 URL は SSR 本文と直接編集用の要素を返す', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);

  const res = await s.request('/proj/Alpha', {}, cookie);

  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /id="edit-page-button"[^>]*>編集<\/button>/);
  assert.match(body, /id="editor-root"[^>]*class="page-body"/);
  assert.match(body, /line one/);
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

void test('不在ページの正規 URL は同じ場所で作成を始める SSR 文書を返す', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('proj', s.clock.t);

  const res = await s.request('/proj/New%20Page', {}, cookie);

  assert.equal(res.status, 404);
  const body = await res.text();
  assert.match(body, /id="edit-page-button"[^>]*>このタイトルで新規作成する<\/button>/);
  assert.equal(dataAttribute(body, 'title'), 'New Page');
  assert.equal(dataAttribute(body, 'last-seen-version'), '0');
  assert.match(body, /<script type="module" src="\/assets\/build\/editor\.js"><\/script>/);
});

void test('一覧・ログインの CSP は既存値から 1 バイトも変わらない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const project = await s.storage.ensureProject('proj', s.clock.t);
  await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);

  for (const [path, auth] of [['/proj', cookie], ['/login', undefined]] as const) {
    const res = await s.request(path, {}, auth);
    assert.equal(res.headers.get('content-security-policy'), BASE_CSP, path);
  }
});

void test('/edit はクエリを保って正規 URL へ 308 リダイレクトする', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('proj', s.clock.t);

  const plain = await s.request('/proj/Alpha/edit', {}, cookie);
  assert.equal(plain.status, 308);
  assert.equal(plain.headers.get('location'), '/proj/Alpha');

  const queried = await s.request('/proj/Alpha/edit?from=bookmark', {}, cookie);
  assert.equal(queried.status, 308);
  assert.equal(queried.headers.get('location'), '/proj/Alpha?from=bookmark');
});

void test('未ログインの正規 URL は本文を返さず next 付き login へリダイレクトする', async () => {
  const s = await makeServer();
  await s.storage.ensureProject('proj', s.clock.t);

  const res = await s.request('/proj/Alpha');

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2Fproj%2FAlpha');
});

void test('旧 edit URL も未ログインなら正規 URL へ転送する前に認証する', async () => {
  const s = await makeServer();
  const res = await s.request('/proj/Alpha/edit');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2Fproj%2FAlpha%2Fedit');
});

void test('正規 URL の本文はインライン script・style・イベントハンドラ属性を含まない', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('proj', s.clock.t);
  const res = await s.request('/proj/Alpha', {}, cookie);
  const body = await res.text();
  assert.doesNotMatch(body, /<script(?:\s[^>]*)?>\s*(?!<\/script>)/i);
  assert.doesNotMatch(body, /<style(?:\s[^>]*)?>/i);
  assert.doesNotMatch(body, /\son[a-z]+\s*=/i);
});

void test('既存ページの正規 URL は直前の visit を渡して訪問を記録する', async () => {
  const s = await makeServer();
  const userId = await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  const project = await s.storage.ensureProject('proj', s.clock.t);
  const pageId = await seedPage(s.storage, project.id, 'Alpha', ['line one'], s.clock.t);
  await s.storage.recordVisit(userId, pageId, s.clock.t - 10, 0);

  const res = await s.request('/proj/Alpha', {}, cookie);

  assert.equal(dataAttribute(await res.text(), 'last-seen-version'), '0');
  assert.equal((await s.storage.getVisit(userId, pageId))?.lastSeenVersion, 1);
});

void test('存在しないプロジェクトの正規 URL は HTML 404', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const res = await s.request('/missing/Alpha', {}, cookie);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await res.text(), /プロジェクトが見つかりません/);
});
