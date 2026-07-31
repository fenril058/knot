import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

void test('pull: 初回同期でリモートの全ページがファイルになる', async () => {
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

void test('pull: 2 回目は no-op、リモート更新は上書き、ローカル編集は温存', async () => {
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

void test('pull: 両方変更は conflicts に隔離し exitCode 1', async () => {
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

void test('pull: リモートのリネームは旧ファイルを消して新名で書く', async () => {
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

void test('pull: リモート削除はローカル未変更なら削除、変更ありなら温存', async () => {
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

// PUT はサーバに届くが応答が失われる状況を再現する fetch ラッパ。
const putLosesResponse: typeof fetch = async (url, init) => {
  const res = await fetch(url, init);
  if (init?.method === 'PUT') throw new TypeError('network error after send');
  return res;
};

void test('pull: 一覧後の詳細が別 id を返したページはスキップし、ファイルも state も変えない', async () => {
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

void test('pull: 詳細取得が transport 例外を投げたページはスキップし、他ページは継続する', async () => {
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

void test('push: ローカル編集を送信し version と hash を state に反映する', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\nedited body\n');
    const result = await runSync(['push', '--dir', env.dir]);
    assert.equal(result.exitCode, 0);
    const pageId = Object.keys(loadState(env.dir).pages)[0]!;
    const page = await env.storage.getPageById(pageId);
    assert.deepEqual(page!.lines.map((l) => l.text), ['Alpha', 'edited body']);
    assert.equal(loadState(env.dir).pages[pageId]!.version, page!.version);
    // push 後は clean
    assert.equal((await runSync(['status', '--dir', env.dir])).output, 'clean');
  } finally { env.close(); }
});

void test('push: 新規ファイルはページを作成し pageId を state に記録する', async () => {
  const env = await makeEnv();
  try {
    await runSync(['pull', '--dir', env.dir]);
    writeFileSync(join(env.dir, 'Brand New.txt'), 'Brand New\nhello world\n');
    const result = await runSync(['push', '--dir', env.dir]);
    assert.equal(result.exitCode, 0);
    const state = loadState(env.dir);
    const entry = Object.entries(state.pages).find(([, st]) => st.title === 'Brand New');
    assert.ok(entry);
    const page = await env.storage.getPageById(entry![0]);
    assert.deepEqual(page!.lines.map((l) => l.text), ['Brand New', 'hello world']);
  } finally { env.close(); }
});

void test('push: 409 は該当ページだけスキップし exitCode 1、--force で上書きできる', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await seedPage(env.storage, env.projectId, 'Beta', ['beta body'], env.clock.t + 1);
    await runSync(['pull', '--dir', env.dir]);
    // リモートの Alpha を先に進める
    const state = loadState(env.dir);
    const alphaId = Object.entries(state.pages).find(([, st]) => st.title === 'Alpha')![0];
    const page = await env.storage.getPageById(alphaId);
    env.clock.t += 10;
    await env.storage.commit({
      projectId: env.projectId, pageId: alphaId, commitId: ulid(env.clock.t * 1000),
      baseVersion: page!.version,
      ops: [{ type: 'insert', id: ulid(env.clock.t * 1000), after: page!.lines.at(-1)!.id, text: 'remote add' }],
      userId: 'u', now: env.clock.t,
    });
    // ローカルも両方編集する
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\nlocal alpha\n');
    writeFileSync(join(env.dir, 'Beta.txt'), 'Beta\nlocal beta\n');
    const result = await runSync(['push', '--dir', env.dir]);
    assert.equal(result.exitCode, 1); // Alpha は conflict、Beta は成功
    assert.match(result.output, /conflict/);
    const beta = await env.storage.getPageById(
      Object.entries(loadState(env.dir).pages).find(([, st]) => st.title === 'Beta')![0],
    );
    assert.deepEqual(beta!.lines.map((l) => l.text), ['Beta', 'local beta']);
    // --force は最新 version を取り直して 1 回だけ上書きする
    const forced = await runSync(['push', '--dir', env.dir, '--force']);
    assert.equal(forced.exitCode, 0);
    const alpha = await env.storage.getPageById(alphaId);
    assert.deepEqual(alpha!.lines.map((l) => l.text), ['Alpha', 'local alpha']);
  } finally { env.close(); }
});

void test('push: create 後の詳細取得が null なら pushed を報告せず exit1（state 未記録）', async () => {
  const env = await makeEnv();
  try {
    await runSync(['pull', '--dir', env.dir]);
    writeFileSync(join(env.dir, 'Brand New.txt'), 'Brand New\nhello world\n');
    // create の PUT は通すが、直後の詳細取得（GET /api/pages/notes/<title>）だけ 404 を返す
    const patched: typeof fetch = async (input, init) => {
      if (detailPath(input) !== null) return new Response('not found', { status: 404 });
      return fetch(input, init);
    };
    const result = await runSync(['push', '--dir', env.dir], { fetchFn: patched });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /created but state not recorded/);
    assert.doesNotMatch(result.output, /^pushed:/m);
    // pageId は state に未記録
    assert.equal(Object.keys(loadState(env.dir).pages).length, 0);
  } finally { env.close(); }
});

void test('push: 1 行目を書き換えたファイル（リネーム企図）は送信しない', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Renamed Title\nbody\n');
    const result = await runSync(['push', '--dir', env.dir]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /rename/);
    const pageId = Object.keys(loadState(env.dir).pages)[0]!;
    const page = await env.storage.getPageById(pageId);
    assert.equal(page!.lines[0]!.text, 'Alpha'); // リモートは不変
  } finally { env.close(); }
});

void test('push: PUT の応答が失われても再送せず、確認再取得で state が揃う', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\nedited\n');
    const result = await runSync(['push', '--dir', env.dir], { fetchFn: putLosesResponse });
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /confirmed after error/);
    const pageId = Object.keys(loadState(env.dir).pages)[0]!;
    assert.equal(loadState(env.dir).pages[pageId]!.contentHash !== undefined, true);
    const page = await env.storage.getPageById(pageId);
    assert.deepEqual(page!.lines.map((l) => l.text), ['Alpha', 'edited']);
    assert.equal(loadState(env.dir).pages[pageId]!.version, page!.version);
  } finally { env.close(); }
});

void test('pull → push: CRLF で保存されたファイルも差分なしなら no-op', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['body line'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    // エディタが CRLF で保存し直した想定（内容は同一）
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\r\nbody line\r\n');
    assert.equal((await runSync(['status', '--dir', env.dir])).output, 'clean');
    assert.equal((await runSync(['push', '--dir', env.dir])).output, 'up to date');
  } finally { env.close(); }
});

void test('pull: 特殊文字タイトルのファイル名エスケープと round-trip push', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'a/b: c', ['body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    const filename = 'a%2Fb%3A c.txt';
    assert.equal(readFileSync(join(env.dir, filename), 'utf8'), 'a/b: c\nbody\n');
    writeFileSync(join(env.dir, filename), 'a/b: c\nedited\n');
    const result = await runSync(['push', '--dir', env.dir]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /^pushed:/m); // no-op（up to date）ではなく実際に送信されたこと
    const pageId = Object.keys(loadState(env.dir).pages)[0]!;
    const page = await env.storage.getPageById(pageId);
    assert.deepEqual(page!.lines.map((l) => l.text), ['a/b: c', 'edited']); // リモートに反映された
  } finally { env.close(); }
});

void test('pull: 詳細取得が 401 を返したら exitCode 2 で中断し、ファイル/state は変更しない', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['body'], env.clock.t);
    // 一覧は通常どおり 200 を返し、詳細取得（GET /api/pages/notes/<title>）だけ 401 を返す
    const patched: typeof fetch = async (input, init) => {
      if (detailPath(input) !== null) return new Response('unauthorized', { status: 401 });
      return fetch(input, init);
    };
    const result = await runSync(['pull', '--dir', env.dir], { fetchFn: patched });
    assert.equal(result.exitCode, 2);
    assert.ok(!existsSync(join(env.dir, 'Alpha.txt')));
    assert.equal(Object.keys(loadState(env.dir).pages).length, 0);
  } finally { env.close(); }
});

