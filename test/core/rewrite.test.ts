import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewritePageLinks } from '../../src/core/links.ts';

test('ブラケットリンクとハッシュタグを書き換える', () => {
  const lines = ['Page', 'see [Old Title] here', 'tag #old_title end', 'no link'];
  const result = rewritePageLinks(lines, 'old_title', 'New Title');
  assert.deepEqual(result, [null, 'see [New Title] here', 'tag [New Title] end', null]);
  // #old_title → 新タイトルに空白があるためハッシュタグでは表せず [New Title] に落とす
});

test('新タイトルがハッシュタグ安全ならハッシュタグ形を保つ', () => {
  const lines = ['Page', '#OldTag'];
  assert.deepEqual(rewritePageLinks(lines, 'oldtag', 'NewTag'), [null, '#NewTag']);
});

test('行 ID フラグメント付きリンクはフラグメントを保持する', () => {
  const lineId = '0123456789abcdef01234567';
  const lines = ['Page', `[Old#${lineId}]`];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, `[New#${lineId}]`]);
});

test('アイコン記法を書き換える', () => {
  const lines = ['Page', 'by [old.icon]'];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, 'by [New.icon]']);
});

test('コードブロックの中は書き換えない', () => {
  const lines = ['Page', 'code:sample.js', ' const x = "[Old]";', '[Old]'];
  const result = rewritePageLinks(lines, 'old', 'New');
  assert.deepEqual(result, [null, null, null, '[New]']);
});

test('テーブルのセル内リンクを書き換える', () => {
  const lines = ['Page', 'table:t', '\t[Old]\tb'];
  const result = rewritePageLinks(lines, 'old', 'New');
  assert.deepEqual(result, [null, null, '\t[New]\tb']);
});

test('タイトル行（先頭行）は書き換えない', () => {
  const lines = ['[Old] を含むタイトル', 'body [Old]'];
  const result = rewritePageLinks(lines, 'old', 'New');
  assert.equal(result[0], null);
  assert.equal(result[1], 'body [New]');
});

test('同一行に同じリンクが 2 回あれば両方書き換える', () => {
  const lines = ['Page', '[Old] and [Old]'];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, '[New] and [New]']);
});

test('コード記法内の同一文字列は書き換えず、後続のリンクは書き換える', () => {
  const lines = ['Page', '`[Old]` and [Old]'];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, '`[Old]` and [New]']);
});

test('装飾ノードの中のリンクも書き換える', () => {
  const lines = ['Page', '[* important [Old] here]'];
  assert.deepEqual(rewritePageLinks(lines, 'old', 'New'), [null, '[* important [New] here]']);
});
