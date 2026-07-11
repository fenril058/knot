import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../../src/core/apply.ts';
import { type Line, type LineOp } from '../../src/core/ops.ts';
import { lcg } from '../helpers/rand.ts';

const line = (id: string, text = 'x'): Line =>
  ({ id, text, created: 1, updated: 1, updatedVersion: 1, userId: 'u1' });
const ctx = { userId: 'u2', now: 100, version: 5 };

test('_head への insert は先頭に入る', () => {
  const out = applyOps([line('a')], [{ type: 'insert', id: 'b', after: '_head', text: 'new' }], ctx);
  assert.deepEqual(out.map((l) => l.id), ['b', 'a']);
  assert.equal(out[0].created, 100);
  assert.equal(out[0].updatedVersion, 5);
  assert.equal(out[0].userId, 'u2');
});

test('連続 insert はアンカー連鎖で入力順を保つ', () => {
  const out = applyOps([line('a')], [
    { type: 'insert', id: 'b', after: 'a', text: '1' },
    { type: 'insert', id: 'c', after: 'b', text: '2' },
    { type: 'insert', id: 'd', after: 'c', text: '3' },
  ], ctx);
  assert.deepEqual(out.map((l) => l.text), ['x', '1', '2', '3']);
});

test('同じアンカーへの後発 insert はアンカー直後に入る（並行挿入の期待順序）', () => {
  const first = applyOps([line('a')], [{ type: 'insert', id: 'b', after: 'a', text: 'コミット1' }],
    { ...ctx, version: 2 });
  const second = applyOps(first, [{ type: 'insert', id: 'c', after: 'a', text: 'コミット2' }],
    { ...ctx, version: 3 });
  assert.deepEqual(second.map((l) => l.text), ['x', 'コミット2', 'コミット1']);
});

test('update はメタデータを進め、created を保つ', () => {
  const out = applyOps([line('a')], [{ type: 'update', id: 'a', text: 'edited' }], ctx);
  assert.equal(out[0].text, 'edited');
  assert.equal(out[0].created, 1);
  assert.equal(out[0].updated, 100);
  assert.equal(out[0].updatedVersion, 5);
  assert.equal(out[0].userId, 'u2');
});

test('入力配列を破壊しない', () => {
  const src = [line('a')];
  applyOps(src, [{ type: 'update', id: 'a', text: 'edited' }], ctx);
  assert.equal(src[0].text, 'x');
});

test('決定性: 同じ ops 列は常に同じ結果になる', () => {
  const rnd = lcg(7);
  let lines: Line[] = [line('L0', 'base')];
  const opsLog: LineOp[][] = [];
  for (let v = 2; v < 60; v++) {
    const ops: LineOp[] = [];
    const kind = rnd();
    if (kind < 0.5 || lines.length === 0) {
      const after = lines.length === 0 ? '_head' : lines[Math.floor(rnd() * lines.length)].id;
      ops.push({ type: 'insert', id: `L${v}`, after, text: `t${v}` });
    } else if (kind < 0.8) {
      ops.push({ type: 'update', id: lines[Math.floor(rnd() * lines.length)].id, text: `e${v}` });
    } else {
      ops.push({ type: 'delete', id: lines[Math.floor(rnd() * lines.length)].id });
    }
    opsLog.push(ops);
    lines = applyOps(lines, ops, { userId: 'u', now: v, version: v });
  }
  let replay: Line[] = [line('L0', 'base')];
  let v = 2;
  for (const ops of opsLog) {
    replay = applyOps(replay, ops, { userId: 'u', now: v, version: v });
    v++;
  }
  assert.deepEqual(replay, lines);
});
