import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightSpans, type Span, type SpanKind, type SpanStyle } from '../../src/client/editor/highlight.ts';

const notationCase = (source: string, kind: SpanKind, styles?: SpanStyle[]): void => {
  const docText = `Title\n${source}`;
  assert.deepEqual(highlightSpans(docText), [
    { from: 0, to: 5, kind: 'title' },
    styles === undefined ? { from: 6, to: 6 + source.length, kind } : { from: 6, to: 6 + source.length, kind, styles },
  ]);
};

void test('各 Scrapbox 記法に固定オフセットのスパンを付ける', () => {
  notationCase('[page]', 'link');
  notationCase('[https://x タイトル]', 'external-link');
  notationCase('#tag', 'hashtag');
  notationCase('[* 強調]', 'strong', ['strong']);
  notationCase('`code`', 'code-inline');
  notationCase('> quote', 'quote');
  notationCase('https://x', 'url');
  notationCase('[name.icon]', 'icon');
  notationCase('[$ x+y]', 'formula');
  notationCase('[/ italic]', 'italic', ['italic']);
  notationCase('[- strike]', 'strike', ['strike']);
});

// カーソル行でも閲覧表示と同じ字の形で描くため、装飾の見た目をすべて重ねる（#267）。
void test('装飾には、強調の段階・斜体・打ち消しの見た目を重ねて付ける', () => {
  notationCase('[**** 四段]', 'strong', ['strong', 'level-4']);
  notationCase('[-/*** 打ち消し斜体]', 'italic', ['strong', 'level-3', 'italic', 'strike']);
  // [[x]] は強調の段階を持たない太字。
  notationCase('[[太字]]', 'strong');
});

// カーソル行でも閲覧表示と同じく、ページの無いリンクとハッシュタグを空リンクの色で描く（#273）。
const isKnownTitle = (title: string): boolean => title === 'known page';

void test('ページがあるかどうかを渡すと、ページの無いリンクとハッシュタグを empty-link にする', () => {
  // 行へのリンク（行 ID の付いたリンク）はリンク先のページで決め、行 ID でない # はタイトルの一部（#297）。
  const lineLink = '[known page#5b630aae9dc7d80000931bc3]';
  assert.deepEqual(highlightSpans(`Title\n[known page] [missing] ${lineLink} [known page#anchor] #missing`, isKnownTitle), [
    { from: 0, to: 5, kind: 'title' },
    { from: 6, to: 18, kind: 'link' },
    { from: 19, to: 28, kind: 'empty-link' },
    { from: 29, to: 29 + lineLink.length, kind: 'link' },
    { from: 30 + lineLink.length, to: 49 + lineLink.length, kind: 'empty-link' },
    { from: 50 + lineLink.length, to: 58 + lineLink.length, kind: 'empty-link' },
  ]);
  // 渡さなければ、ページの有無で分けない。
  assert.deepEqual(highlightSpans('Title\n[missing] #missing').map((span) => span.kind), ['title', 'link', 'hashtag']);
});

// 別のプロジェクトへのリンクは、閲覧表示と同じくページへのリンクの色（#287）。ページの有無は分からないので
// 空リンクにはしない。アップロードしたファイルへのリンクは、これまでどおり外部リンクの色。
void test('別のプロジェクトへのリンクはページへのリンクにし、アップロードしたファイルへのリンクは外部リンクのままにする', () => {
  assert.deepEqual(highlightSpans('Title\n[/villagepump/被リンク] [/files/01ABC/doc.pdf]', isKnownTitle).map((span) => span.kind),
    ['title', 'link', 'external-link']);
});

void test('装飾の中のリンクにも、装飾の見た目を重ねる', () => {
  assert.deepEqual(highlightSpans('Title\n[** [page] と二段]'), [
    { from: 0, to: 5, kind: 'title' },
    { from: 6, to: 10, kind: 'strong', styles: ['strong', 'level-2'] },
    { from: 10, to: 16, kind: 'link', styles: ['strong', 'level-2'] },
    { from: 16, to: 21, kind: 'strong', styles: ['strong', 'level-2'] },
  ]);
});

void test('複数行コードブロックを行単位で装飾し、後続行の位置を保つ', () => {
  const docText = 'Title\ncode:name\n line one\n line two\n#after';

  assert.deepEqual(highlightSpans(docText), [
    { from: 0, to: 5, kind: 'title' },
    { from: 6, to: 15, kind: 'code-block' },
    { from: 16, to: 25, kind: 'code-block' },
    { from: 26, to: 35, kind: 'code-block' },
    { from: 36, to: 42, kind: 'hashtag' },
  ]);
});

void test('内容が空白 1 行だけのコードブロックでも後続行の位置を保つ', () => {
  const docText = 'Title\ncode:name\n \n#after';

  assert.deepEqual(highlightSpans(docText), [
    { from: 0, to: 5, kind: 'title' },
    { from: 6, to: 15, kind: 'code-block' },
    { from: 16, to: 17, kind: 'code-block' },
    { from: 18, to: 24, kind: 'hashtag' },
  ]);
});

void test('インデントと本文を別々のスパンにする', () => {
  assert.deepEqual(highlightSpans('Title\n  [page]'), [
    { from: 0, to: 5, kind: 'title' },
    { from: 6, to: 8, kind: 'indent' },
    { from: 8, to: 14, kind: 'link' },
  ]);
});

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split('\n').length - 1;

const assertValidSpans = (docText: string, spans: Span[]): void => {
  for (const span of spans) {
    assert.ok(0 <= span.from && span.from < span.to && span.to <= docText.length);
  }
  const byLine = new Map<number, Span[]>();
  for (const span of spans) {
    const line = lineAt(docText, span.from);
    byLine.set(line, [...(byLine.get(line) ?? []), span]);
  }
  for (const lineSpans of byLine.values()) {
    const sorted = lineSpans.toSorted((left, right) => left.from - right.from);
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok(sorted[index - 1]!.to <= sorted[index]!.from);
    }
  }
};

void test('複合ドキュメントの全スパンは範囲内にあり、同一行で交差しない', () => {
  const documents = [
    'Title\n  [page] #tag and `code`\n> [https://x label]',
    'Title\n[* outer [/ inner]] and [- removed]\n[name.icon] https://example.com',
    'Title\ncode:ts\n const value = 1\n\n[$ value^2]',
    'Title\ntable:data\n a\tb\n c\td\n#after',
  ];

  for (const docText of documents) assertValidSpans(docText, highlightSpans(docText));
});
