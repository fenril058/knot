import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLines, parseExportFile } from '../../src/core/cosense.ts';

test('文字列行はメタデータ null で正規化する', () => {
  const out = normalizeLines({ title: 't', lines: ['t', 'body'] });
  assert.deepEqual(out[1], { id: null, text: 'body', created: null, updated: null, userId: null });
});

test('オブジェクト行はメタデータを保持する', () => {
  const out = normalizeLines({
    title: 't',
    lines: [{ text: 't', created: 10, updated: 20, userId: 'u9', id: 'abc' }],
  });
  assert.deepEqual(out[0], { id: 'abc', text: 't', created: 10, updated: 20, userId: 'u9' });
});

test('正しいエクスポート JSON を受理する', () => {
  const data = {
    name: 'proj',
    displayName: 'Proj',
    exported: 123,
    users: [{ id: 'u1', name: 'alice' }],
    pages: [{ title: 'p', created: 1, updated: 2, lines: ['p'] }],
  };
  assert.deepEqual(parseExportFile(data).pages[0].title, 'p');
});

test('pages が無い・行が空・title 欠落は拒否する', () => {
  assert.throws(() => parseExportFile({}), /pages/);
  assert.throws(() => parseExportFile({ pages: [{ title: 'p', lines: [] }] }), /lines/);
  assert.throws(() => parseExportFile({ pages: [{ lines: ['x'] }] }), /title/);
});
