import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightSpans, type Span, type SpanKind } from '../../src/client/editor/highlight.ts';

const notationCase = (source: string, kind: SpanKind): void => {
  const docText = `Title\n${source}`;
  assert.deepEqual(highlightSpans(docText), [
    { from: 0, to: 5, kind: 'title' },
    { from: 6, to: 6 + source.length, kind },
  ]);
};

test('各 Scrapbox 記法に固定オフセットのスパンを付ける', () => {
  notationCase('[page]', 'link');
  notationCase('[https://x タイトル]', 'external-link');
  notationCase('#tag', 'hashtag');
  notationCase('[* 強調]', 'strong');
  notationCase('`code`', 'code-inline');
  notationCase('> quote', 'quote');
  notationCase('https://x', 'url');
  notationCase('[name.icon]', 'icon');
  notationCase('[$ x+y]', 'formula');
  notationCase('[/ italic]', 'italic');
  notationCase('[- strike]', 'strike');
});

test('複数行コードブロックを行単位で装飾し、後続行の位置を保つ', () => {
  const docText = 'Title\ncode:name\n line one\n line two\n#after';

  assert.deepEqual(highlightSpans(docText), [
    { from: 0, to: 5, kind: 'title' },
    { from: 6, to: 15, kind: 'code-block' },
    { from: 16, to: 25, kind: 'code-block' },
    { from: 26, to: 35, kind: 'code-block' },
    { from: 36, to: 42, kind: 'hashtag' },
  ]);
});

test('内容が空白 1 行だけのコードブロックでも後続行の位置を保つ', () => {
  const docText = 'Title\ncode:name\n \n#after';

  assert.deepEqual(highlightSpans(docText), [
    { from: 0, to: 5, kind: 'title' },
    { from: 6, to: 15, kind: 'code-block' },
    { from: 16, to: 17, kind: 'code-block' },
    { from: 18, to: 24, kind: 'hashtag' },
  ]);
});

test('インデントと本文を別々のスパンにする', () => {
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

test('複合ドキュメントの全スパンは範囲内にあり、同一行で交差しない', () => {
  const documents = [
    'Title\n  [page] #tag and `code`\n> [https://x label]',
    'Title\n[* outer [/ inner]] and [- removed]\n[name.icon] https://example.com',
    'Title\ncode:ts\n const value = 1\n\n[$ value^2]',
    'Title\ntable:data\n a\tb\n c\td\n#after',
  ];

  for (const docText of documents) assertValidSpans(docText, highlightSpans(docText));
});
