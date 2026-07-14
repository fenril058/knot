import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRefs } from '../../src/core/links.ts';

test('ブラケットリンクとハッシュタグを title_lc で集める', () => {
  const { linkTargets } = extractRefs('タイトル\n[Foo Bar] と #tag と [foo_bar]');
  assert.deepEqual(linkTargets.map((t) => t.titleLc).sort(), ['foo_bar', 'tag']);
});

test('装飾の入れ子の中のリンクも拾う', () => {
  const { linkTargets } = extractRefs('タイトル\n[* [Nested]]');
  assert.deepEqual(linkTargets.map((t) => t.titleLc), ['nested']);
});

test('行 permalink の行 ID を除いてページ名にする', () => {
  const { linkTargets } = extractRefs('タイトル\n[テロメア#61f23df197c291000066c1cf]');
  assert.deepEqual(linkTargets.map((t) => t.titleLc), ['テロメア'.toLowerCase()]);
});

test('アイコン記法はそのページへのリンクになる', () => {
  const { linkTargets } = extractRefs('タイトル\n[alice.icon]');
  assert.deepEqual(linkTargets.map((t) => t.titleLc), ['alice']);
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

test('ブラケットの .png URL だけのページは image ノードとして拾われる', () => {
  const src = 'タイトル\n[https://example.com/b.png]';
  assert.equal(extractRefs(src).image, 'https://example.com/b.png');
});

test('実物形式の Gyazo ハッシュ URL は image ノードとして拾われる', () => {
  // パーサが src を thumb URL に書き換える（実測値）。
  const src = 'タイトル\n[https://gyazo.com/0204f06d4ed4af1554dc3c2a87a806b2]';
  assert.equal(
    extractRefs(src).image,
    'https://gyazo.com/0204f06d4ed4af1554dc3c2a87a806b2/thumb/1000',
  );
});

test('[[...]] の strongImage 記法も代表画像になる', () => {
  const src = 'タイトル\n[[https://example.com/b.png]]';
  assert.equal(extractRefs(src).image, 'https://example.com/b.png');
});

test('table 記法の中のリンクも linkTargets に入る', () => {
  const src = 'タイトル\ntable:名前\n\t[TableLink]\tcell2';
  assert.deepEqual(extractRefs(src).linkTargets.map((t) => t.titleLc), ['tablelink']);
});

test('ULID 形式の行 ID も除去され、リンク先は重複しない', () => {
  const src = 'タイトル\n[ページ#01HZXW3E8PJQK5M2N4R6T8V0AB] [ページ]';
  assert.deepEqual(extractRefs(src).linkTargets.map((t) => t.titleLc), ['ページ']);
});

test('タイトル中の # は保持し、末尾の行 ID だけを除去する', () => {
  const src = 'タイトル\n[C#の話#61f23df197c291000066c1cf]';
  assert.deepEqual(extractRefs(src).linkTargets.map((t) => t.titleLc), ['c#の話']);
});

test('linkTargets は原文タイトルと lc 形の組を返す', () => {
  const refs = extractRefs('タイトル\n[Foo Bar] と #TagName と [foo bar]');
  assert.deepEqual(refs.linkTargets, [
    { title: 'Foo Bar', titleLc: 'foo_bar' },
    { title: 'TagName', titleLc: 'tagname' },
  ]);
});
