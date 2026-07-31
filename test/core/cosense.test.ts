import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLines, parseExportFile } from '../../src/core/cosense.ts';

void test('文字列行はメタデータ null で正規化する', () => {
  const out = normalizeLines({ title: 't', lines: ['t', 'body'] });
  assert.deepEqual(out[1], { id: null, text: 'body', created: null, updated: null, userId: null });
});

void test('オブジェクト行はメタデータを保持する', () => {
  const out = normalizeLines({
    title: 't',
    lines: [{ text: 't', created: 10, updated: 20, userId: 'u9', id: 'abc' }],
  });
  assert.deepEqual(out[0], { id: 'abc', text: 't', created: 10, updated: 20, userId: 'u9' });
});

void test('正しいエクスポート JSON を受理する', () => {
  const data = {
    name: 'proj',
    displayName: 'Proj',
    exported: 123,
    users: [{ id: 'u1', name: 'alice' }],
    pages: [{ title: 'p', created: 1, updated: 2, lines: ['p'] }],
  };
  assert.deepEqual(parseExportFile(data).pages[0].title, 'p');
});

void test('pages が無い・行が空・title 欠落は拒否する', () => {
  assert.throws(() => parseExportFile({}), /pages/);
  assert.throws(() => parseExportFile({ pages: [{ title: 'p', lines: [] }] }), /lines/);
  assert.throws(() => parseExportFile({ pages: [{ lines: ['x'] }] }), /title/);
});

void test('行メタデータの型不正を拒否する', () => {
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', lines: [{ text: 'p', created: '10' }] }] }),
    /pages\[0\].*created/,
  );
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', lines: [{ text: 'p', updated: '20' }] }] }),
    /pages\[0\].*updated/,
  );
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', lines: [{ text: 'p', id: 123 }] }] }),
    /pages\[0\].*id/,
  );
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', lines: [{ text: 'p', userId: 5 }] }] }),
    /pages\[0\].*userId/,
  );
});

void test('ページメタデータの型不正を拒否する', () => {
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', created: 'x', lines: ['p'] }] }),
    /pages\[0\]\.created/,
  );
  assert.throws(
    () => parseExportFile({ pages: [{ title: 'p', id: 9, lines: ['p'] }] }),
    /pages\[0\]\.id/,
  );
});

void test('users の要素に id と name が必須', () => {
  assert.throws(
    () => parseExportFile({ users: [{ name: 'alice' }], pages: [{ title: 'p', lines: ['p'] }] }),
    /users\[0\]/,
  );
});

void test('ページでない要素は位置と理由つきで拒否する', () => {
  assert.throws(() => parseExportFile({ pages: ['x'] }), /pages\[0\] must be an object/);
});

void test('返り値は入力から独立したコピーである', () => {
  const data = { pages: [{ title: 'p', lines: ['p'] }] };
  const out = parseExportFile(data);
  out.pages[0].title = 'changed';
  assert.equal(data.pages[0].title, 'p');
});
