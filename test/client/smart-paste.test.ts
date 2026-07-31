import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transformPaste,
  defaultRules,
  type PasteContext,
  type PasteRule,
} from '../../src/client/editor/smartPaste.ts';
import type { Span } from '../../src/client/editor/highlight.ts';

const ctx = (docText: string, from: number, to = from, spans: Span[] = []): PasteContext => ({
  docText,
  from,
  to,
  spans,
});

const alwaysSuppress: PasteRule = () => true;

void test('URL 単独ペーストは [URL] に変換する', () => {
  assert.equal(transformPaste(ctx('', 0), 'https://example.com'), '[https://example.com]');
});

void test('選択ありで URL をペーストすると [URL 選択テキスト] に変換する', () => {
  const docText = '選択テキスト';
  assert.equal(
    transformPaste(ctx(docText, 0, docText.length), 'https://example.com'),
    '[https://example.com 選択テキスト]',
  );
});

void test('非 URL テキストは変換しない', () => {
  assert.equal(transformPaste(ctx('', 0), 'hello'), null);
});

void test('複数語のテキストは変換しない', () => {
  assert.equal(transformPaste(ctx('', 0), 'hello world'), null);
});

void test('javascript: スキームは変換しない', () => {
  assert.equal(transformPaste(ctx('', 0), 'javascript:alert(1)'), null);
});

void test('前後の空白はトリムしてから判定する', () => {
  assert.equal(transformPaste(ctx('', 0), '  https://example.com  '), '[https://example.com]');
});

void test('コードブロック内では変換しない', () => {
  const spans: Span[] = [{ from: 0, to: 10, kind: 'code-block' }];
  assert.equal(transformPaste(ctx('0123456789', 5, 5, spans), 'https://example.com'), null);
});

void test('インラインコード内では変換しない', () => {
  const spans: Span[] = [{ from: 0, to: 10, kind: 'code-inline' }];
  assert.equal(transformPaste(ctx('0123456789', 5, 5, spans), 'https://example.com'), null);
});

void test('既存ブラケットの内側（[foo|bar] の内側）では変換しない', () => {
  const docText = '[foo|bar]';
  const from = docText.indexOf('|') + 1;
  assert.equal(transformPaste(ctx(docText, from), 'https://example.com'), null);
});

void test('未閉のブラケットの内側でも変換しない', () => {
  const docText = '[foo bar';
  assert.equal(transformPaste(ctx(docText, docText.length), 'https://example.com'), null);
});

void test('ブラケットの外側では既定ルールが変換を妨げない', () => {
  const docText = '[foo] bar';
  assert.equal(
    transformPaste(ctx(docText, docText.length), 'https://example.com'),
    '[https://example.com]',
  );
});

void test('呼び出し側がカスタムルールを追加すると任意条件で抑止できる', () => {
  const rules = [...defaultRules, alwaysSuppress];
  assert.equal(transformPaste(ctx('', 0), 'https://example.com', rules), null);
});

void test('呼び出し側がルールを差し替えると既定ルールを迂回できる', () => {
  const spans: Span[] = [{ from: 0, to: 10, kind: 'code-block' }];
  assert.equal(
    transformPaste(ctx('0123456789', 5, 5, spans), 'https://example.com', []),
    '[https://example.com]',
  );
});
