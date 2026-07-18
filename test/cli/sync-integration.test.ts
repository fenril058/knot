import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { openDatabase } from '../../src/storage/db.ts';
import { SqliteStorage } from '../../src/storage/sqlite.ts';
import type { Storage } from '../../src/storage/types.ts';
import { createApp } from '../../src/server/app.ts';
import { defaultConfig } from '../../src/server/config.ts';
import { hashPassword } from '../../src/server/password.ts';
import { generateApiToken } from '../../src/server/apiToken.ts';
import { ulid } from '../../src/core/id.ts';
import { seedPage } from '../helpers/pages.ts';
import { runSync } from '../../src/cli/sync/commands.ts';
import { loadState } from '../../src/cli/sync/state.ts';

type Env = {
  storage: Storage;
  baseUrl: string;
  projectId: string;
  dir: string;
  close(): void;
  clock: { t: number };
};

async function makeEnv(): Promise<Env> {
  const clock = { t: 1_700_000_000 };
  const storage: Storage = new SqliteStorage(openDatabase(':memory:'));
  const config = { ...defaultConfig('/nonexistent'), secureCookie: false };
  const app = createApp({ storage, config, now: () => clock.t });
  const project = await storage.ensureProject('notes', clock.t);
  const userId = ulid(clock.t * 1000);
  await storage.addUser(
    { id: userId, name: 'alice', displayName: 'alice', passwordHash: hashPassword('pw12345678'), isAdmin: false },
    clock.t,
  );
  const { token, tokenHash } = generateApiToken();
  await storage.createApiToken({ id: ulid(clock.t * 1000), userId, label: 'sync', tokenHash, created: clock.t });
  const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => listener.on('listening', () => resolve()));
  const { port } = listener.address() as AddressInfo;
  const dir = mkdtempSync(join(tmpdir(), 'knot-sync-int-'));
  await runSync(['init', dir, '--url', `http://127.0.0.1:${port}`, '--project', 'notes']);
  writeFileSync(join(dir, '.knot', 'token'), token);
  return {
    storage, baseUrl: `http://127.0.0.1:${port}`, projectId: project.id, dir, clock,
    close: () => { listener.close(); rmSync(dir, { recursive: true }); },
  };
}

test('pull: 初回同期でリモートの全ページがファイルになる', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['first line'], env.clock.t);
    await seedPage(env.storage, env.projectId, 'Beta', ['see [Alpha]'], env.clock.t + 1);
    const result = await runSync(['pull', '--dir', env.dir]);
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(join(env.dir, 'Alpha.txt'), 'utf8'), 'Alpha\nfirst line\n');
    assert.equal(readFileSync(join(env.dir, 'Beta.txt'), 'utf8'), 'Beta\nsee [Alpha]\n');
    const state = loadState(env.dir);
    assert.equal(Object.keys(state.pages).length, 2);
    const alpha = Object.values(state.pages).find((p) => p.title === 'Alpha')!;
    assert.equal(alpha.filename, 'Alpha.txt');
    assert.equal(alpha.version, 1);
  } finally { env.close(); }
});

test('pull: 2 回目は no-op、リモート更新は上書き、ローカル編集は温存', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    // no-op
    const second = await runSync(['pull', '--dir', env.dir]);
    assert.equal(second.exitCode, 0);
    // ローカル編集のみ → pull は温存
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\nlocal edit\n');
    await runSync(['pull', '--dir', env.dir]);
    assert.equal(readFileSync(join(env.dir, 'Alpha.txt'), 'utf8'), 'Alpha\nlocal edit\n');
  } finally { env.close(); }
});

test('pull: 両方変更は conflicts に隔離し exitCode 1', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    // ローカルとリモートを両方変更する
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\nlocal edit\n');
    const state = loadState(env.dir);
    const pageId = Object.keys(state.pages)[0]!;
    const page = await env.storage.getPageById(pageId);
    // リモート側を直接コミットで更新（行を追加）
    env.clock.t += 10;
    const lastLineId = page!.lines.at(-1)!.id;
    await env.storage.commit({
      projectId: env.projectId, pageId, commitId: ulid(env.clock.t * 1000),
      baseVersion: page!.version,
      ops: [{ type: 'insert', id: ulid(env.clock.t * 1000), after: lastLineId, text: 'remote add' }],
      userId: 'u', now: env.clock.t,
    });
    const result = await runSync(['pull', '--dir', env.dir]);
    assert.equal(result.exitCode, 1);
    assert.equal(readFileSync(join(env.dir, 'Alpha.txt'), 'utf8'), 'Alpha\nlocal edit\n'); // 触らない
    const remoteCopy = readFileSync(join(env.dir, '.knot', 'conflicts', pageId, 'remote.txt'), 'utf8');
    assert.equal(remoteCopy, 'Alpha\nv1 body\nremote add\n');
  } finally { env.close(); }
});

