import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebase } from '../../src/core/rebase.ts';
import { type Line } from '../../src/core/ops.ts';

const lines = (...pairs: [string, string][]): Line[] =>
  pairs.map(([id, text]) => ({ id, text, created: 1, updated: 1, updatedVersion: 1, userId: 'u' }));

void test('同一行の異なる更新は競合として返す', () => {
  const base = lines(['title', 'Title'], ['body', 'base']);
  const local = lines(['title', 'Title'], ['body', 'local']);
  const latest = lines(['title', 'Title'], ['body', 'latest']);

  assert.deepEqual(rebase(base, local, latest), {
    kind: 'conflict',
    conflicts: [{
      lineId: 'body',
      base: { kind: 'present', text: 'base' },
      local: { kind: 'present', text: 'local' },
      latest: { kind: 'present', text: 'latest' },
    }],
    candidateOps: [{ type: 'update', id: 'body', text: 'local' }],
  });
});

void test('同一行を同じ内容へ更新した場合は競合にしない', () => {
  const base = lines(['title', 'Title'], ['body', 'base']);
  const local = lines(['title', 'Title'], ['body', 'shared']);
  const latest = lines(['title', 'Title'], ['body', 'shared']);

  assert.deepEqual(rebase(base, local, latest), { kind: 'rebased', ops: [] });
});

void test('サーバ上の最新版の削除と手元の更新は競合として返す', () => {
  const base = lines(['title', 'Title'], ['body', 'base']);
  const local = lines(['title', 'Title'], ['body', 'local']);
  const latest = lines(['title', 'Title']);

  assert.deepEqual(rebase(base, local, latest), {
    kind: 'conflict',
    conflicts: [{
      lineId: 'body',
      base: { kind: 'present', text: 'base' },
      local: { kind: 'present', text: 'local' },
      latest: { kind: 'deleted' },
    }],
    candidateOps: [{ type: 'insert', id: 'body', after: 'title', text: 'local' }],
  });
});

void test('手元の削除とサーバ上の最新版の更新は競合として返す', () => {
  const base = lines(['title', 'Title'], ['body', 'base']);
  const local = lines(['title', 'Title']);
  const latest = lines(['title', 'Title'], ['body', 'latest']);

  assert.deepEqual(rebase(base, local, latest), {
    kind: 'conflict',
    conflicts: [{
      lineId: 'body',
      base: { kind: 'present', text: 'base' },
      local: { kind: 'deleted' },
      latest: { kind: 'present', text: 'latest' },
    }],
    candidateOps: [{ type: 'delete', id: 'body' }],
  });
});

void test('基準にない同じ行 ID の挿入内容が異なる場合も競合として返す', () => {
  const base = lines(['title', 'Title']);
  const local = [...base, ...lines(['same-id', 'local'])];
  const latest = [...base, ...lines(['same-id', 'latest'])];

  assert.deepEqual(rebase(base, local, latest), {
    kind: 'conflict',
    conflicts: [{
      lineId: 'same-id',
      base: { kind: 'deleted' },
      local: { kind: 'present', text: 'local' },
      latest: { kind: 'present', text: 'latest' },
    }],
    candidateOps: [{ type: 'update', id: 'same-id', text: 'local' }],
  });
});

void test('同じ anchor への並行 insert は先に受理された行の後へ置く', () => {
  const base = lines(['title', 'Title'], ['tail', 'tail']);
  const local = lines(['title', 'Title'], ['local', 'local'], ['tail', 'tail']);
  const latest = lines(['title', 'Title'], ['remote', 'remote'], ['tail', 'tail']);

  assert.deepEqual(rebase(base, local, latest), {
    kind: 'rebased',
    ops: [{ type: 'insert', id: 'local', after: 'remote', text: 'local' }],
  });
});

void test('同じ anchor への複数行 insert は各クライアント内の順序を保つ', () => {
  const base = lines(['title', 'Title'], ['tail', 'tail']);
  const local = lines(
    ['title', 'Title'],
    ['local-1', 'local 1'],
    ['local-2', 'local 2'],
    ['tail', 'tail'],
  );
  const latest = lines(
    ['title', 'Title'],
    ['remote-1', 'remote 1'],
    ['remote-2', 'remote 2'],
    ['tail', 'tail'],
  );

  assert.deepEqual(rebase(base, local, latest), {
    kind: 'rebased',
    ops: [
      { type: 'insert', id: 'local-1', after: 'remote-2', text: 'local 1' },
      { type: 'insert', id: 'local-2', after: 'local-1', text: 'local 2' },
    ],
  });
});

void test('サーバで削除された基準行をまたぐ手元の insert 順序を保つ', () => {
  const base = lines(['a', 'a'], ['removed', 'removed'], ['tail', 'tail']);
  const local = lines(
    ['a', 'a'],
    ['local-1', 'local 1'],
    ['removed', 'removed'],
    ['local-2', 'local 2'],
    ['tail', 'tail'],
  );
  const latest = lines(['a', 'a'], ['tail', 'tail']);

  assert.deepEqual(rebase(base, local, latest), {
    kind: 'rebased',
    ops: [
      { type: 'insert', id: 'local-1', after: 'a', text: 'local 1' },
      { type: 'insert', id: 'local-2', after: 'local-1', text: 'local 2' },
    ],
  });
});