void test('status --remote: 認証エラーは例外を投げずに exitCode 2 を返す', async () => {
  const env = await makeEnv();
  try {
    const result = await runSync(
      ['status', '--dir', env.dir, '--remote'],
      { fetchFn: async () => new Response('unauthorized', { status: 401 }) },
    );
    assert.equal(result.exitCode, 2);
  } finally { env.close(); }
});

void test('pull: ローカルが既にリモートと同内容なら偽の競合として reconciled する（state 保存喪失の復旧）', async () => {
  const env = await makeEnv();
  try {
    const pageId = await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    // リモートを進める
    const page = await env.storage.getPageById(pageId);
    env.clock.t += 10;
    await env.storage.commit({
      projectId: env.projectId, pageId, commitId: ulid(env.clock.t * 1000),
      baseVersion: page!.version,
      ops: [{ type: 'insert', id: ulid(env.clock.t * 1000), after: page!.lines.at(-1)!.id, text: 'v2 line' }],
      userId: 'u', now: env.clock.t,
    });
    // 直前の pull がファイル書き込み後・state 保存前にクラッシュしていた状況を模す：
    // ローカルファイルは既に新しいリモート内容と一致しているが、state はまだ古いまま。
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\nv1 body\nv2 line\n');
    const result = await runSync(['pull', '--dir', env.dir]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /^reconciled: Alpha\.txt$/m);
    assert.ok(!existsSync(join(env.dir, '.knot', 'conflicts', pageId)));
    const page2 = await env.storage.getPageById(pageId);
    assert.equal(loadState(env.dir).pages[pageId]!.version, page2!.version);
  } finally { env.close(); }
});

