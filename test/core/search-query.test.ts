import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchQuery } from '../../src/core/searchQuery.ts';

void test('空白区切り、除外、引用フレーズを Cosense 互換で解析する', () => {
  assert.deepEqual(parseSearchQuery('alpha  beta -gamma -"delta epsilon"'), {
    words: ['alpha', 'beta'],
    excludes: ['gamma', 'delta epsilon'],
  });
});

void test('閉じていない引用符は末尾までをフレーズとして扱う', () => {
  assert.deepEqual(parseSearchQuery('alpha "beta gamma'), {
    words: ['alpha', 'beta gamma'],
    excludes: [],
  });
});

void test('除外語だけなら先頭の - を含む通常語として扱う', () => {
  assert.deepEqual(parseSearchQuery('-alpha'), { words: ['-alpha'], excludes: [] });
});
