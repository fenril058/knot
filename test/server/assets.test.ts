import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

test('GET /assets/app.css は認証なしで text/css を返す', async () => {
  const s = await makeServer();
  const res = await s.request('/assets/app.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/css/);
});
