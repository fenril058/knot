import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loginAs, makeServer } from '../helpers/server.ts';

void test('GET /: 認証済みユーザーにプロジェクト一覧とリンクを表示する', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  await s.storage.ensureProject('zeta', s.clock.t);
  await s.storage.ensureProject('alpha', s.clock.t);

  const res = await s.request('/', {}, cookie);
  const body = await res.text();

  assert.equal(res.status, 200);
  assert.match(body, /<h1>プロジェクト一覧<\/h1>/);
  assert.match(body, /href="\/alpha"/);
  assert.match(body, /href="\/zeta"/);
  assert.ok(body.indexOf('/alpha') < body.indexOf('/zeta'));
  assert.match(body, /<form[^>]*id="create-project-form"/);
  assert.match(body, /<input[^>]*id="create-project-name"[^>]*required/);
  assert.match(body, /<p[^>]*id="create-project-error"[^>]*role="alert"[^>]*hidden/);
  assert.match(body, /<script type="module" src="\/assets\/build\/project-index\.js"><\/script>/);
  assert.doesNotMatch(body, /<script>|<style|\son[a-z]+=/i);
});

void test('GET /: プロジェクトが0件なら案内文を表示する', async () => {
  const s = await makeServer();
  const cookie = await loginAs(s);
  const res = await s.request('/', {}, cookie);

  assert.equal(res.status, 200);
  assert.match(await res.text(), /プロジェクトがありません/);
});

void test('GET /: 未認証なら /login?next=%2F へリダイレクトする', async () => {
  const s = await makeServer();
  const res = await s.request('/');

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2F');
});
