import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSearchQuery, parseSearchQuery } from '../../src/core/searchQuery.ts';

void test('空白区切り、除外、引用フレーズを Cosense 互換で解析する', () => {
  assert.deepEqual(parseSearchQuery('alpha  beta -gamma -"delta epsilon"'), {
    words: ['alpha', 'beta'],
    excludes: ['gamma', 'delta epsilon'],
  });
});

void test('閉じていない引用符は語の境界から取り除く', () => {
  assert.deepEqual(parseSearchQuery('alpha "beta gamma'), {
    words: ['alpha', 'beta', 'gamma'],
    excludes: [],
  });
  assert.deepEqual(parseSearchQuery('alpha -"beta gamma'), {
    words: ['alpha', 'gamma'],
    excludes: ['beta'],
  });
});

void test('除外語だけなら先頭の - を含む通常語として扱う', () => {
  assert.deepEqual(parseSearchQuery('-alpha'), { words: ['-alpha'], excludes: [] });
});

void test('語中の引用符は保持し、閉じた引用フレーズの直後は別の語として扱う', () => {
  assert.deepEqual(parseSearchQuery('alpha"beta'), { words: ['alpha"beta'], excludes: [] });
  assert.deepEqual(parseSearchQuery('"alpha beta"gamma'), {
    words: ['alpha beta', 'gamma'],
    excludes: [],
  });
});

void test('空の引用フレーズを空文字の検索語として保持する', () => {
  assert.deepEqual(parseSearchQuery('alpha ""'), { words: ['alpha', ''], excludes: [] });
});

void test('空または連続する引用符が語に隣接する場合はリテラルとして扱う', () => {
  assert.deepEqual(parseSearchQuery('""alpha'), { words: ['"alpha'], excludes: [] });
  assert.deepEqual(parseSearchQuery('alpha -""beta'), {
    words: ['alpha'],
    excludes: ['"beta'],
  });
  assert.deepEqual(parseSearchQuery('"""'), { words: ['"'], excludes: [] });
  assert.deepEqual(parseSearchQuery('""""'), { words: ['""'], excludes: [] });
});

void test('検索語の検査は、空・長すぎる・語が多すぎるを区別し、それ以外は解析した検索語を返す', () => {
  assert.deepEqual(checkSearchQuery('  '), { ok: false, problem: 'required', message: 'q required' });
  assert.deepEqual(checkSearchQuery('a'.repeat(1_001)), { ok: false, problem: 'too_long', message: 'q too long' });
  assert.equal(checkSearchQuery('a'.repeat(1_000)).ok, true);
  const terms = Array.from({ length: 33 }, (_, index) => `w${index}`).join(' ');
  assert.deepEqual(checkSearchQuery(terms), { ok: false, problem: 'too_many_terms', message: 'too many search terms' });
  assert.deepEqual(checkSearchQuery('alpha -beta'), { ok: true, query: { words: ['alpha'], excludes: ['beta'] } });
});
