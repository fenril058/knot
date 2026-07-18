# knot 07: 外部エディタ同期 CLI（knot sync）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「1 ページ = 1 テキストファイル」でローカルディレクトリに書き出し、手動 pull / push でサーバと同期する `knot sync` サブコマンド群を実装する。

**Architecture:** 既存 CLI（`src/cli/`）に HTTP クライアントとして動く `src/cli/sync/` を追加する。判定ロジック（pull / push の判定表）は I/O から分離した純関数にし、state ファイル（`.knot/state.json`）で「最後に同期した version + 内容ハッシュ」を追跡する。サーバ側の変更はページ一覧 API への `version` フィールド追加の 1 点のみ。

**Tech Stack:** Node.js >= 24（type stripping、追加の実行時依存なし）、node:test + node:assert/strict、fetch（グローバル）、node:crypto（sha256）。

**Spec:** `docs/superpowers/specs/2026-07-19-knot-07-sync-cli-design.md`（全タスクの正）。

## Global Constraints

- Node.js >= 24。TypeScript は type stripping で直接実行し、ビルドは行わない。
- 新しい実行時依存を追加しない（fetch / node:crypto / node:fs のみ）。
- テストは node:test + node:assert/strict。実行は `direnv exec . npm test`（全体）または `direnv exec . node --test <file>`（単体）。
- タイムスタンプは Unix 秒。ID は ULID。
- 認証ヘッダは `x-personal-access-token`（Bearer ではない）。書き込みは `X-Knot-Client: knot-sync` も必須。
- 本文の正準形: UTF-8、BOM なし、LF、末尾改行なしの全行結合。ファイル書き出し時のみ末尾に LF を 1 つ付ける。
- exit code: 0 = 全成功、1 = 競合または部分失敗、2 = 設定・認証・接続の失敗。
- コミットメッセージ・コード内に OS ユーザー名や絶対パスを書かない。
- 隔離環境で実行する場合、worktree は必ず `wt switch --create <branch>` で作る。

## ファイル構成（最終形）

```
src/cli/sync/
  filenames.ts   ← タイトル⇔ファイル名の単射エスケープ（純関数）
  canonical.ts   ← 本文の正準形化と sha256 ハッシュ（純関数）
  config.ts      ← .knot/config.json の読み書き、URL 正規化、トークン解決
  state.ts       ← .knot/state.json の型・読み書き（アトミック）
  client.ts      ← HTTP クライアント（一覧・詳細・PUT text、一覧の完全性検証）
  decisions.ts   ← pull / push の判定表（純関数）
  commands.ts    ← runSync(argv): サブコマンド解釈と I/O 実行
src/cli/main.ts        ← dispatcher に sync 分岐を追加（--data 不要）
src/server/routes/read.ts  ← summaryToJson に version を追加
test/cli/sync-*.test.ts    ← 各モジュールのユニット + 実サーバ統合テスト
```

---

### Task 1: 一覧 API に version を追加（サーバ側変更はこれのみ）

**Files:**
- Modify: `src/server/routes/read.ts:11-24`（summaryToJson）
- Test: `test/server/read-list.test.ts`

**Interfaces:**
- Consumes: `PageSummary.version`（`src/storage/types.ts` に定義済み。ストレージは既に返している）
- Produces: `GET /api/pages/:project` のレスポンス `pages[]` に整数 `version` フィールド（knot 拡張）。Task 5 の client がこれに依存する。

- [ ] **Step 1: 失敗するテストを書く**

`test/server/read-list.test.ts` の最初のテスト（`GET /api/pages/:project が Cosense 形状で返す`）に追記:

```ts
  // knot 拡張: 同期 CLI が差分検出に使う version
  assert.equal(typeof alpha.version, 'number');
  assert.ok(alpha.version >= 1);
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/server/read-list.test.ts`
Expected: FAIL（`typeof alpha.version` が `'undefined'`）

- [ ] **Step 3: 実装する**

`src/server/routes/read.ts` の `summaryToJson` に 1 行追加:

```ts
function summaryToJson(p: PageSummary) {
  return {
    id: p.id,
    title: p.title,
    image: p.image,
    descriptions: p.descriptions,
    pin: p.pinned,
    views: 0,
    linked: p.linked,
    created: p.created,
    updated: p.updated,
    accessed: p.updated,
    version: p.version, // knot 拡張: 同期 CLI 用
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/server/read-list.test.ts`
Expected: PASS

- [ ] **Step 5: 周辺ツールの回帰を確認する**

Run: `direnv exec . node --test test/acceptance/cosense-cli.test.ts test/acceptance/mcp-server.test.ts`
Expected: PASS（両ツールとも未知フィールドを許容することを確認済みだが、実行して証明する）

- [ ] **Step 6: コミット**

```bash
git add src/server/routes/read.ts test/server/read-list.test.ts
git commit -m "feat(server): ページ一覧 API に knot 拡張 version を追加（sync CLI の差分検出用）"
```

---

### Task 2: filenames.ts — タイトル⇔ファイル名の単射エスケープ

**Files:**
- Create: `src/cli/sync/filenames.ts`
- Test: `test/cli/sync-filenames.test.ts`

**Interfaces:**
- Consumes: なし（純関数のみ）
- Produces: `titleToFilename(title: string): string`（`.txt` 付きファイル名）、`filenameToTitle(filename: string): string`（逆変換）。Task 7・9・10 が使う。

- [ ] **Step 1: 失敗するテストを書く**

`test/cli/sync-filenames.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filenameToTitle, titleToFilename } from '../../src/cli/sync/filenames.ts';

test('通常のタイトルはそのまま + .txt', () => {
  assert.equal(titleToFilename('カレーの作り方'), 'カレーの作り方.txt');
  assert.equal(titleToFilename('Meeting Notes 2026'), 'Meeting Notes 2026.txt');
});

test('OS で使えない文字を percent-encode する', () => {
  assert.equal(titleToFilename('a/b'), 'a%2Fb.txt');
  assert.equal(titleToFilename('c: d'), 'c%3A d.txt');
  assert.equal(titleToFilename('50%off'), '50%25off.txt');
  assert.equal(titleToFilename('q?<>|"*\\'), 'q%3F%3C%3E%7C%22%2A%5C.txt');
});

test('先頭ピリオド・末尾の空白とピリオドをエスケープする', () => {
  assert.equal(titleToFilename('.hidden'), '%2Ehidden.txt');
  assert.equal(titleToFilename('end '), 'end%20.txt');
  assert.equal(titleToFilename('end.'), 'end%2E.txt');
});

test('Windows 予約名は先頭文字をエスケープする', () => {
  assert.equal(titleToFilename('CON'), '%43ON.txt');
  assert.equal(titleToFilename('com1'), '%63om1.txt');
  assert.equal(titleToFilename('console'), 'console.txt'); // 予約名の前方一致はそのまま
});

test('制御文字をエスケープする', () => {
  assert.equal(titleToFilename('a\tb'), 'a%09b.txt');
});

test('round-trip: filenameToTitle(titleToFilename(t)) === t', () => {
  const titles = [
    'カレーの作り方', 'a/b', '50%off', '.hidden', 'end ', 'end.', 'CON',
    'A B_C', 'σ と ς', '%2F literal', 'a\tb', 'nested/path/like',
  ];
  for (const t of titles) assert.equal(filenameToTitle(titleToFilename(t)), t);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-filenames.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/cli/sync/filenames.ts`:

```ts
// タイトル⇔ファイル名の単射エスケープ。
// 方針: 可読性優先でタイトルをそのまま使い、FS で問題になる文字だけ %XX にする。
// エスケープ対象は ASCII のみなので %XX は常に 1 バイト = 1 文字。% 自体も
// エスケープするため逆変換は一意に定まる。

const UNSAFE = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*', '%']);

const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function hex(ch: string): string {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

export function titleToFilename(title: string): string {
  let out = '';
  for (const ch of title) {
    out += UNSAFE.has(ch) || ch.charCodeAt(0) < 0x20 ? hex(ch) : ch;
  }
  if (out.startsWith('.')) out = hex('.') + out.slice(1);
  const last = out.at(-1);
  if (last === ' ' || last === '.') out = out.slice(0, -1) + hex(last);
  if (RESERVED.has(out.toLowerCase())) out = hex(out[0]!) + out.slice(1);
  return `${out}.txt`;
}

export function filenameToTitle(filename: string): string {
  const stem = filename.endsWith('.txt') ? filename.slice(0, -4) : filename;
  return stem.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-filenames.test.ts`
Expected: PASS（全 6 テスト）

- [ ] **Step 5: コミット**

```bash
git add src/cli/sync/filenames.ts test/cli/sync-filenames.test.ts
git commit -m "feat(sync): タイトル⇔ファイル名の単射エスケープ"
```

