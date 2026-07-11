import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRefs } from '../../src/core/links.ts';

test('ブラケットリンクとハッシュタグを title_lc で集める', () => {
  const { linkTargets } = extractRefs('タイトル\n[Foo Bar] と #tag と [foo_bar]');
  assert.deepEqual(linkTargets.sort(), ['foo_bar', 'tag']);
});

test('装飾の入れ子の中のリンクも拾う', () => {
  const { linkTargets } = extractRefs('タイトル\n[* [Nested]]');
  assert.deepEqual(linkTargets, ['nested']);
});

test('行 permalink の行 ID を除いてページ名にする', () => {
  const { linkTargets } = extractRefs('タイトル\n[テロメア#61f23df197c291000066c1cf]');
  assert.deepEqual(linkTargets, ['テロメア'.toLowerCase()]);
});

test('アイコン記法はそのページへのリンクになる', () => {
  const { linkTargets } = extractRefs('タイトル\n[alice.icon]');
  assert.deepEqual(linkTargets, ['alice']);
});

test('外部 URL・他プロジェクトリンク・コードブロックはリンク対象外', () => {
  const src = 'タイトル\n[https://example.com t] [/other/page]\ncode:x.py\n [not_a_link]';
  assert.deepEqual(extractRefs(src).linkTargets, []);
});

test('代表画像は最初の画像 URL', () => {
  const src = 'タイトル\n[https://example.com/page]\n[https://gyazo.com/abc] [https://example.com/b.png]';
  assert.equal(extractRefs(src).image, 'https://gyazo.com/abc');
});

test('画像がなければ null', () => {
  assert.equal(extractRefs('タイトル\n本文だけ').image, null);
});
