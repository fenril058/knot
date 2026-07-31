import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../../src/core/id.ts';
import { generateApiToken } from '../../src/server/apiToken.ts';
import { makeServer } from '../helpers/server.ts';

void test('PAT で cookie なしの API にアクセスできる', async () => {
  const s = await makeServer();
  const userId = await s.addUser('alice', 'pw12345678');
  await s.storage.ensureProject('proj', s.clock.t);
  const { token, tokenHash } = generateApiToken();
  await s.storage.createApiToken({ id: ulid(s.clock.t * 1000), userId, label: 'test', tokenHash, created: s.clock.t });

  const res = await s.request('/api/pages/proj', { headers: { 'x-personal-access-token': token } });

  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null);
});

void test('不正な PAT は有効な cookie があっても 401', async () => {
  const s = await makeServer();
  await s.addUser('alice', 'pw12345678');
  const cookie = await s.login('alice', 'pw12345678');

  const res = await s.request(
    '/api/pages/none',
    { headers: { 'x-personal-access-token': 'knot_invalid' } },
    cookie,
  );

  assert.equal(res.status, 401);
});

void test('HTML ルートでは PAT ヘッダを無視する', async () => {
  const s = await makeServer();
  const userId = await s.addUser('alice', 'pw12345678');
  const { token, tokenHash } = generateApiToken();
  await s.storage.createApiToken({ id: ulid(s.clock.t * 1000), userId, label: 'test', tokenHash, created: s.clock.t });

  const res = await s.request('/', { redirect: 'manual', headers: { 'x-personal-access-token': token } });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/login?next=%2F');
});
