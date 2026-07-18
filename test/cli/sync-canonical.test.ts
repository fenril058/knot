import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeText, contentHash } from '../../src/cli/sync/canonical.ts';

test('CRLF を LF に正規化する', () => {
  assert.equal(canonicalizeText('Title\r\nbody\r\n'), 'Title\nbody');
});

test('末尾の LF をちょうど 1 つ取り除く', () => {
  assert.equal(canonicalizeText('Title\nbody\n'), 'Title\nbody');
  assert.equal(canonicalizeText('Title\nbody'), 'Title\nbody');
  // 末尾空行はページ本文の一部として保持される（LF 2 つ → 1 つ残る）
  assert.equal(canonicalizeText('Title\nbody\n\n'), 'Title\nbody\n');
});

test('BOM を取り除く', () => {
  assert.equal(canonicalizeText('﻿Title\nbody'), 'Title\nbody');
});

test('contentHash は sha256: プレフィックス付き hex', () => {
  const h = contentHash('Title\nbody');
  assert.match(h, /^sha256:[0-9a-f]{64}$/);
  assert.equal(h, contentHash('Title\nbody')); // 決定的
  assert.notEqual(h, contentHash('Title\nbody2'));
});
