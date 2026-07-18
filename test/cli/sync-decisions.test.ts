import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPull, planPush } from '../../src/cli/sync/decisions.ts';
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
