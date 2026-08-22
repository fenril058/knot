import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignLines, diffLines } from '../../src/core/diff.ts';
import { applyOps } from '../../src/core/apply.ts';
import { type Line } from '../../src/core/ops.ts';

const mk = (...texts: string[]): Line[] =>
  texts.map((text, i) => ({ id: `L${i}`, text, created: 1, updated: 1, updatedVersion: 1, userId: 'u' }));
const idgen = () => {
  let n = 0;
  return () => `N${n++}`;
};
const texts = (lines: Line[]) => lines.map((l) => l.text);
const ctx = { userId: 'u2', now: 9, version: 2 };

void test('alignLines: 純追加は既存行を保って新規行を加える', () => {
  const old = mk('a', 'b');
  assert.deepEqual(alignLines(old, ['a', 'b', 'c']), [
    { kind: 'keep', line: old[0] },
    { kind: 'keep', line: old[1] },
    { kind: 'add', text: 'c' },
  ]);
});

void test('alignLines: 純削除は残存行と削除行を対応付ける', () => {
  const old = mk('a', 'b', 'c');
  assert.deepEqual(alignLines(old, ['a', 'c']), [
    { kind: 'keep', line: old[0] },
    { kind: 'del', line: old[1] },
    { kind: 'keep', line: old[2] },
  ]);
});

void test('alignLines: 編集と追加が混在しても最小編集かつ keep 優先で対応付ける', () => {
  const old = mk('remove', 'keep', 'tail');
  assert.deepEqual(alignLines(old, ['keep', 'changed', 'added', 'tail']), [
    { kind: 'del', line: old[0] },
    { kind: 'keep', line: old[1] },
    { kind: 'add', text: 'changed' },
    { kind: 'add', text: 'added' },
    { kind: 'keep', line: old[2] },
  ]);
});

void test('同文行への更新は位置を保ち、削除と追加は一致行を保つ', () => {
  assert.deepEqual(diffLines(mk('local', 'same'), ['same', 'same'], idgen()), [
    { type: 'update', id: 'L0', text: 'same' },
  ]);
  assert.deepEqual(diffLines(mk('local', 'keep'), ['keep', 'new'], idgen()), [
    { type: 'delete', id: 'L0' },
    { type: 'insert', id: 'N0', after: 'L1', text: 'new' },
  ]);
});

void test('変更なしなら空の ops', () => {
  assert.deepEqual(diffLines(mk('a', 'b'), ['a', 'b'], idgen()), []);
});

void test('1 行の編集は update になり行 ID を保つ', () => {
  const ops = diffLines(mk('title', 'body'), ['title', 'body!'], idgen());
  assert.deepEqual(ops, [{ type: 'update', id: 'L1', text: 'body!' }]);
});

void test('長い文書の局所編集は共通部分を比較表から除外する', () => {
  const before = Array.from({ length: 10_000 }, (_, index) => `line ${index}`);
  const after = [...before];
  after[5_000] = 'changed';
  assert.deepEqual(diffLines(mk(...before), after, idgen()), [
    { type: 'update', id: 'L5000', text: 'changed' },
  ]);
});

void test('挿入と削除', () => {
  const old = mk('a', 'b', 'c');
  assert.deepEqual(diffLines(old, ['a', 'x', 'b', 'c'], idgen()),
    [{ type: 'insert', id: 'N0', after: 'L0', text: 'x' }]);
  assert.deepEqual(diffLines(old, ['a', 'c'], idgen()),
    [{ type: 'delete', id: 'L1' }]);
});

void test('2 行を 3 行に置換すると update 2 + insert 1', () => {
  const ops = diffLines(mk('a', 'x', 'y', 'd'), ['a', 'p', 'q', 'r', 'd'], idgen());
  assert.deepEqual(ops, [
    { type: 'update', id: 'L1', text: 'p' },
    { type: 'update', id: 'L2', text: 'q' },
    { type: 'insert', id: 'N0', after: 'L2', text: 'r' },
  ]);
});

void test('空からの作成は入力順の insert 連鎖', () => {
  const ops = diffLines([], ['t', '1', '2'], idgen());
  assert.deepEqual(ops.map((o) => o.type), ['insert', 'insert', 'insert']);
});

void test('検算: apply(old, diff(old, new)) のテキストが new に一致する', () => {
  const cases: [string[], string[]][] = [
    [['a', 'b', 'c'], ['c', 'a', 'b']],
    [['a', 'b'], ['x', 'y', 'z']],
    [['a'], []],
    [[], ['only']],
    [['a', 'b', 'c', 'd'], ['a', 'B', 'c2', 'c3', 'd']],
  ];
  for (const [before, after] of cases) {
    const old = mk(...before);
    const ops = diffLines(old, after, idgen());
    const applied = ops.length === 0 ? old : applyOps(old, ops, ctx);
    assert.deepEqual(texts(applied), after);
  }
});
