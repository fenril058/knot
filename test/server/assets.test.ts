import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeServer } from '../helpers/server.ts';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { publicDirectory } from '../../src/server/app.ts';

void test('publicDirectory は cwd に依存しない絶対パスを返す', () => {
  const before = publicDirectory();
  const original = process.cwd();
  try {
    process.chdir('/tmp');
    assert.equal(publicDirectory(), before);
  } finally {
    process.chdir(original);
  }
  assert.equal(isAbsolute(before), true);
  assert.equal(existsSync(before), true);
});

void test('GET /assets/app.css は認証なしで text/css を返す', async () => {
  const s = await makeServer();
  const res = await s.request('/assets/app.css');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/css/);
});
