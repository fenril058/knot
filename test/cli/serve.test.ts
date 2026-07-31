import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));

void test('knot serve が起動し、未認証 401 → ログイン → ページ作成まで通る', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-serve-'));
  execFileSync(process.execPath, [mainPath, 'init', '--data', dir]);
  execFileSync(process.execPath, [mainPath, 'user', 'add', '--data', dir, '--name', 'alice'], {
    input: 'pw12345678',
  });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [mainPath, 'serve', '--data', dir, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // 起動を待つ（最大 10 秒、100ms ポーリング）
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ready = await fetch(`${base}/api/pages/none`).then((r) => r.status === 401).catch(() => false);
    }
    assert.ok(ready, 'server did not start');

    const login = await fetch(`${base}/api/knot/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke' },
      body: JSON.stringify({ name: 'alice', password: 'pw12345678' }),
    });
    assert.equal(login.status, 200);
    // loopback の http 起動では secureCookie: 'auto' が false に解決される
    assert.doesNotMatch(login.headers.get('set-cookie')!, /secure/i);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];

    const put = await fetch(`${base}/api/knot/pages/proj/Hello/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke', Cookie: cookie },
      body: JSON.stringify({ baseVersion: 0, text: 'Hello\nworld' }),
    });
    assert.equal(put.status, 404);

    const create = await fetch(`${base}/api/knot/projects/proj`, {
      method: 'POST',
      headers: { 'X-Knot-Client': 'smoke', Cookie: cookie },
    });
    assert.equal(create.status, 200);

    const put2 = await fetch(`${base}/api/knot/pages/proj/Hello/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke', Cookie: cookie },
      body: JSON.stringify({ baseVersion: 0, text: 'Hello\nworld' }),
    });
    assert.equal(put2.status, 200);

    const text = await fetch(`${base}/api/pages/proj/Hello/text`, { headers: { Cookie: cookie } });
    assert.equal(await text.text(), 'Hello\nworld');
  } finally {
    child.kill();
  }
});
