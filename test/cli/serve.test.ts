import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const START_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 2_000;

function waitForServing(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('exit', onExit);
    };
    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString();
      const match = /knot serving (http:\/\/\S+\/) \(data:/.exec(stdout);
      if (match === null) return;
      cleanup();
      resolve(match[1]!);
    };
    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString();
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`server exited before listening (code ${code}): ${stderr}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`server did not start within ${START_TIMEOUT_MS}ms: ${stderr}`));
    }, START_TIMEOUT_MS);
    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('exit', onExit);
  });
}

function request(url: string, init: RequestInit = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

void test('HTTP 応答を返さないサーバでも要求は期限内に失敗する', async () => {
  const listener = createServer(() => {});
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert.ok(address !== null && typeof address !== 'string');
  const { port } = address;
  let watchdog: NodeJS.Timeout | undefined;
  try {
    const didNotTimeOut = new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('request did not time out')), 1_000);
    });
    await assert.rejects(
      Promise.race([request(`http://127.0.0.1:${port}/`, {}, 50), didNotTimeOut]),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
    );
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  }
});

void test('knot serve が起動し、未認証 401 → ログイン → ページ作成まで通る', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'knot-serve-'));
  execFileSync(process.execPath, [mainPath, 'init', '--data', dir]);
  execFileSync(process.execPath, [mainPath, 'user', 'add', '--data', dir, '--name', 'alice'], {
    input: 'pw12345678',
  });
  const child = spawn(process.execPath, [mainPath, 'serve', '--data', dir, '--port', '0'], { stdio: 'pipe' });
  try {
    const servingUrl = await waitForServing(child);
    const base = servingUrl.replace(/\/$/, '');
    assert.notEqual(new URL(servingUrl).port, '0');

    const login = await request(`${base}/api/knot/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke' },
      body: JSON.stringify({ name: 'alice', password: 'pw12345678' }),
    });
    assert.equal(login.status, 200);
    // loopback の http 起動では secureCookie: 'auto' が false に解決される
    assert.doesNotMatch(login.headers.get('set-cookie')!, /secure/i);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const put = await request(`${base}/api/knot/pages/proj/Hello/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke', Cookie: cookie },
      body: JSON.stringify({ baseVersion: 0, text: 'Hello\nworld' }),
    });
    assert.equal(put.status, 404);

    const create = await request(`${base}/api/knot/projects/proj`, {
      method: 'POST',
      headers: { 'X-Knot-Client': 'smoke', Cookie: cookie },
    });
    assert.equal(create.status, 200);

    const put2 = await request(`${base}/api/knot/pages/proj/Hello/text`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'X-Knot-Client': 'smoke', Cookie: cookie },
      body: JSON.stringify({ baseVersion: 0, text: 'Hello\nworld' }),
    });
    assert.equal(put2.status, 200);

    const text = await request(`${base}/api/pages/proj/Hello/text`, { headers: { Cookie: cookie } });
    assert.equal(await text.text(), 'Hello\nworld');
  } finally {
    child.kill();
  }
});