---

### Task 3: canonical.ts — 本文の正準形とハッシュ

**Files:**
- Create: `src/cli/sync/canonical.ts`
- Test: `test/cli/sync-canonical.test.ts`

**Interfaces:**
- Consumes: `node:crypto` の `createHash`
- Produces: `canonicalizeText(raw: string): string`、`contentHash(canonical: string): string`（`sha256:<hex>` 形式）。Task 6・7・9・10 が使う。

- [ ] **Step 1: 失敗するテストを書く**

`test/cli/sync-canonical.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeText, contentHash } from '../../src/cli/sync/canonical.ts';

test('CRLF を LF に正規化する', () => {
  assert.equal(canonicalizeText('Title\r\nbody\r\n'), 'Title\nbody');
});

test('末尾の LF をちょうど 1 つ取り除く', () => {
  assert.equal(canonicalizeText('Title\nbody\n'), 'Title\nbody');
  assert.equal(canonicalizeText('Title\nbody'), 'Title\nbody');
  // 末尾空行はページ本文の一部として保持される（LF 2 つ → 1 つ残る）
  assert.equal(canonicalizeText('Title\nbody\n\n'), 'Title\nbody\n');
});

test('BOM を取り除く', () => {
  assert.equal(canonicalizeText('﻿Title\nbody'), 'Title\nbody');
});

test('contentHash は sha256: プレフィックス付き hex', () => {
  const h = contentHash('Title\nbody');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, contentHash('Title\nbody')); // 決定的
  assert.notEqual(h, contentHash('Title\nbody2'));
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-canonical.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/cli/sync/canonical.ts`:

```ts
import { createHash } from 'node:crypto';

// 正準形 = サーバの GET .../text と同じ「LF 結合・末尾改行なし」。
// ファイル書き出し時は POSIX 慣習で末尾 LF を 1 つ付け、読み込み時にここで 1 つ剥がす。
export function canonicalizeText(raw: string): string {
  let text = raw.startsWith('﻿') ? raw.slice(1) : raw;
  text = text.replaceAll('\r\n', '\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return text;
}

export function contentHash(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-canonical.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/cli/sync/canonical.ts test/cli/sync-canonical.test.ts
git commit -m "feat(sync): 本文の正準形化と sha256 ハッシュ"
```

---

### Task 4: config.ts + state.ts — 設定・トークン・同期状態

**Files:**
- Create: `src/cli/sync/config.ts`
- Create: `src/cli/sync/state.ts`
- Test: `test/cli/sync-config-state.test.ts`

**Interfaces:**
- Consumes: `CliError`（`src/cli/commands.ts` から import。既存クラス）
- Produces:
  - `normalizeBaseUrl(raw: string): string`（正規化済み URL。不正なら CliError）
  - `writeSyncConfig(dir: string, config: SyncConfig): void` / `loadSyncConfig(dir: string): SyncConfig`（`SyncConfig = { url: string; project: string }`）
  - `resolveToken(dir: string, env?: NodeJS.ProcessEnv): string`
  - `type PageState = { title: string; filename: string; version: number; contentHash: string }`
  - `type SyncState = { pages: Record<string, PageState> }`（キーは pageId）
  - `loadState(dir: string): SyncState` / `saveState(dir: string, state: SyncState): void`（アトミック書き込み）
  - Task 6〜11 が使う。

- [ ] **Step 1: 失敗するテストを書く**

