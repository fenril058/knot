import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../../src/core/apply.ts';
import { duplicateOps } from '../../src/client/pageMenu/ops.ts';

const ctx = { userId: 'user', now: 1, version: 1 };

test('duplicateOps: タイトルを差し替え、本文を元の順序で複製する', () => {
  let nextId = 0;
  const ops = duplicateOps(
    [{ text: 'Old title' }, { text: 'first' }, { text: 'second' }],
    'New title',
    () => `new-${nextId++}`,
  );

  const lines = applyOps([], ops, ctx);

  assert.deepEqual(lines.map((line) => line.text), ['New title', 'first', 'second']);
  assert.equal(ops[0]?.type, 'insert');
  assert.equal(ops[0]?.type === 'insert' ? ops[0].after : undefined, '_head');
});

test('duplicateOps: タイトルだけのページを複製する', () => {
  const ops = duplicateOps([{ text: 'Old title' }], 'New title', () => 'new-title');

  const lines = applyOps([], ops, ctx);

  assert.deepEqual(lines.map((line) => line.text), ['New title']);
});

test('duplicateOps: 全 insert id は makeId が生成した一意な値を使う', () => {
  const generated = ['id-a', 'id-b', 'id-c'];
  let index = 0;

  const ops = duplicateOps(
    [{ text: 'Old title' }, { text: 'first' }, { text: 'second' }],
    'New title',
    () => generated[index++]!,
  );
  const ids = ops.map((op) => op.type === 'insert' ? op.id : '');

  assert.deepEqual(ids, generated);
  assert.equal(new Set(ids).size, ids.length);
});
