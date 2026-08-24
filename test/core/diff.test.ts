import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { alignLines, diffLines } from '../../src/core/diff.ts';
import { applyOps } from '../../src/core/apply.ts';
import { type Line, type LineOp } from '../../src/core/ops.ts';

const mk = (...texts: string[]): Line[] =>
  texts.map((text, i) => ({ id: `L${i}`, text, created: 1, updated: 1, updatedVersion: 1, userId: 'u' }));
const idgen = () => {
  let n = 0;
  return () => `N${n++}`;
};
const texts = (lines: Line[]) => lines.map((l) => l.text);
const ctx = { userId: 'u2', now: 9, version: 2 };

const referenceAlignLines = (oldLines: Line[], newTexts: string[]) => {
  const n = oldLines.length;
  const m = newTexts.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const nextRow = lcs[i + 1]!;
    const oldText = oldLines[i]!.text;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = oldText === newTexts[j]
        ? nextRow[j + 1]! + 1
        : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }
  const steps: ReturnType<typeof alignLines> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i]!.text === newTexts[j]) {
      steps.push({ kind: 'keep', line: oldLines[i]! });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      steps.push({ kind: 'add', text: newTexts[j]! });
      j++;
    } else {
      steps.push({ kind: 'del', line: oldLines[i]! });
      i++;
    }
  }
  return steps;
};

const referenceDiffLines = (oldLines: Line[], newTexts: string[], makeId: () => string): LineOp[] => {
  const steps = referenceAlignLines(oldLines, newTexts);
  const ops: LineOp[] = [];
  let anchor = '_head';
  let k = 0;
  while (k < steps.length) {
    const step = steps[k]!;
    if (step.kind === 'keep') {
      anchor = step.line.id;
      k++;
      continue;
    }
    const dels: Line[] = [];
    const adds: string[] = [];
    while (k < steps.length && steps[k]!.kind !== 'keep') {
      const groupStep = steps[k++]!;
      if (groupStep.kind === 'del') dels.push(groupStep.line);
      else if (groupStep.kind === 'add') adds.push(groupStep.text);
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) ops.push({ type: 'update', id: dels[p]!.id, text: adds[p]! });
    for (let p = pairs; p < dels.length; p++) ops.push({ type: 'delete', id: dels[p]!.id });
    let insertAfter = pairs > 0 ? dels[pairs - 1]!.id : anchor;
    for (let p = pairs; p < adds.length; p++) {
      const id = makeId();
      ops.push({ type: 'insert', id, after: insertAfter, text: adds[p]! });
      insertAfter = id;
    }
  }
  return ops;
};

const sequences = (alphabet: string[], maxLength: number): string[][] => {
  const result: string[][] = [[]];
  for (let length = 1; length <= maxLength; length++) {
    const previous = result.filter((sequence) => sequence.length === length - 1);
    for (const sequence of previous) {
      for (const value of alphabet) result.push([...sequence, value]);
    }
  }
  return result;
};

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

void test('alignLines: 編集と追加が混在しても LCS に沿って対応付ける', () => {
  const old = mk('remove', 'keep', 'tail');
  assert.deepEqual(alignLines(old, ['keep', 'changed', 'added', 'tail']), [
    { kind: 'del', line: old[0] },
    { kind: 'keep', line: old[1] },
    { kind: 'add', text: 'changed' },
    { kind: 'add', text: 'added' },
    { kind: 'keep', line: old[2] },
  ]);
});

void test('alignLines: 重複行が作る LCS の tie では add 側を選ぶ', () => {
  const old = mk('a', 'a');
  assert.deepEqual(alignLines(old, ['b', 'a']), [
    { kind: 'add', text: 'b' },
    { kind: 'keep', line: old[0] },
    { kind: 'del', line: old[1] },
  ]);
});

void test('alignLines: 共通 suffix と同文の行が中央にあれば先の同文行を保つ', () => {
  const old = mk('a');
  assert.deepEqual(alignLines(old, ['b', 'a', 'a']), [
    { kind: 'add', text: 'b' },
    { kind: 'keep', line: old[0] },
    { kind: 'add', text: 'a' },
  ]);
});

void test('alignLines: 長さ 0〜4 の全組合せで従来の LCS と一致する', () => {
  const inputs = sequences(['a', 'b', 'c'], 4);
  for (const oldTexts of inputs) {
    for (const newTexts of inputs) {
      const old = mk(...oldTexts);
      assert.deepEqual(alignLines(old, newTexts), referenceAlignLines(old, newTexts),
        `old=${JSON.stringify(oldTexts)}, new=${JSON.stringify(newTexts)}`);
    }
  }
});

void test('diffLines: 長さ 0〜4 の全組合せで従来の LineOp と一致する', () => {
  const inputs = sequences(['a', 'b', 'c'], 4);
  for (const oldTexts of inputs) {
    for (const newTexts of inputs) {
      const old = mk(...oldTexts);
      assert.deepEqual(diffLines(old, newTexts, idgen()), referenceDiffLines(old, newTexts, idgen()),
        `old=${JSON.stringify(oldTexts)}, new=${JSON.stringify(newTexts)}`);
    }
  }
});

void test('alignLines: 5000 行の中央 1 行変更を 128 MiB のヒープ内で処理する', () => {
  const diffModule = new URL('../../src/core/diff.ts', import.meta.url).href;
  const script = `
    const { alignLines } = await import(process.argv[1]);
    const oldLines = Array.from({ length: 5000 }, (_, i) => ({
      id: 'L' + i,
      text: 'line ' + i,
      created: 1,
      updated: 1,
      updatedVersion: 1,
      userId: 'u',
    }));
    const newTexts = oldLines.map((line) => line.text);
    newTexts[2500] = 'changed';
    const steps = alignLines(oldLines, newTexts);
    if (steps.length !== 5001) process.exitCode = 1;
  `;
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=128',
    '--input-type=module',
    '--eval',
    script,
    diffModule,
  ], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
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

void test('離れた位置へ残る未変更行は ID とメタデータを保つ', () => {
  const old = mk('keep', 'D1', 'D2', 'D3', 'D4', 'D5');
  old[0] = { ...old[0]!, updated: 7, updatedVersion: 8, userId: 'keeper' };
  const after = ['N1', 'N2', 'N3', 'N4', 'N5', 'keep'];
  const ops = diffLines(old, after, idgen());
  const applied = applyOps(old, ops, ctx);

  assert.deepEqual(applied[5], old[0]);
});

void test('変更なしなら空の ops', () => {
  assert.deepEqual(diffLines(mk('a', 'b'), ['a', 'b'], idgen()), []);
});

void test('1 行の編集は update になり行 ID を保つ', () => {
  const ops = diffLines(mk('title', 'body'), ['title', 'body!'], idgen());
  assert.deepEqual(ops, [{ type: 'update', id: 'L1', text: 'body!' }]);
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