`test/cli/sync-config-state.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSyncConfig, normalizeBaseUrl, resolveToken, writeSyncConfig } from '../../src/cli/sync/config.ts';
import { loadState, saveState } from '../../src/cli/sync/state.ts';
import { CliError } from '../../src/cli/commands.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'knot-sync-'));
}

test('normalizeBaseUrl: 末尾スラッシュを除去し origin+path を返す', () => {
  assert.equal(normalizeBaseUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  assert.equal(normalizeBaseUrl('https://wiki.example.com/knot/'), 'https://wiki.example.com/knot');
});

test('normalizeBaseUrl: userinfo・非 http(s)・query を拒否する', () => {
  assert.throws(() => normalizeBaseUrl('http://user:pw@host/'), CliError);
  assert.throws(() => normalizeBaseUrl('ftp://host/'), CliError);
  assert.throws(() => normalizeBaseUrl('http://host/?q=1'), CliError);
  assert.throws(() => normalizeBaseUrl('not a url'), CliError);
});

test('config の round-trip', () => {
  const dir = tmp();
  try {
    writeSyncConfig(dir, { url: 'http://127.0.0.1:3000', project: 'notes' });
    assert.deepEqual(loadSyncConfig(dir), { url: 'http://127.0.0.1:3000', project: 'notes' });
  } finally { rmSync(dir, { recursive: true }); }
});

test('loadSyncConfig: config が無ければ CliError', () => {
  const dir = tmp();
  try {
    assert.throws(() => loadSyncConfig(dir), CliError);
  } finally { rmSync(dir, { recursive: true }); }
});

test('resolveToken: KNOT_TOKEN 優先、なければ .knot/token、どちらも無ければ CliError', () => {
  const dir = tmp();
  try {
    assert.throws(() => resolveToken(dir, {}), CliError);
    mkdirSync(join(dir, '.knot'), { recursive: true });
    writeFileSync(join(dir, '.knot', 'token'), 'knot_filetoken\n');
    assert.equal(resolveToken(dir, {}), 'knot_filetoken');
    assert.equal(resolveToken(dir, { KNOT_TOKEN: 'knot_envtoken' }), 'knot_envtoken');
  } finally { rmSync(dir, { recursive: true }); }
});

test('state: 無ければ空、保存後は読み戻せる、tmp ファイルが残らない', () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, '.knot'), { recursive: true });
    assert.deepEqual(loadState(dir), { pages: {} });
    const state = {
      pages: { p1: { title: 'Alpha', filename: 'Alpha.txt', version: 3, contentHash: 'sha256:ab' } },
    };
    saveState(dir, state);
    assert.deepEqual(loadState(dir), state);
    assert.deepEqual(readdirSync(join(dir, '.knot')).sort(), ['state.json']);
  } finally { rmSync(dir, { recursive: true }); }
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-config-state.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/cli/sync/config.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError } from '../commands.ts';

export type SyncConfig = { url: string; project: string };

export function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError(`invalid url: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError(`url must be http(s): ${raw}`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new CliError('userinfo in url is not allowed');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new CliError('url must not contain query or fragment');
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

export function writeSyncConfig(dir: string, config: SyncConfig): void {
  mkdirSync(join(dir, '.knot'), { recursive: true });
  writeFileSync(join(dir, '.knot', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

export function loadSyncConfig(dir: string): SyncConfig {
  const path = join(dir, '.knot', 'config.json');
  if (!existsSync(path)) throw new CliError(`not a sync directory (missing ${join('.knot', 'config.json')}); run knot sync init first`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SyncConfig>;
  if (typeof parsed.url !== 'string' || typeof parsed.project !== 'string') {
    throw new CliError('invalid .knot/config.json: url and project required');
  }
  return { url: parsed.url, project: parsed.project };
}

export function resolveToken(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.KNOT_TOKEN;
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.trim();
  const path = join(dir, '.knot', 'token');
  if (!existsSync(path)) {
    throw new CliError('no API token: set KNOT_TOKEN or write .knot/token (create one with: knot token add)');
  }
  return readFileSync(path, 'utf8').trim();
}
```

`src/cli/sync/state.ts`:

```ts
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type PageState = {
  title: string;
  filename: string;
  version: number;
  contentHash: string;
};

export type SyncState = { pages: Record<string, PageState> };

export function loadState(dir: string): SyncState {
  const path = join(dir, '.knot', 'state.json');
  if (!existsSync(path)) return { pages: {} };
  return JSON.parse(readFileSync(path, 'utf8')) as SyncState;
}

// アトミック書き込み（tmp + rename）。ページ 1 件の成功ごとに呼ぶ。
export function saveState(dir: string, state: SyncState): void {
  const path = join(dir, '.knot', 'state.json');
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-config-state.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/cli/sync/config.ts src/cli/sync/state.ts test/cli/sync-config-state.test.ts
git commit -m "feat(sync): 設定・トークン解決・同期 state のアトミック保存"
```

---

### Task 5: client.ts — HTTP クライアントと一覧の完全性検証

**Files:**
- Create: `src/cli/sync/client.ts`
- Test: `test/cli/sync-client.test.ts`

**Interfaces:**
- Consumes: `encodeTitleForUrl`（`src/core/title.ts`、定義済み）、Task 1 の一覧 `version`
- Produces:
  - `type PageEntry = { id: string; title: string; version: number }`
  - `type RemotePage = { id: string; title: string; version: number; text: string }`
  - `type PutTextResult = { kind: 'ok'; version: number } | { kind: 'conflict' }`
  - `class SyncHttpError extends Error { status?: number }`
  - `makeSyncClient(opts: { baseUrl: string; project: string; token: string; fetchFn?: typeof fetch }): SyncClient`
  - `type SyncClient = { listPages(): Promise<PageEntry[]>; getPage(title: string): Promise<RemotePage | null>; putText(title: string, baseVersion: number, text: string): Promise<PutTextResult> }`
  - Task 9〜11 が使う。

- [ ] **Step 1: 失敗するテストを書く**

`test/cli/sync-client.test.ts`（fetch をモックしてページング・完全性検証・ヘッダを検証する）:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSyncClient, SyncHttpError } from '../../src/cli/sync/client.ts';

type Handler = (url: string, init?: RequestInit) => Response;

function fakeFetch(handler: Handler): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const opts = { baseUrl: 'http://h', project: 'proj', token: 'knot_t' };

test('listPages: ページングして全件返し、認証ヘッダを送る', async () => {
  const calls: string[] = [];
  const p = (i: number) => ({ id: `id${i}`, title: `T${i}`, version: 1 });
  const client = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch((url, init) => {
      calls.push(url);
      assert.equal(new Headers(init?.headers).get('x-personal-access-token'), 'knot_t');
      const skip = Number(new URL(url).searchParams.get('skip'));
      const pages = [p(skip), p(skip + 1)].filter((x) => Number(x.id.slice(2)) < 3);
      return json(200, { count: 3, pages });
    }),
  });
  const result = await client.listPages();
  assert.deepEqual(result.map((x) => x.id), ['id0', 'id1', 'id2']);
  assert.ok(calls.every((u) => u.includes('sort=title')));
});

test('listPages: version が無いサーバはエラーにする', async () => {
  const client = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch(() => json(200, { count: 1, pages: [{ id: 'a', title: 'A' }] })),
  });
  await assert.rejects(client.listPages(), SyncHttpError);
});

test('listPages: id 重複と件数不一致はエラーにする', async () => {
  const dup = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch(() =>
      json(200, { count: 2, pages: [{ id: 'a', title: 'A', version: 1 }, { id: 'a', title: 'B', version: 1 }] })),
  });
  await assert.rejects(dup.listPages(), SyncHttpError);
  const short = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch(() => json(200, { count: 5, pages: [{ id: 'a', title: 'A', version: 1 }] })),
  });
  await assert.rejects(short.listPages(), SyncHttpError);
});

test('getPage: 詳細を text に組み立てる。404 は null', async () => {
  const client = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch((url) =>
      url.includes('Missing')
        ? json(404, { error: 'not_found' })
        : json(200, {
            id: 'p1', title: 'Alpha', version: 4,
            lines: [{ id: 'l1', text: 'Alpha' }, { id: 'l2', text: 'body' }],
          })),
  });
  assert.deepEqual(await client.getPage('Alpha'), { id: 'p1', title: 'Alpha', version: 4, text: 'Alpha\nbody' });
  assert.equal(await client.getPage('Missing'), null);
});

test('putText: X-Knot-Client を送り、200 は ok、409 は conflict', async () => {
  const client = makeSyncClient({
    ...opts,
    fetchFn: fakeFetch((url, init) => {
      assert.equal(init?.method, 'PUT');
      assert.equal(new Headers(init?.headers).get('x-knot-client'), 'knot-sync');
      const body = JSON.parse(String(init?.body)) as { baseVersion: number };
      return body.baseVersion === 3 ? json(200, { version: 4, commitId: 'c' }) : json(409, { error: 'conflict' });
    }),
  });
  assert.deepEqual(await client.putText('Alpha', 3, 'Alpha\nbody'), { kind: 'ok', version: 4 });
  assert.deepEqual(await client.putText('Alpha', 1, 'Alpha\nbody'), { kind: 'conflict' });
});

test('401 は認証エラーとして SyncHttpError(status=401)', async () => {
  const client = makeSyncClient({ ...opts, fetchFn: fakeFetch(() => json(401, { error: 'unauthorized' })) });
  await assert.rejects(client.listPages(), (e: SyncHttpError) => e.status === 401);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-client.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/cli/sync/client.ts`:

```ts
import { encodeTitleForUrl } from '../../core/title.ts';

export type PageEntry = { id: string; title: string; version: number };
export type RemotePage = { id: string; title: string; version: number; text: string };
export type PutTextResult = { kind: 'ok'; version: number } | { kind: 'conflict' };

export class SyncHttpError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'SyncHttpError';
  }
}

export type SyncClient = {
  listPages(): Promise<PageEntry[]>;
  getPage(title: string): Promise<RemotePage | null>;
  putText(title: string, baseVersion: number, text: string): Promise<PutTextResult>;
};

export function makeSyncClient(opts: {
  baseUrl: string;
  project: string;
  token: string;
  fetchFn?: typeof fetch;
}): SyncClient {
  const fetchFn = opts.fetchFn ?? fetch;
  const authHeaders = { 'x-personal-access-token': opts.token };
  const projectSeg = encodeURIComponent(opts.project);

  // redirect: 'error' — 認証ヘッダを別 origin へ転送しない
  const get = async (path: string): Promise<Response> => {
    const res = await fetchFn(`${opts.baseUrl}${path}`, { headers: authHeaders, redirect: 'error' });
    if (res.status === 401) throw new SyncHttpError('unauthorized: check API token', 401);
    return res;
  };

  const listPages = async (): Promise<PageEntry[]> => {
    const out: PageEntry[] = [];
    let count = 0;
    for (;;) {
      const res = await get(`/api/pages/${projectSeg}?sort=title&limit=1000&skip=${out.length}`);
      if (!res.ok) throw new SyncHttpError(`page list failed: ${res.status}`, res.status);
      const body = (await res.json()) as { count: number; pages: Array<Partial<PageEntry>> };
      count = body.count;
      for (const p of body.pages) {
        if (typeof p.id !== 'string' || typeof p.title !== 'string') {
          throw new SyncHttpError('page list entry missing id/title');
        }
        if (typeof p.version !== 'number') {
          throw new SyncHttpError('server does not return version in page list; upgrade the knot server');
        }
        out.push({ id: p.id, title: p.title, version: p.version });
      }
      if (body.pages.length === 0 || out.length >= count) break;
    }
    if (out.length !== count) {
      throw new SyncHttpError(`page list incomplete: got ${out.length} of ${count}; retry later`);
    }
    if (new Set(out.map((p) => p.id)).size !== out.length) {
      throw new SyncHttpError('page list changed during fetch (duplicate ids); retry later');
    }
    return out;
  };

  const getPage = async (title: string): Promise<RemotePage | null> => {
    const res = await get(`/api/pages/${projectSeg}/${encodeTitleForUrl(title)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new SyncHttpError(`get page failed: ${res.status}`, res.status);
    const body = (await res.json()) as {
      id: string; title: string; version: number; lines: Array<{ text: string }>;
    };
    return { id: body.id, title: body.title, version: body.version, text: body.lines.map((l) => l.text).join('\n') };
  };

  const putText = async (title: string, baseVersion: number, text: string): Promise<PutTextResult> => {
    const res = await fetchFn(
      `${opts.baseUrl}/api/knot/pages/${projectSeg}/${encodeTitleForUrl(title)}/text`,
      {
        method: 'PUT',
        redirect: 'error',
        headers: { ...authHeaders, 'X-Knot-Client': 'knot-sync', 'content-type': 'application/json' },
        body: JSON.stringify({ baseVersion, text }),
      },
    );
    if (res.status === 401) throw new SyncHttpError('unauthorized: check API token', 401);
    if (res.status === 409) return { kind: 'conflict' };
    if (!res.ok) throw new SyncHttpError(`put failed: ${res.status}`, res.status);
    const body = (await res.json()) as { version: number };
    return { kind: 'ok', version: body.version };
  };

  return { listPages, getPage, putText };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-client.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/cli/sync/client.ts test/cli/sync-client.test.ts
git commit -m "feat(sync): 同期用 HTTP クライアント（一覧の完全性検証つき）"
```

---

### Task 6: decisions.ts — pull 判定表（純関数）

**Files:**
- Create: `src/cli/sync/decisions.ts`
- Test: `test/cli/sync-decisions.test.ts`

**Interfaces:**
- Consumes: `SyncState`（Task 4）、`PageEntry`（Task 5）
- Produces:
  - `type PullAction = { kind: 'write'; pageId: string; title: string } | { kind: 'conflict'; pageId: string; title: string } | { kind: 'delete-local'; pageId: string } | { kind: 'keep-deleted'; pageId: string }`
  - `planPull(input: { state: SyncState; remote: PageEntry[]; localHashes: Map<string, string> }): PullAction[]`
    - `localHashes` は「存在するファイルのみ」の filename → 正準形 contentHash
  - Task 9 が使う。

- [ ] **Step 1: 失敗するテストを書く**

`test/cli/sync-decisions.test.ts`（このタスクでは pull 側のみ。push 側は Task 7 で追記）:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPull } from '../../src/cli/sync/decisions.ts';
import type { SyncState } from '../../src/cli/sync/state.ts';

const st = (over: Partial<SyncState['pages'][string]> = {}) => ({
  title: 'Alpha', filename: 'Alpha.txt', version: 3, contentHash: 'sha256:aa', ...over,
});

test('pull: state に無いリモートページは write', () => {
  const actions = planPull({
    state: { pages: {} },
    remote: [{ id: 'p1', title: 'Alpha', version: 1 }],
    localHashes: new Map(),
  });
  assert.deepEqual(actions, [{ kind: 'write', pageId: 'p1', title: 'Alpha' }]);
});

test('pull: ローカル未変更 & リモート更新 → write', () => {
  const actions = planPull({
    state: { pages: { p1: st() } },
    remote: [{ id: 'p1', title: 'Alpha', version: 4 }],
    localHashes: new Map([['Alpha.txt', 'sha256:aa']]),
  });
  assert.deepEqual(actions, [{ kind: 'write', pageId: 'p1', title: 'Alpha' }]);
});

test('pull: ローカル変更あり & リモート更新なし → 何もしない', () => {
  const actions = planPull({
    state: { pages: { p1: st() } },
    remote: [{ id: 'p1', title: 'Alpha', version: 3 }],
    localHashes: new Map([['Alpha.txt', 'sha256:MODIFIED']]),
  });
  assert.deepEqual(actions, []);
});

test('pull: 両方変更 → conflict', () => {
  const actions = planPull({
    state: { pages: { p1: st() } },
    remote: [{ id: 'p1', title: 'Alpha', version: 4 }],
    localHashes: new Map([['Alpha.txt', 'sha256:MODIFIED']]),
  });
  assert.deepEqual(actions, [{ kind: 'conflict', pageId: 'p1', title: 'Alpha' }]);
});

test('pull: ローカルファイル消失（削除は伝播しない）→ write で復元', () => {
  const actions = planPull({
    state: { pages: { p1: st() } },
    remote: [{ id: 'p1', title: 'Alpha', version: 3 }],
    localHashes: new Map(),
  });
  assert.deepEqual(actions, [{ kind: 'write', pageId: 'p1', title: 'Alpha' }]);
});

test('pull: リモートのリネームは version が同じでも write（ID 追跡）', () => {
  const actions = planPull({
    state: { pages: { p1: st() } },
    remote: [{ id: 'p1', title: 'Alpha2', version: 4 }],
    localHashes: new Map([['Alpha.txt', 'sha256:aa']]),
  });
  assert.deepEqual(actions, [{ kind: 'write', pageId: 'p1', title: 'Alpha2' }]);
});

test('pull: リネーム & ローカル変更あり → conflict', () => {
  const actions = planPull({
    state: { pages: { p1: st() } },
    remote: [{ id: 'p1', title: 'Alpha2', version: 4 }],
    localHashes: new Map([['Alpha.txt', 'sha256:MODIFIED']]),
  });
  assert.deepEqual(actions, [{ kind: 'conflict', pageId: 'p1', title: 'Alpha2' }]);
});

test('pull: リモート削除 → ローカル未変更なら delete-local、変更ありなら keep-deleted', () => {
  const clean = planPull({
    state: { pages: { p1: st() } },
    remote: [],
    localHashes: new Map([['Alpha.txt', 'sha256:aa']]),
  });
  assert.deepEqual(clean, [{ kind: 'delete-local', pageId: 'p1' }]);
  const dirty = planPull({
    state: { pages: { p1: st() } },
    remote: [],
    localHashes: new Map([['Alpha.txt', 'sha256:MODIFIED']]),
  });
  assert.deepEqual(dirty, [{ kind: 'keep-deleted', pageId: 'p1' }]);
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-decisions.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装する**

`src/cli/sync/decisions.ts`:

```ts
import type { PageEntry } from './client.ts';
import type { SyncState } from './state.ts';

export type PullAction =
  | { kind: 'write'; pageId: string; title: string }
  | { kind: 'conflict'; pageId: string; title: string }
  | { kind: 'delete-local'; pageId: string }
  | { kind: 'keep-deleted'; pageId: string };

export function planPull(input: {
  state: SyncState;
  remote: PageEntry[];
  localHashes: Map<string, string>;
}): PullAction[] {
  const actions: PullAction[] = [];
  const remoteIds = new Set(input.remote.map((p) => p.id));
  for (const p of input.remote) {
    const st = input.state.pages[p.id];
    if (st === undefined) {
      actions.push({ kind: 'write', pageId: p.id, title: p.title });
      continue;
    }
    const localHash = input.localHashes.get(st.filename);
    const localMissing = localHash === undefined;
    const localChanged = !localMissing && localHash !== st.contentHash;
    const remoteChanged = p.version !== st.version || p.title !== st.title;
    if (!remoteChanged && !localMissing) continue; // 未変更、またはローカル変更のみ（push 待ち）
    if (remoteChanged && localChanged) {
      actions.push({ kind: 'conflict', pageId: p.id, title: p.title });
      continue;
    }
    // リモート更新 or リネーム or ローカル消失の復元
    actions.push({ kind: 'write', pageId: p.id, title: p.title });
  }
  for (const [pageId, st] of Object.entries(input.state.pages)) {
    if (remoteIds.has(pageId)) continue;
    const localHash = input.localHashes.get(st.filename);
    const localChanged = localHash !== undefined && localHash !== st.contentHash;
    actions.push(localChanged ? { kind: 'keep-deleted', pageId } : { kind: 'delete-local', pageId });
  }
  return actions;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-decisions.test.ts`
Expected: PASS（8 テスト）

- [ ] **Step 5: コミット**

```bash
git add src/cli/sync/decisions.ts test/cli/sync-decisions.test.ts
git commit -m "feat(sync): pull 判定表（純関数）"
```

---

### Task 7: decisions.ts — push 判定表（純関数）

**Files:**
- Modify: `src/cli/sync/decisions.ts`
- Test: `test/cli/sync-decisions.test.ts`（追記）

**Interfaces:**
- Consumes: `titleLc`（`src/core/title.ts`）、`filenameToTitle`（Task 2）
- Produces:
  - `type PushAction = { kind: 'update'; pageId: string; filename: string; title: string; baseVersion: number } | { kind: 'create'; filename: string; title: string } | { kind: 'skip-rename'; filename: string; stateTitle: string; fileTitle: string } | { kind: 'skip-title-mismatch'; filename: string; fileTitle: string } | { kind: 'skip-duplicate'; filename: string; title: string }`
  - `planPush(input: { state: SyncState; localFiles: Map<string, { firstLine: string; contentHash: string }>; remoteTitleLcs: Set<string> }): PushAction[]`
    - `update.title` は state に保存した同期時タイトル（URL 構築用）。
  - Task 10 が使う。

- [ ] **Step 1: 失敗するテストを書く**

`test/cli/sync-decisions.test.ts` に追記:

```ts
import { planPush } from '../../src/cli/sync/decisions.ts';

test('push: ハッシュが state と同じファイルは対象外', () => {
  const actions = planPush({
    state: { pages: { p1: st() } },
    localFiles: new Map([['Alpha.txt', { firstLine: 'Alpha', contentHash: 'sha256:aa' }]]),
    remoteTitleLcs: new Set(['alpha']),
  });
  assert.deepEqual(actions, []);
});

test('push: 変更ありファイルは update（URL は state のタイトル）', () => {
  const actions = planPush({
    state: { pages: { p1: st() } },
    localFiles: new Map([['Alpha.txt', { firstLine: 'Alpha', contentHash: 'sha256:new' }]]),
    remoteTitleLcs: new Set(['alpha']),
  });
  assert.deepEqual(actions, [
    { kind: 'update', pageId: 'p1', filename: 'Alpha.txt', title: 'Alpha', baseVersion: 3 },
  ]);
});

test('push: 1 行目の titleLc が state と食い違えば skip-rename', () => {
  const actions = planPush({
    state: { pages: { p1: st() } },
    localFiles: new Map([['Alpha.txt', { firstLine: 'Renamed', contentHash: 'sha256:new' }]]),
    remoteTitleLcs: new Set(['alpha']),
  });
  assert.deepEqual(actions, [
    { kind: 'skip-rename', filename: 'Alpha.txt', stateTitle: 'Alpha', fileTitle: 'Renamed' },
  ]);
});

test('push: 1 行目の大文字小文字・空白/アンダースコア差は同一タイトル扱いで update', () => {
  const actions = planPush({
    state: { pages: { p1: st({ title: 'Foo Bar', filename: 'Foo Bar.txt' }) } },
    localFiles: new Map([['Foo Bar.txt', { firstLine: 'foo_bar', contentHash: 'sha256:new' }]]),
    remoteTitleLcs: new Set(['foo_bar']),
  });
  assert.equal(actions[0]?.kind, 'update');
});

test('push: state に無い新規ファイルは create（タイトルは 1 行目）', () => {
  const actions = planPush({
    state: { pages: {} },
    localFiles: new Map([['New Page.txt', { firstLine: 'New Page', contentHash: 'sha256:n' }]]),
    remoteTitleLcs: new Set(),
  });
  assert.deepEqual(actions, [{ kind: 'create', filename: 'New Page.txt', title: 'New Page' }]);
});

test('push: 新規ファイルの 1 行目とファイル名が食い違えば skip-title-mismatch', () => {
  const actions = planPush({
    state: { pages: {} },
    localFiles: new Map([['New Page.txt', { firstLine: 'Other Title', contentHash: 'sha256:n' }]]),
    remoteTitleLcs: new Set(),
  });
  assert.deepEqual(actions, [
    { kind: 'skip-title-mismatch', filename: 'New Page.txt', fileTitle: 'Other Title' },
  ]);
});

test('push: 新規ファイルがリモート既存 titleLc と重複したら skip-duplicate', () => {
  const actions = planPush({
    state: { pages: {} },
    localFiles: new Map([['Alpha.txt', { firstLine: 'Alpha', contentHash: 'sha256:n' }]]),
    remoteTitleLcs: new Set(['alpha']),
  });
  assert.deepEqual(actions, [{ kind: 'skip-duplicate', filename: 'Alpha.txt', title: 'Alpha' }]);
});

test('push: 新規ファイル同士の titleLc 重複は後者を skip-duplicate', () => {
  const actions = planPush({
    state: { pages: {} },
    localFiles: new Map([
      ['Foo Bar.txt', { firstLine: 'Foo Bar', contentHash: 'sha256:1' }],
      ['foo_bar.txt', { firstLine: 'foo_bar', contentHash: 'sha256:2' }],
    ]),
    remoteTitleLcs: new Set(),
  });
  assert.equal(actions[0]?.kind, 'create');
  assert.equal(actions[1]?.kind, 'skip-duplicate');
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-decisions.test.ts`
Expected: FAIL（planPush が存在しない）

- [ ] **Step 3: 実装する**

`src/cli/sync/decisions.ts` に追記:

```ts
import { titleLc } from '../../core/title.ts';
import { filenameToTitle } from './filenames.ts';

export type PushAction =
  | { kind: 'update'; pageId: string; filename: string; title: string; baseVersion: number }
  | { kind: 'create'; filename: string; title: string }
  | { kind: 'skip-rename'; filename: string; stateTitle: string; fileTitle: string }
  | { kind: 'skip-title-mismatch'; filename: string; fileTitle: string }
  | { kind: 'skip-duplicate'; filename: string; title: string };

export function planPush(input: {
  state: SyncState;
  localFiles: Map<string, { firstLine: string; contentHash: string }>;
  remoteTitleLcs: Set<string>;
}): PushAction[] {
  const actions: PushAction[] = [];
  const byFilename = new Map(
    Object.entries(input.state.pages).map(([id, st]) => [st.filename, { id, st }]),
  );
  const claimedLcs = new Set<string>();
  for (const [filename, file] of input.localFiles) {
    const entry = byFilename.get(filename);
    if (entry !== undefined) {
      if (file.contentHash === entry.st.contentHash) continue;
      if (titleLc(file.firstLine) !== titleLc(entry.st.title)) {
        // サーバは既存ページのタイトル行変更をリネームとして受理してしまうため、CLI 側で拒否する
        actions.push({ kind: 'skip-rename', filename, stateTitle: entry.st.title, fileTitle: file.firstLine });
        continue;
      }
      actions.push({ kind: 'update', pageId: entry.id, filename, title: entry.st.title, baseVersion: entry.st.version });
      continue;
    }
    const title = file.firstLine;
    const lc = titleLc(title);
    if (titleLc(filenameToTitle(filename)) !== lc) {
      actions.push({ kind: 'skip-title-mismatch', filename, fileTitle: title });
      continue;
    }
    if (input.remoteTitleLcs.has(lc) || claimedLcs.has(lc)) {
      actions.push({ kind: 'skip-duplicate', filename, title });
      continue;
    }
    claimedLcs.add(lc);
    actions.push({ kind: 'create', filename, title });
  }
  return actions;
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-decisions.test.ts`
Expected: PASS（pull 8 + push 8 テスト）

- [ ] **Step 5: コミット**

```bash
git add src/cli/sync/decisions.ts test/cli/sync-decisions.test.ts
git commit -m "feat(sync): push 判定表（リネーム検査・titleLc 重複検査つき）"
```

---

### Task 8: dispatcher 再構成 + sync init / status（ローカルのみ）

**Files:**
- Create: `src/cli/sync/commands.ts`
- Modify: `src/cli/main.ts`
- Test: `test/cli/sync-commands.test.ts`

**Interfaces:**
- Consumes: Task 2〜7 の全モジュール
- Produces:
  - `type SyncResult = { output: string; exitCode: 0 | 1 | 2 }`
  - `runSync(argv: string[], deps?: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<SyncResult>`
    - argv 例: `['init', './wiki', '--url', 'http://...', '--project', 'notes']`、`['pull', '--dir', './wiki']`、`['push', '--dir', './wiki', '--force']`、`['status', '--dir', './wiki', '--remote']`
    - pull / push / status の `--dir` 既定は `.`（カレントディレクトリ）。
  - `readLocalFiles(dir: string): Map<string, { firstLine: string; contentHash: string; canonical: string }>`（`.txt` ファイルの走査。`.knot/` は対象外）
  - Task 9・10 がこのファイルに pull / push の実装を追記する。この時点で pull / push は `exitCode: 2` + `not implemented` を返すスタブ。

- [ ] **Step 1: 失敗するテストを書く**

`test/cli/sync-commands.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSync } from '../../src/cli/sync/commands.ts';
import { saveState } from '../../src/cli/sync/state.ts';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'knot-sync-'));
}

test('sync init: config を書き、gitignore 案内を出す', async () => {
  const dir = tmp();
  try {
    const result = await runSync(['init', dir, '--url', 'http://127.0.0.1:3000/', '--project', 'notes']);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /\.knot/); // gitignore 案内
    const config = JSON.parse(readFileSync(join(dir, '.knot', 'config.json'), 'utf8'));
    assert.deepEqual(config, { url: 'http://127.0.0.1:3000', project: 'notes' }); // 末尾スラッシュ正規化
  } finally { rmSync(dir, { recursive: true }); }
});

test('sync init: 不正 URL は exitCode 2', async () => {
  const dir = tmp();
  try {
    const result = await runSync(['init', dir, '--url', 'ftp://x/', '--project', 'notes']);
    assert.equal(result.exitCode, 2);
  } finally { rmSync(dir, { recursive: true }); }
});

test('sync status（ローカルのみ）: modified / new / missing を一覧する', async () => {
  const dir = tmp();
  try {
    await runSync(['init', dir, '--url', 'http://h', '--project', 'notes']);
    saveState(dir, {
      pages: {
        p1: { title: 'Alpha', filename: 'Alpha.txt', version: 1, contentHash: 'sha256:other' },
        p2: { title: 'Gone', filename: 'Gone.txt', version: 1, contentHash: 'sha256:x' },
      },
    });
    writeFileSync(join(dir, 'Alpha.txt'), 'Alpha\nmodified body\n');
    writeFileSync(join(dir, 'New Page.txt'), 'New Page\nhello\n');
    const result = await runSync(['status', '--dir', dir]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /modified:\s+Alpha\.txt/);
    assert.match(result.output, /new:\s+New Page\.txt/);
    assert.match(result.output, /missing:\s+Gone\.txt/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('sync: 未知サブコマンドと config 不在は exitCode 2', async () => {
  const dir = tmp();
  try {
    assert.equal((await runSync(['bogus'])).exitCode, 2);
    assert.equal((await runSync(['status', '--dir', dir])).exitCode, 2); // init していない
  } finally { rmSync(dir, { recursive: true }); }
});
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-commands.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: sync/commands.ts を実装する**

`src/cli/sync/commands.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { CliError } from '../commands.ts';
import { canonicalizeText, contentHash } from './canonical.ts';
import { loadSyncConfig, normalizeBaseUrl, resolveToken, writeSyncConfig } from './config.ts';
import { loadState } from './state.ts';

export type SyncResult = { output: string; exitCode: 0 | 1 | 2 };
export type SyncDeps = { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv };

export const SYNC_USAGE = `usage:
  knot sync init <dir> --url <base-url> --project <name>
  knot sync pull   [--dir <dir>]
  knot sync push   [--dir <dir>] [--force]
  knot sync status [--dir <dir>] [--remote]`;

export type LocalFile = { firstLine: string; contentHash: string; canonical: string };

// 同期ディレクトリ直下の .txt を走査する（.knot/ とサブディレクトリは対象外）
export function readLocalFiles(dir: string): Map<string, LocalFile> {
  const out = new Map<string, LocalFile>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.txt')) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const canonical = canonicalizeText(readFileSync(path, 'utf8'));
    out.set(name, { firstLine: canonical.split('\n')[0] ?? '', contentHash: contentHash(canonical), canonical });
  }
  return out;
}

async function runInit(positionals: string[], values: Record<string, unknown>): Promise<SyncResult> {
  const dir = positionals[0];
  const url = values.url as string | undefined;
  const project = values.project as string | undefined;
  if (dir === undefined || url === undefined || project === undefined) throw new CliError(SYNC_USAGE);
  writeSyncConfig(dir, { url: normalizeBaseUrl(url), project });
  return {
    exitCode: 0,
    output: [
      `initialized sync directory for project "${project}"`,
      'next steps:',
      '  - echo ".knot/" >> .gitignore   (トークンと state を git 管理に入れない)',
      '  - export KNOT_TOKEN=knot_...    (または .knot/token に保存し chmod 600)',
      '  - knot sync pull',
    ].join('\n'),
  };
}

async function runStatus(values: Record<string, unknown>, deps: SyncDeps): Promise<SyncResult> {
  const dir = (values.dir as string | undefined) ?? '.';
  loadSyncConfig(dir); // sync ディレクトリでなければ CliError
  const state = loadState(dir);
  const local = readLocalFiles(dir);
  const lines: string[] = [];
  const known = new Set<string>();
  for (const st of Object.values(state.pages)) {
    known.add(st.filename);
    const file = local.get(st.filename);
    if (file === undefined) lines.push(`missing:  ${st.filename}`);
    else if (file.contentHash !== st.contentHash) lines.push(`modified: ${st.filename}`);
  }
  for (const name of local.keys()) {
    if (!known.has(name)) lines.push(`new:      ${name}`);
  }
  if (values.remote === true) {
    lines.push(...(await remoteStatusLines(dir, deps)));
  }
  return { exitCode: 0, output: lines.length === 0 ? 'clean' : lines.join('\n') };
}

// Task 9 で pull と共に実装する（それまでは未実装）
async function remoteStatusLines(_dir: string, _deps: SyncDeps): Promise<string[]> {
  throw new CliError('status --remote is not implemented yet');
}

export async function runSync(argv: string[], deps: SyncDeps = {}): Promise<SyncResult> {
  try {
    const [sub, ...rest] = argv;
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        url: { type: 'string' },
        project: { type: 'string' },
        dir: { type: 'string' },
        force: { type: 'boolean' },
        remote: { type: 'boolean' },
      },
    });
    switch (sub) {
      case 'init':
        return await runInit(positionals, values);
      case 'status':
        return await runStatus(values, deps);
      case 'pull':
        return await runPull(values, deps);
      case 'push':
        return await runPush(values, deps);
      default:
        throw new CliError(SYNC_USAGE);
    }
  } catch (e) {
    if (e instanceof CliError) return { exitCode: 2, output: e.message };
    throw e;
  }
}

// Task 9 / Task 10 で実装する
async function runPull(_values: Record<string, unknown>, _deps: SyncDeps): Promise<SyncResult> {
  throw new CliError('pull is not implemented yet');
}
async function runPush(_values: Record<string, unknown>, _deps: SyncDeps): Promise<SyncResult> {
  throw new CliError('push is not implemented yet');
}
```

- [ ] **Step 4: main.ts に sync 分岐を足す**

`src/cli/main.ts` の `main` 関数冒頭（`parseArgs` の前）に分岐を追加し、USAGE に sync の行を足す:

```ts
import { runSync, SYNC_USAGE } from './sync/commands.ts';
```

```ts
async function main(argv: string[]): Promise<string> {
  const [command, ...rest] = argv;
  if (command === 'sync') {
    const result = await runSync(rest);
    process.exitCode = result.exitCode;
    return result.output;
  }
  // 以降は既存のとおり（sync 以外は --data 必須）
```

USAGE 定数の `knot serve` の行の後に追記:

```
  knot sync init <dir> --url <base-url> --project <name>
  knot sync pull|push|status [--dir <dir>]   (詳細: knot sync --help 相当は SYNC_USAGE)
```

注意: 既存の `main().then(...)` は返り値を `console.log` して終わる。`process.exitCode` を sync 側で設定するため、成功パス（exitCode 1/2 でも output は stdout に出る）はそのままでよい。

- [ ] **Step 5: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-commands.test.ts && direnv exec . node --test test/cli/cli.test.ts`
Expected: PASS（既存 CLI テストの回帰も確認）

- [ ] **Step 6: 型検査**

Run: `direnv exec . npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add src/cli/sync/commands.ts src/cli/main.ts test/cli/sync-commands.test.ts
git commit -m "feat(sync): sync サブコマンドの dispatcher・init・status（ローカル）"
```

---

### Task 9: sync pull の実装と実サーバ統合テスト

**Files:**
- Modify: `src/cli/sync/commands.ts`（runPull と remoteStatusLines を実装）
- Test: `test/cli/sync-integration.test.ts`（新規）

**Interfaces:**
- Consumes: Task 5 の SyncClient、Task 6 の planPull、Task 2 の titleToFilename
- Produces: `knot sync pull` の完全な挙動（詳細 id 検証、リネーム追跡、競合隔離、ファイル名衝突の接尾辞、ページごとの state 保存）。Task 10・11 の統合テストがこのテストファイルに追記する。

- [ ] **Step 1: 統合テストのヘルパと pull テストを書く**

`test/cli/sync-integration.test.ts`（実サーバを `@hono/node-server` で起動する。`test/acceptance/cosense-cli.test.ts` と同じパターン）:

```ts
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
    for (const [pageId, st] of Object.entries(state.pages)) {
      env.clock.t += 10;
      await env.storage.deletePage(env.projectId, pageId, env.clock.t);
      void st;
    }
    const result = await runSync(['pull', '--dir', env.dir]);
    assert.equal(result.exitCode, 1); // Kept の温存を報告
    assert.ok(!existsSync(join(env.dir, 'Gone.txt')));
    assert.equal(readFileSync(join(env.dir, 'Kept.txt'), 'utf8'), 'Kept\nlocal edit\n');
  } finally { env.close(); }
});
```

注意: `storage.getPageById` / `storage.deletePage` / `seedPage` のシグネチャは実装時に `src/storage/types.ts` と `test/helpers/pages.ts` を確認し、実際の形に合わせること（存在しない場合は `getPageByTitle` + titleLc で代替してよい。テストの意図は変えない）。

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-integration.test.ts`
Expected: FAIL（`pull is not implemented yet`）

- [ ] **Step 3: runPull を実装する**

`src/cli/sync/commands.ts` のスタブ `runPull` を置き換える:

```ts
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { makeSyncClient, type SyncClient, SyncHttpError } from './client.ts';
import { planPull } from './decisions.ts';
import { titleToFilename } from './filenames.ts';
import { saveState, type SyncState } from './state.ts';
import { titleLc } from '../../core/title.ts';

function openClient(dir: string, deps: SyncDeps): { client: SyncClient; } {
  const config = loadSyncConfig(dir);
  const token = resolveToken(dir, deps.env);
  return { client: makeSyncClient({ baseUrl: config.url, project: config.project, token, fetchFn: deps.fetchFn }) };
}

// 衝突しないファイル名を決める: 既定はタイトル由来。実 FS / state 上で
// 別ページが同名を使っていた場合のみ ~2, ~3 … を付ける
function chooseFilename(dir: string, state: SyncState, pageId: string, title: string): string {
  const base = titleToFilename(title);
  const stem = base.slice(0, -4);
  const taken = new Set(
    Object.entries(state.pages).filter(([id]) => id !== pageId).map(([, st]) => st.filename),
  );
  for (let i = 1; ; i += 1) {
    const candidate = i === 1 ? base : `${stem}~${i}.txt`;
    const fsCollision = existsSync(join(dir, candidate)) && state.pages[pageId]?.filename !== candidate;
    if (!taken.has(candidate) && !(fsCollision && i === 1 && state.pages[pageId] === undefined)) {
      if (!taken.has(candidate)) return candidate;
    }
    if (i > 100) throw new CliError(`cannot allocate filename for: ${title}`);
  }
}

async function runPull(values: Record<string, unknown>, deps: SyncDeps): Promise<SyncResult> {
  const dir = (values.dir as string | undefined) ?? '.';
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const local = readLocalFiles(dir);
  let remote;
  try {
    remote = await client.listPages();
  } catch (e) {
    if (e instanceof SyncHttpError) return { exitCode: 2, output: e.message };
    throw e;
  }
  const remoteById = new Map(remote.map((p) => [p.id, p]));
  const localHashes = new Map([...local].map(([name, f]) => [name, f.contentHash]));
  const report: string[] = [];
  let dirty = false;

  for (const action of planPull({ state, remote, localHashes })) {
    if (action.kind === 'delete-local') {
      const st = state.pages[action.pageId]!;
      rmSync(join(dir, st.filename), { force: true });
      delete state.pages[action.pageId];
      saveState(dir, state);
      report.push(`deleted: ${st.filename}`);
      continue;
    }
    if (action.kind === 'keep-deleted') {
      report.push(`kept (deleted on remote, locally modified): ${state.pages[action.pageId]!.filename}`);
      dirty = true;
      continue;
    }
    // write / conflict は詳細を取得し、id の一致を必ず検証する
    // （削除済みページのタイトルは再利用されうるため、タイトル解決が別ページを返す危険がある）
    const summary = remoteById.get(action.pageId)!;
    let detail;
    try {
      detail = await client.getPage(action.title);
    } catch (e) {
      if (e instanceof SyncHttpError) { report.push(`skipped (fetch failed): ${action.title}`); dirty = true; continue; }
      throw e;
    }
    if (detail === null || detail.id !== summary.id) {
      report.push(`skipped (page moved during pull): ${action.title}`);
      dirty = true;
      continue;
    }
    if (action.kind === 'conflict') {
      const cdir = join(dir, '.knot', 'conflicts', action.pageId);
      mkdirSync(cdir, { recursive: true });
      writeFileSync(join(cdir, 'remote.txt'), `${detail.text}\n`);
      report.push(`conflict: ${state.pages[action.pageId]!.filename} (remote copy in .knot/conflicts/${action.pageId}/)`);
      dirty = true;
      continue;
    }
    // write: リネームなら旧ファイルを消す
    const prev = state.pages[action.pageId];
    const filename = prev !== undefined && titleLc(prev.title) === titleLc(detail.title)
      ? prev.filename
      : chooseFilename(dir, state, action.pageId, detail.title);
    if (prev !== undefined && prev.filename !== filename) rmSync(join(dir, prev.filename), { force: true });
    writeFileSync(join(dir, filename), `${detail.text}\n`);
    state.pages[action.pageId] = {
      title: detail.title, filename, version: detail.version, contentHash: contentHash(detail.text),
    };
    saveState(dir, state);
    report.push(`pulled: ${filename}`);
  }
  return { exitCode: dirty ? 1 : 0, output: report.length === 0 ? 'up to date' : report.join('\n') };
}
```

同じファイルの `remoteStatusLines` スタブも実装する:

```ts
async function remoteStatusLines(dir: string, deps: SyncDeps): Promise<string[]> {
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const remote = await client.listPages();
  const lines: string[] = [];
  for (const p of remote) {
    const st = state.pages[p.id];
    if (st === undefined) lines.push(`remote-new:     ${p.title}`);
    else if (p.version !== st.version || p.title !== st.title) lines.push(`remote-changed: ${p.title}`);
  }
  const remoteIds = new Set(remote.map((p) => p.id));
  for (const [pageId, st] of Object.entries(state.pages)) {
    if (!remoteIds.has(pageId)) lines.push(`remote-deleted: ${st.filename}`);
    void pageId;
  }
  return lines;
}
```

実装時の注意: `chooseFilename` のループは「state 上の他ページが使っていない最初の候補」を返すのが仕様。上のドラフトを整理してよいが、(1) 既定はタイトル由来名、(2) 他ページと衝突したときのみ `~2` 以降、(3) 100 回で諦めて CliError、の 3 点は変えない。

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-integration.test.ts test/cli/sync-commands.test.ts`
Expected: PASS（pull 統合 5 本 + Task 8 の 4 本）

- [ ] **Step 5: 型検査と全体回帰**

Run: `direnv exec . npx tsc --noEmit && direnv exec . npm test`
Expected: エラーなし・全テスト PASS

- [ ] **Step 6: コミット**

```bash
git add src/cli/sync/commands.ts test/cli/sync-integration.test.ts
git commit -m "feat(sync): pull（id 検証・リネーム追跡・競合隔離・接尾辞回避）と status --remote"
```

---

### Task 10: sync push の実装（409・--force・応答喪失・新規作成）

**Files:**
- Modify: `src/cli/sync/commands.ts`（runPush を実装）
- Test: `test/cli/sync-integration.test.ts`（追記）

**Interfaces:**
- Consumes: Task 5 の SyncClient、Task 7 の planPush
- Produces: `knot sync push` の完全な挙動。

- [ ] **Step 1: push の統合テストを追記する**

`test/cli/sync-integration.test.ts` に追記:

```ts
test('push: ローカル編集を送信し version と hash を state に反映する', async () => {
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

test('push: 新規ファイルはページを作成し pageId を state に記録する', async () => {
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

test('push: 409 は該当ページだけスキップし exitCode 1、--force で上書きできる', async () => {
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

test('push: 1 行目を書き換えたファイル（リネーム企図）は送信しない', async () => {
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
```

- [ ] **Step 2: 失敗を確認する**

Run: `direnv exec . node --test test/cli/sync-integration.test.ts`
Expected: FAIL（`push is not implemented yet`）

- [ ] **Step 3: runPush を実装する**

`src/cli/sync/commands.ts` のスタブ `runPush` を置き換える:

```ts
import { planPush } from './decisions.ts';

async function runPush(values: Record<string, unknown>, deps: SyncDeps): Promise<SyncResult> {
  const dir = (values.dir as string | undefined) ?? '.';
  const force = values.force === true;
  const { client } = openClient(dir, deps);
  const state = loadState(dir);
  const local = readLocalFiles(dir);
  let remote;
  try {
    remote = await client.listPages();
  } catch (e) {
    if (e instanceof SyncHttpError) return { exitCode: 2, output: e.message };
    throw e;
  }
  const remoteTitleLcs = new Set(remote.map((p) => titleLc(p.title)));
  const report: string[] = [];
  let dirty = false;

  // 結果不明の PUT を再送すると二重コミットになるため、詳細を取り直して本文一致で成功判定する
  const confirmByRefetch = async (title: string, pageId: string | null, canonical: string): Promise<boolean> => {
    try {
      const detail = await client.getPage(title);
      if (detail === null || (pageId !== null && detail.id !== pageId)) return false;
      if (detail.text !== canonical) return false;
      const filename = [...local.keys()].find((n) => local.get(n)!.canonical === canonical);
      if (filename === undefined) return false;
      state.pages[detail.id] = { title: detail.title, filename, version: detail.version, contentHash: contentHash(canonical) };
      saveState(dir, state);
      return true;
    } catch {
      return false;
    }
  };

  for (const action of planPush({
    state,
    localFiles: new Map([...local].map(([n, f]) => [n, { firstLine: f.firstLine, contentHash: f.contentHash }])),
    remoteTitleLcs,
  })) {
    if (action.kind === 'skip-rename') {
      report.push(`skipped (rename not supported; restore first line to "${action.stateTitle}"): ${action.filename}`);
      dirty = true;
      continue;
    }
    if (action.kind === 'skip-title-mismatch') {
      report.push(`skipped (first line "${action.fileTitle}" does not match filename): ${action.filename}`);
      dirty = true;
      continue;
    }
    if (action.kind === 'skip-duplicate') {
      report.push(`skipped (title already exists; run knot sync pull first): ${action.filename}`);
      dirty = true;
      continue;
    }
    const file = local.get(action.filename)!;
    const title = action.kind === 'update' ? action.title : action.title;
    const baseVersion = action.kind === 'update' ? action.baseVersion : 0;
    const pageId = action.kind === 'update' ? action.pageId : null;
    let result;
    try {
      result = await client.putText(title, baseVersion, file.canonical);
    } catch (e) {
      if (e instanceof SyncHttpError && e.status === 401) return { exitCode: 2, output: e.message };
      // 通信断など結果不明: 再送せず本文一致で確認する
      const confirmed = await confirmByRefetch(title, pageId, file.canonical);
      report.push(confirmed ? `pushed (confirmed after error): ${action.filename}` : `failed: ${action.filename}`);
      if (!confirmed) dirty = true;
      continue;
    }
    if (result.kind === 'conflict' && force && pageId !== null) {
      // force-with-lease: 最新 version を取り直して 1 回だけ再試行する
      const detail = await client.getPage(title);
      if (detail !== null && detail.id === pageId) {
        result = await client.putText(title, detail.version, file.canonical);
      }
    }
    if (result.kind === 'conflict') {
      report.push(`conflict (pull and merge, or push --force): ${action.filename}`);
      dirty = true;
      continue;
    }
    if (pageId !== null) {
      state.pages[pageId] = { title, filename: action.filename, version: result.version, contentHash: file.contentHash };
      saveState(dir, state);
    } else {
      // 新規作成: PUT 応答は pageId を返さないため、詳細を取り直して記録する
      const detail = await client.getPage(title);
      if (detail !== null) {
        state.pages[detail.id] = { title: detail.title, filename: action.filename, version: detail.version, contentHash: contentHash(detail.text) };
        saveState(dir, state);
      }
    }
    report.push(`pushed: ${action.filename}`);
  }
  return { exitCode: dirty ? 1 : 0, output: report.length === 0 ? 'up to date' : report.join('\n') };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `direnv exec . node --test test/cli/sync-integration.test.ts`
Expected: PASS（pull 5 本 + push 4 本）

- [ ] **Step 5: 型検査と lint**

Run: `direnv exec . npx tsc --noEmit && direnv exec . npm run lint`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/cli/sync/commands.ts test/cli/sync-integration.test.ts
git commit -m "feat(sync): push（新規作成・409 スキップ続行・force-with-lease・応答喪失の確認再取得）"
```

---

### Task 11: 異常系の統合テスト

**Files:**
- Test: `test/cli/sync-integration.test.ts`（追記のみ。実装の修正が必要ならバグとして直す）

**Interfaces:**
- Consumes: Task 9・10 の実装
- Produces: スペック「テスト戦略」の異常系カバレッジ。

- [ ] **Step 1: 異常系テストを追記する**

```ts
test('pull: 一覧と詳細の間で別ページに差し替わった場合はスキップする（id 不一致）', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['body'], env.clock.t);
    // 一覧応答だけ挿し替える fetch ラッパで、詳細取得時に id が変わった状況を作る
    const state0 = { fetched: false };
    const patched: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (String(url).includes('sort=title') && !state0.fetched) {
        state0.fetched = true;
        const body = await res.json() as { pages: Array<{ id: string }> } & Record<string, unknown>;
        body.pages = body.pages.map((p) => ({ ...p, id: 'DIFFERENT_ID' }));
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return res;
    };
    const result = await runSync(['pull', '--dir', env.dir], { fetchFn: patched });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /skipped/);
    assert.ok(!existsSync(join(env.dir, 'Alpha.txt'))); // 書かない
    assert.deepEqual(loadState(env.dir).pages, {}); // state も不変
  } finally { env.close(); }
});

test('push: PUT の応答が失われても再送せず、確認再取得で state が揃う', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'Alpha', ['v1 body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    writeFileSync(join(env.dir, 'Alpha.txt'), 'Alpha\nedited\n');
    // PUT はサーバに届くが応答が失われる状況を再現する
    const patched: typeof fetch = async (url, init) => {
      const res = await fetch(url, init);
      if (init?.method === 'PUT') throw new TypeError('network error after send');
      return res;
    };
    const result = await runSync(['push', '--dir', env.dir], { fetchFn: patched });
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /confirmed after error/);
    const pageId = Object.keys(loadState(env.dir).pages)[0]!;
    assert.equal(loadState(env.dir).pages[pageId]!.contentHash !== undefined, true);
    const page = await env.storage.getPageById(pageId);
    assert.deepEqual(page!.lines.map((l) => l.text), ['Alpha', 'edited']);
    assert.equal(loadState(env.dir).pages[pageId]!.version, page!.version);
  } finally { env.close(); }
});

test('pull → push: CRLF で保存されたファイルも差分なしなら no-op', async () => {
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

test('pull: 特殊文字タイトルのファイル名エスケープと round-trip push', async () => {
  const env = await makeEnv();
  try {
    await seedPage(env.storage, env.projectId, 'a/b: c', ['body'], env.clock.t);
    await runSync(['pull', '--dir', env.dir]);
    const filename = 'a%2Fb%3A c.txt';
    assert.equal(readFileSync(join(env.dir, filename), 'utf8'), 'a/b: c\nbody\n');
    writeFileSync(join(env.dir, filename), 'a/b: c\nedited\n');
    const result = await runSync(['push', '--dir', env.dir]);
    assert.equal(result.exitCode, 0);
  } finally { env.close(); }
});

test('status --remote: リモート側の new / changed / deleted を表示する', async () => {
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
```

- [ ] **Step 2: 実行して通す**

Run: `direnv exec . node --test test/cli/sync-integration.test.ts`
Expected: PASS。失敗した場合は実装のバグなので superpowers:systematic-debugging で原因を特定して修正する（テストの期待値はスペック由来。テスト側を弱めない）。

- [ ] **Step 3: 全体回帰**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit && direnv exec . npm run lint`
Expected: 全て PASS / エラーなし

- [ ] **Step 4: コミット**

```bash
git add test/cli/sync-integration.test.ts src/cli/sync
git commit -m "test(sync): 異常系（id 不一致・応答喪失・CRLF・特殊文字タイトル・status --remote）"
```

---

### Task 12: ドキュメントと最終回帰

**Files:**
- Modify: `README.md`
- Modify: `docs/ops.md`

**Interfaces:**
- Consumes: Task 1〜11 の完成した挙動
- Produces: 利用者向けドキュメント。

- [ ] **Step 1: README に「外部エディタ同期」節を追加する**

`README.md` の「運用ガイド」リンクの前に追記:

```markdown
## 外部エディタ同期（knot sync）

ページを「1 ページ = 1 テキストファイル」でローカルに書き出し、Emacs や Vim で編集して手動 pull / push で同期できる。

```sh
# API トークンを作る（サーバ側）
knot token add --data ./data --user ril --label sync

# 同期ディレクトリを作って初回 pull（クライアント側）
knot sync init ./wiki --url http://127.0.0.1:3000 --project notes
export KNOT_TOKEN=knot_...   # または ./wiki/.knot/token に保存して chmod 600
cd wiki && knot sync pull

# 編集して push。リモートが先に進んでいたページはスキップされるので pull してから再 push
knot sync push
knot sync status --remote
```

- 削除・リネームは push されない。wiki の UI で行い、pull で反映する（ローカルでファイルを消しても次回 pull で復元される）。
- 競合したページは `.knot/conflicts/<pageId>/remote.txt` にリモート本文が置かれる。手でマージして push するか、`knot sync push --force` でローカル内容を優先する。
- このテキスト形式は行メタデータ（行ごとの作成者・時刻）を持たないベストエフォートの経路。完全なバックアップは `knot export` / `knot backup` を使う。
- 同期ディレクトリは git 管理できる（`.knot/` は gitignore すること）。
```

- [ ] **Step 2: docs/ops.md に持ち出し経路の節を追加する**

`docs/ops.md` のバックアップの節の後に追記:

```markdown
## git 管理と組み合わせた持ち出し（knot sync）

`knot sync` の同期ディレクトリをそのまま git リポジトリにすると、「clone して knot sync push で復元」というファイルベースの持ち出し経路になる。

- `.knot/`（トークン・同期 state・競合コピー）は必ず gitignore する。
- この経路はテキストのみを運ぶ。行メタデータと添付ファイルは含まれないため、災害復旧の正本は `knot backup` と定期エクスポート（`autoExportDir`）に置く。
- 別サーバへの復元は「新サーバで `knot sync init` → 既存ファイルを置いて `knot sync push`」で行える（全ページが新規作成される）。
```

- [ ] **Step 3: 最終回帰**

Run: `direnv exec . npm test && direnv exec . npx tsc --noEmit && direnv exec . npm run lint`
Expected: 全て PASS / エラーなし

- [ ] **Step 4: コミット**

```bash
git add README.md docs/ops.md
git commit -m "docs(sync): 外部エディタ同期の使い方と git 持ち出し経路"
```

---

## Self-Review メモ（計画作成時に実施済み）

- スペック全節とタスクの対応: コマンド構成=8、認証=4/5、レイアウト・ファイル名=2/9、正準形=3、state=4、pull=6/9、push=7/10、サーバ変更=1、CLI 配置=8、エラー処理=8〜10、テスト戦略=2〜11、docs=12。
- スペックの「リダイレクトで認証ヘッダを転送しない」は client.ts の `redirect: 'error'` で対応（Task 5）。
- 統合テストの storage ヘルパ（`getPageById` / `deletePage` / `seedPage`)のシグネチャは実装時に必ず実物を確認すること（Task 9 Step 1 の注意書き）。
