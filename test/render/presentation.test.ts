import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  indentMark,
  isLinkOnlyLine,
  knownPageMap,
  presentationLines,
  type PresentedNode,
  type SourceSpan,
} from '../../src/render/presentation.ts';

const config = {
  allowedImageHosts: ['images.example'],
  allowedMediaHosts: ['media.example'],
};

function bodyNodes(source: string, knownPages = knownPageMap([])): PresentedNode[] {
  const line = presentationLines(`Title\n${source}`, knownPages, 'proj', config)[1];
  assert.equal(line?.role, 'line');
  return line.nodes;
}

void test('既知ページを正規タイトルへ解決し、不在リンクと代表画像アイコンを区別する', () => {
  const knownPages = knownPageMap([{ title: 'Foo Page', image: 'https://images.example/foo.png' }]);
  const nodes = bodyNodes('[foo_page] [Missing] [Foo Page.icon]', knownPages);

  const links = nodes.filter((node) => node.type === 'link');
  assert.deepEqual(links.map((link) => [link.href, link.className]), [
    ['/proj/Foo_Page', 'page-link'],
    ['/proj/Missing', 'empty-link'],
    ['/proj/Foo_Page', 'icon-link'],
  ]);
  const icon = links[2]?.children[0];
  assert.equal(icon?.type, 'image');
  if (icon?.type === 'image') assert.equal(icon.src, 'https://images.example/foo.png');
});

void test('引用画像装飾は許可された絶対画像だけを表示計画へ残す', () => {
  const nodes = bodyNodes('[" https://images.example/a.png [relative.png]]');
  assert.equal(nodes.length, 1);
  const decoration = nodes[0];
  assert.equal(decoration?.type, 'container');
  if (decoration?.type !== 'container') return;
  assert.deepEqual(decoration.children.map((child) => child.type), ['image']);
  const image = decoration.children[0];
  assert.equal(image?.type, 'image');
  if (image?.type === 'image') assert.equal(image.src, 'https://images.example/a.png');
});

void test('行頭の印は、引用行と番号付きの行が横線、コードブロックの本文行と表の行が無し、それ以外が点', () => {
  const source = 'Title\n a\n > quoted\n 1. numbered\n code:a.js\n  x = 1\n table:t\n  a\tb';
  const lines = presentationLines(source, new Map(), 'proj', config);
  assert.deepEqual(lines.slice(1).map(indentMark), ['dot', 'dash', 'dash', 'dot', 'none', 'dot', 'none']);
});

void test('コマンドラインは記号の後の空白を落とさず、原文のままコードとして描く', () => {
  assert.deepEqual(bodyNodes('$ git reset --hard'), [
    { type: 'code', text: '$ git reset --hard', className: 'cli', span: { from: 6, to: 24, verbatim: true } },
  ]);
});

type TextPiece = { text: string; span: SourceSpan };

function textPieces(nodes: readonly PresentedNode[]): TextPiece[] {
  return nodes.flatMap((node): TextPiece[] => {
    if (node.type === 'text' || node.type === 'code') return [{ text: node.text, span: node.span }];
    if (node.type === 'container' || node.type === 'link') return textPieces(node.children);
    return [];
  });
}

