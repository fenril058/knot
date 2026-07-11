import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ulid } from '../../src/core/id.ts';

test('26 文字の Crockford Base32 を返す', () => {
  const id = ulid();
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('時刻部分が単調で、時刻順に文字列比較できる', () => {
  const a = ulid(1_000_000);
  const b = ulid(2_000_000);
  assert.ok(a < b);
});

test('同時刻でも衝突しない', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(ulid(42));
  assert.equal(seen.size, 1000);
});
