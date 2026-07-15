import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLines } from '../../src/render/render.ts';

const cfg = { allowedFrameHosts: [] };

function renderOne(text: string, known: [string, string][] = []): string {
  const lines = [{ id: 'title', text: 'Title' }, { id: 'l1', text }];
  const map = new Map(known.map(([lc, title]) => [lc, { title, image: null }]));
  const out = renderLines(lines, map, 'proj', cfg);
  return String(out[1]!.html);
}

test('プレーンテキストはエスケープされる', () => {
  assert.equal(renderOne('<script>alert(1)</script>'), '<div>&lt;script&gt;alert(1)&lt;/script&gt;</div>');
});

test('ブラケットリンク: 既存ページは通常リンク、存在しないページは赤リンク', () => {
  const html = renderOne('[Foo]', [['foo', 'Foo']]);
  assert.match(html, /<a href="\/proj\/Foo"[^>]*>Foo<\/a>/);
  const red = renderOne('[Bar]');
  assert.match(red, /class="red-link"/);
  assert.match(red, /href="\/proj\/Bar\/edit"/);
});

test('ハッシュタグは title_lc で解決しブラケットリンクと同じ扱い', () => {
  assert.match(renderOne('#Foo', [['foo', 'Foo']]), /<a href="\/proj\/Foo"/);
});

test('外部リンクは http/https のみリンク化、他スキームは平文', () => {
  assert.match(renderOne('[https://example.com Ex]'), /<a href="https:\/\/example\.com"[^>]*>Ex<\/a>/);
  const js = renderOne('[javascript:alert(1) Ex]');
  assert.doesNotMatch(js, /<a /);
  assert.match(js, /javascript:alert\(1\)/);
});

test('太字の装飾', () => {
  assert.match(renderOne('[* bold]'), /<strong>bold<\/strong>/);
});

test('斜体・打ち消し線の装飾', () => {
  assert.match(renderOne('[/ italic]'), /<em>italic<\/em>/);
  assert.match(renderOne('[- strike]'), /<del>strike<\/del>/);
});

test('インラインコードはエスケープされたまま code タグに', () => {
  assert.match(renderOne('`<b>x</b>`'), /<code>&lt;b&gt;x&lt;\/b&gt;<\/code>/);
});

test('数式は out of scope につき code として描画', () => {
  assert.match(renderOne('[$ x^2]'), /<code>/);
});

test('画像リンクの alt にイベントハンドラを注入しようとしても属性値としてエスケープされる', () => {
  const html = renderOne('[" onerror="alert(1) https://example.com/a.png]');
  assert.doesNotMatch(html, /onerror=/);
});

test('コードブロックは複数物理行を 1 ブロックとして消費し、各物理行に対応する html を生成する', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: 'code:a.js' },
    { id: 'l2', text: ' const x = 1;' },
    { id: 'l3', text: ' <script>x</script>' },
    { id: 'l4', text: 'after' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.equal(out.length, 5);
  assert.match(String(out[3]!.html), /&lt;script&gt;/);
  assert.deepEqual(out.map((o) => o.lineId), ['title', 'l1', 'l2', 'l3', 'l4']);
});

test('テーブルも複数物理行を 1 ブロックとして消費する', () => {
  const lines = [
    { id: 'title', text: 'Title' },
    { id: 'l1', text: 'table:t' },
    { id: 'l2', text: ' a\tb' },
    { id: 'l3', text: ' c\td' },
  ];
  const out = renderLines(lines, new Map(), 'proj', cfg);
  assert.equal(out.length, 4);
  assert.match(String(out[2]!.html), /<table>/);
});
