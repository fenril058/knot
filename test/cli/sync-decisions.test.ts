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
