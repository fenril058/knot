import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';

void test('GET /login は外部 css/js のみを参照し、インライン script/style を含まない', async () => {
  const s = await makeServer();
  const res = await s.request('/login');
  const body = await res.text();
  assert.match(body, /<link rel="stylesheet" href="\/assets\/app\.css">/);
  assert.match(body, /<script src="\/assets\/login\.js"/);
  assert.doesNotMatch(body, /<script>/);
  assert.doesNotMatch(body, /<style>/);
  assert.doesNotMatch(body, / on[a-z]+="/);
});