void test('描いた字は原文の位置を持ち、原文と違う字は node の範囲全体に対応する（#243）', () => {
  const knownPages = knownPageMap([{ title: 'shown', image: 'https://images.example/icon.png' }]);
  const bodies = [
    'plain text',
    'a [ ] b',
    '? help me',
    'x `code` y',
    '$ git reset --hard',
    '[$ x^2 ] after',
    '[[strong]] and [* bold] [/ italic] [- strike] [*/ both]',
    '> quote [link]',
    '1. numbered [link]',
    '#tag and #tag2',
    '[name.icon] [shown.icon] [/proj/name.icon]',
    '[https://images.example/a.png] [[https://images.example/b.png]] [https://blocked.example/a.png]',
    'https://example.com/bare',
    '[https://example.com/label label] [label https://example.com/label]',
    '[/proj/page] [page#hash]',
    '[N35.6,E139.7,Z14 東京]',
    '[javascript:alert(1) click]',
    '[https://media.example/a.mp4]',
  ];
  const source = ['Title', ...bodies, 'table:t', ' a\t[link]\t`code`', 'code:a.js', ' x = 1'].join('\n');
  const lines = presentationLines(source, knownPages, 'proj', config);
  const nonVerbatim: string[] = [];
  for (const line of lines) {
    const pieces = line.role === 'line'
      ? textPieces(line.nodes)
      : line.role === 'tableRow'
        ? textPieces(line.cells.flat())
        : [{ text: line.text, span: line.textSpan }];
    for (const piece of pieces) {
      assert.ok(piece.span.from >= line.from && piece.span.to <= line.to, `${piece.text} is outside its line`);
      if (piece.span.verbatim) assert.equal(source.slice(piece.span.from, piece.span.to), piece.text);
      else nonVerbatim.push(piece.text);
    }
  }
  // 原文と字が違うのは、画像の無いアイコンの代わりに描く [name] だけ。
  assert.deepEqual(nonVerbatim, ['[name]', '[/proj/name]']);
});

void test('リンクのラベルは、URL が先なら ] の直前、ラベルが先なら [ の直後の字に対応する', () => {
  const source = 'Title\n[https://example.com/label label] [label https://example.com/label]';
  const line = presentationLines(source, new Map(), 'proj', config)[1];
  assert.equal(line?.role, 'line');
  if (line?.role !== 'line') return;
  const labels = textPieces(line.nodes).filter((piece) => piece.text === 'label');
  assert.deepEqual(labels.map((piece) => source.slice(piece.span.from - 1, piece.span.to + 1)), [' label]', '[label ']);
});

void test('原文と違う字を描くアイコンと、画像は、node の範囲全体に対応する', () => {
  const source = 'Title\n[name.icon] [https://images.example/a.png]';
  const line = presentationLines(source, new Map(), 'proj', config)[1];
  assert.equal(line?.role, 'line');
  if (line?.role !== 'line') return;
  const icon = textPieces(line.nodes)[0];
  assert.deepEqual(icon, { text: '[name]', span: { from: 6, to: 17, verbatim: false } });
  const image = line.nodes.at(-1);
  assert.equal(image?.type, 'image');
  if (image?.type === 'image') assert.deepEqual(image.span, { from: 18, to: 48, verbatim: false });
});

void test('同じ本文でも周囲のブロック種別が変われば表示キーが変わる', () => {
  const tableLine = presentationLines('Title\ntable:t\n a\tb', new Map(), 'proj', config)[2];
  const plainLine = presentationLines('Title\nplainxx\n a\tb', new Map(), 'proj', config)[2];

  assert.equal(tableLine?.role, 'tableRow');
  assert.equal(plainLine?.role, 'line');
  assert.notEqual(tableLine?.renderKey, plainLine?.renderKey);
});

void test('危険なスキームと許可外メディアをリンク要素へ変換しない', () => {
  const unsafe = bodyNodes('[javascript:alert(1) click]');
  assert.equal(unsafe.some((node) => node.type === 'link'), false);

  const blocked = bodyNodes('https://blocked.example/a.png');
  assert.equal(blocked[0]?.type, 'link');
  const allowed = bodyNodes('https://media.example/a.mp4');
  assert.equal(allowed[0]?.type, 'video');
});

void test('リンクと埋め込みと空白だけの行を、行末に編集を始める面を残す行として見分ける（#245）', () => {
  const bodies: [string, boolean][] = [
    ['[a]', true],
    ['[a] [b] #tag', true],
    [' [a]', true],
    ['[* [a]]', true],
    ['> [a]', true],
    ['[name.icon]', true],
    ['https://media.example/a.mp4', true],
    ['text [a]', false],
    ['[a].', false],
    ['1. [a]', false],
    ['[https://images.example/a.png]', false],
    ['plain', false],
    ['', false],
  ];
  const lines = presentationLines(['Title', ...bodies.map(([body]) => body)].join('\n'), new Map(), 'proj', config);
  assert.deepEqual(lines.slice(1).map(isLinkOnlyLine), bodies.map(([, linkOnly]) => linkOnly));
  assert.equal(isLinkOnlyLine(lines[0]!), false);
});