test('pull: リモートのリネームは旧ファイルを消して新名で書く', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    const pageId = Object.keys(loadState(env.dir).pages)[0]!;
    const page = await env.storage.getPageById(pageId);
    env.clock.t += 10;
    await env.storage.commit({
      projectId: env.projectId, pageId, commitId: ulid(env.clock.t * 1000),
      baseVersion: page!.version,
      ops: [{ type: 'update', id: page!.lines[0]!.id, text: 'Alpha2' }],
      userId: 'u', now: env.clock.t,
    });
    const result = await runSync(['pull', '--dir', env.dir]);
    assert.equal(result.exitCode, 0);
    assert.ok(!existsSync(join(env.dir, 'Alpha.txt')));
    assert.equal(readFileSync(join(env.dir, 'Alpha2.txt'), 'utf8'), 'Alpha2\nbody\n');
    assert.equal(loadState(env.dir).pages[pageId]!.title, 'Alpha2');
  } finally { env.close(); }
});

test('pull: リモート削除はローカル未変更なら削除、変更ありなら温存', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Gone', ['body'], env.clock.t);
    await seedPage(env.storage, env.projectId, 'Kept', ['body'], env.clock.t + 1);
    await runSync(['pull', '--dir', env.dir]);
    writeFileSync(join(env.dir, 'Kept.txt'), 'Kept\nlocal edit\n');
    const state = loadState(env.dir);
    for (const [pageId] of Object.entries(state.pages)) {
      env.clock.t += 10;
      await env.storage.deletePage(env.projectId, pageId, 'u', env.clock.t);
    }
    const result = await runSync(['pull', '--dir', env.dir]);
    assert.equal(result.exitCode, 1); // Kept の温存を報告
    assert.ok(!existsSync(join(env.dir, 'Gone.txt')));
    assert.equal(readFileSync(join(env.dir, 'Kept.txt'), 'utf8'), 'Kept\nlocal edit\n');
  } finally { env.close(); }
});

// 詳細取得（GET /api/pages/<project>/<title>）のパスを返す。一覧（?sort= 付き）は除く。
function detailPath(input: RequestInfo | URL): string | null {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const pathname = new URL(url).pathname;
  return pathname.startsWith('/api/pages/notes/') ? pathname : null;
}

test('pull: 一覧後の詳細が別 id を返したページはスキップし、ファイルも state も変えない', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['body'], env.clock.t);
    // 詳細レスポンスの id だけを一覧と食い違う値へ差し替える fetch ラッパ
    const patched: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (detailPath(input) !== null) {
        const body = (await res.json()) as { id: string };
        return new Response(JSON.stringify({ ...body, id: 'different0000000000000000' }), {
          status: res.status, headers: { 'content-type': 'application/json' },
        });
      }
      return res;
    };
    const result = await runSync(['pull', '--dir', env.dir], { fetchFn: patched });
    assert.equal(result.exitCode, 1);
    assert.ok(!existsSync(join(env.dir, 'Alpha.txt')));
    assert.equal(Object.keys(loadState(env.dir).pages).length, 0);
  } finally { env.close(); }
});

test('pull: 詳細取得が transport 例外を投げたページはスキップし、他ページは継続する', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['a body'], env.clock.t);
    await seedPage(env.storage, env.projectId, 'Beta', ['b body'], env.clock.t + 1);
    // Alpha の詳細取得だけ SyncHttpError でない例外（TypeError）を投げる
    const patched: typeof fetch = async (input, init) => {
      const p = detailPath(input);
      if (p !== null && p.endsWith('/Alpha')) throw new TypeError('network error');
      return fetch(input, init);
    };
    const result = await runSync(['pull', '--dir', env.dir], { fetchFn: patched });
    assert.equal(result.exitCode, 1);
    assert.ok(!existsSync(join(env.dir, 'Alpha.txt')));
    assert.equal(readFileSync(join(env.dir, 'Beta.txt'), 'utf8'), 'Beta\nb body\n');
    const state = loadState(env.dir);
    assert.equal(Object.keys(state.pages).length, 1);
    assert.equal(Object.values(state.pages)[0]!.filename, 'Beta.txt');
  } finally { env.close(); }
});
