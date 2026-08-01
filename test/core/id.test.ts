import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ulid } from '../../src/core/id.ts';

void test('ブラウザ非互換の node:crypto import を含まない', () => {
  const source = readFileSync(new URL('../../src/core/id.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:crypto/);
});

void test('26 文字の Crockford Base32 を返す', () => {
  const id = ulid();
  assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

void test('時刻部分が単調で、時刻順に文字列比較できる', () => {
  const a = ulid(1_000_000);
  const b = ulid(2_000_000);
  assert.ok(a < b);
});

void test('時刻部分に収まらない now を弾く（黙って壊れた ID を作らない）', () => {
  // 時刻部分は 48 bit。範囲外や非整数を渡すと ALPHABET の添字が外れ、
  // 以前は 'undefined' を連結した ID を返していた。
  for (const bad of [-1, NaN, 1.5, Infinity, -Infinity, 2 ** 48]) {
    assert.throws(() => ulid(bad), RangeError, `ulid(${bad}) は RangeError`);
  }
  assert.match(ulid(2 ** 48 - 1), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(ulid(0), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

void test('同時刻でも衝突しない', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) seen.add(ulid(42));
  assert.equal(seen.size, 1000);
});
