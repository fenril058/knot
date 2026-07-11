import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOps, OpsError, type Line } from '../../src/core/ops.ts';

const line = (id: string, text = 'x'): Line =>
  ({ id, text, created: 1, updated: 1, updatedVersion: 1, userId: 'u1' });

test('空の ops は OpsError', () => {
  assert.throws(() => validateOps([line('a')], []), OpsError);
});

test('既存 ID と重複する insert は OpsError', () => {
  assert.throws(
    () => validateOps([line('a')], [{ type: 'insert', id: 'a', after: '_head', text: 't' }]),
    OpsError,
  );
});

test('存在しない行への update / delete は OpsError', () => {
  assert.throws(() => validateOps([line('a')], [{ type: 'update', id: 'zz', text: 't' }]), OpsError);
  assert.throws(() => validateOps([line('a')], [{ type: 'delete', id: 'zz' }]), OpsError);
});

test('同一コミット内で削除済みの行をアンカーにする insert は OpsError', () => {
  assert.throws(
    () =>
      validateOps([line('a'), line('b')], [
        { type: 'delete', id: 'b' },
        { type: 'insert', id: 'c', after: 'b', text: 't' },
      ]),
    OpsError,
  );
});

test('正しい ops 列は例外を投げない', () => {
  validateOps([line('a')], [
    { type: 'insert', id: 'b', after: 'a', text: 't' },
    { type: 'insert', id: 'c', after: 'b', text: 't2' },
    { type: 'update', id: 'a', text: 'edited' },
    { type: 'delete', id: 'b' },
  ]);
});
