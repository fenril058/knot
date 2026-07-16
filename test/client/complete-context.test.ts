import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionContext } from '../../src/client/editor/completeContext.ts';

test('未閉ブラケット内の query とブラケット直後の tokenFrom を返す', () => {
  assert.deepEqual(completionContext('prefix [foo bar'), {
    kind: 'bracket',
    query: 'foo bar',
    tokenFrom: 8,
  });
});

test('閉じ済みブラケットの後では null を返す', () => {
  assert.equal(completionContext('[foo]'), null);
  assert.equal(completionContext('[foo] suffix'), null);
});

test('行頭の hash トークンの query と hash 直後の tokenFrom を返す', () => {
  assert.deepEqual(completionContext('#foo'), {
    kind: 'hash',
    query: 'foo',
    tokenFrom: 1,
  });
});

test('空白直後の hash トークンの query と hash 直後の tokenFrom を返す', () => {
  assert.deepEqual(completionContext('prefix #foo'), {
    kind: 'hash',
    query: 'foo',
    tokenFrom: 8,
  });
});

test('行中の hash では null を返す', () => {
  assert.equal(completionContext('a#b'), null);
});