void test('push: リモートが既にローカルと同内容なら偽の競合として reconciled する（state 保存喪失の復旧）', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\nedited body\n');
    const state = loadState(env.dir);
    const pageId = Object.keys(state.pages)[0]!;
    const page = await env.storage.getPageById(pageId);
    // push の PUT はサーバに届いて成功していたが、state 保存の直前でクラッシュした状況を
    // 直接コミットで模す（state はまだ旧 version/hash のまま）。
    env.clock.t += 10;
    await env.storage.commit({
      projectId: env.projectId, pageId, commitId: ulid(env.clock.t * 1000),
      baseVersion: page!.version,
      ops: [{ type: 'update', id: page!.lines[1]!.id, text: 'edited body' }],
      userId: 'u', now: env.clock.t,
    });
    const result = await runSync(['push', '--dir', env.dir]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /^reconciled: Alpha\.txt$/m);
    const finalPage = await env.storage.getPageById(pageId);
    assert.equal(loadState(env.dir).pages[pageId]!.version, finalPage!.version);
  } finally { env.close(); }
});

void test('pull: 追跡ファイル名の位置に通常の symlink があれば書き込みを拒否し、リンク先を変えない', async () => {
  const env = await makeEnv();
  const outside = mkdtempSync(join(tmpdir(), 'knot-sync-evil-'));
  try {
    const pageId = await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    // Alpha.txt を「同期ディレクトリ外」を指す通常の symlink に置き換える
    const target = join(outside, 'target.txt');
    writeFileSync(target, 'ORIGINAL\n');
    rmSync(join(env.dir, 'Alpha.txt'));
    symlinkSync(target, join(env.dir, 'Alpha.txt'));
    // リモートを進めて write を誘発する
    const page = await env.storage.getPageById(pageId);
    env.clock.t += 10;
    await env.storage.commit({
      projectId: env.projectId, pageId, commitId: ulid(env.clock.t * 1000),
      baseVersion: page!.version,
      ops: [{ type: 'insert', id: ulid(env.clock.t * 1000), after: page!.lines.at(-1)!.id, text: 'v2 line' }],
      userId: 'u', now: env.clock.t,
    });
    const result = await runSync(['pull', '--dir', env.dir]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /skipped \(refusing to write through symlink\): Alpha\.txt/);
    assert.equal(readFileSync(target, 'utf8'), 'ORIGINAL\n'); // リンク先は書き換わらない
  } finally { rmSync(outside, { recursive: true }); env.close(); }
});

void test('pull: 追跡ファイル名の位置にダングリング symlink があっても書き込みを拒否しリンク先を作らない', async () => {
  const env = await makeEnv();
  const outside = mkdtempSync(join(tmpdir(), 'knot-sync-evil-'));
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    // リンク先が存在しない（ダングリング）symlink に置き換える。existsSync は symlink を辿るため
    // false を返すが、ガードは無条件 lstat なので symlink を検出して拒否しなければならない。
    const target = join(outside, 'does-not-exist.txt');
    rmSync(join(env.dir, 'Alpha.txt'));
    symlinkSync(target, join(env.dir, 'Alpha.txt'));
    assert.equal(existsSync(target), false); // 事前条件: リンク先はまだ無い
    const result = await runSync(['pull', '--dir', env.dir]);
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /skipped \(refusing to write through symlink\): Alpha\.txt/);
    assert.equal(existsSync(target), false); // リンクを辿ってディレクトリ外に作成していない
  } finally { rmSync(outside, { recursive: true }); env.close(); }
});

void test('status --remote: リモート側の new / changed / deleted を表示する', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    await seedPage(env.storage, env.projectId, 'Fresh', ['new page'], env.clock.t + 10);
    const result = await runSync(['status', '--dir', env.dir, '--remote']);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /remote-new:\s+Fresh/);
  } finally { env.close(); }
});
