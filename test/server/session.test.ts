import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

void test('未認証の API は 401', async () => {
  const { app } = await makeServer();
  const res = await app.request('/api/pages/proj');
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

void test('ログイン → 認証付きアクセス → ログアウト', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  assert.match(cookie, /^connect\.sid=[0-9a-f]{32}$/);
  const res = await s.request('/api/pages/none', {}, cookie);
  assert.equal(res.status, 404);
  const out = await s.request('/api/knot/session', { method: 'DELETE' }, cookie);
  assert.equal(out.status, 200);
  const after = await s.request('/api/pages/none', {}, cookie);
  assert.equal(after.status, 401);
});

void test('login response の admin 判定は Account、displayName は関連 Actor から取得する', async () => {
  const s = await makeServer();
  const account = await s.addAccount('alice', 'pw12345678', true);
  const res = await s.request('/api/knot/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'pw12345678' }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    id: account.accountId, name: 'alice', displayName: 'alice', isAdmin: true,
  });
});

void test('ログイン失敗は 401 invalid_credentials', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const res = await s.request('/api/knot/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'wrong' }),
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'invalid_credentials' });
});

void test('X-Knot-Client なしの書き込みは 403（ログイン自体も対象）', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const res = await s.app.request('/api/knot/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'pw12345678' }),
  });
  assert.equal(res.status, 403);
});

void test('ログイン試行はレートリミットされる（11 回目で 429）', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  for (let i = 0; i < 10; i++) {
    const res = await s.request('/api/knot/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'alice', password: 'wrong' }),
    });
    assert.equal(res.status, 401);
  }
  const res = await s.request('/api/knot/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alice', password: 'pw12345678' }),
  });
  assert.equal(res.status, 429);
});

void test('セキュリティヘッダが全応答に付く', async () => {
  const s = await makeServer();
  const res = await s.app.request('/api/pages/proj');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const csp = res.headers.get('content-security-policy')!;
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /img-src 'self' i\.gyazo\.com gyazo\.com/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
});

void test('期限が近いセッションはアクセスで延長される（スライディング）', async () => {
  const s = await makeServer();
  await s.addAccount('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');
  s.clock.t += 2 * 24 * 60 * 60;
  const res = await s.request('/api/pages/none', {}, cookie);
  assert.equal(res.status, 404);
  assert.match(res.headers.get('set-cookie') ?? '', /connect\.sid=/);
  s.clock.t += 29 * 24 * 60 * 60;
  const later = await s.request('/api/pages/none', {}, cookie);
  assert.equal(later.status, 404);
});
