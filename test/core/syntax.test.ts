import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePageSyntax, SyntaxMappingError, type SourceRange } from '../../src/core/syntax.ts';

void test('ソース範囲と対応エラーを内部 API の契約として公開する', () => {
  const range: SourceRange = { from: 1, to: 2 };
  assert.deepEqual(range, { from: 1, to: 2 });
  assert.ok(new SyntaxMappingError('mapping failed') instanceof Error);
});

void test('タイトル・行・入れ子ノードへページ全体の UTF-16 範囲を付ける', () => {
  const source = 'Title😀\n[* same] [* same] 😀';
  const blocks = parsePageSyntax(source, { hasTitle: true });

  assert.equal(blocks[0]?.type, 'title');
  assert.deepEqual(blocks[0]?.range, { from: 0, to: 7 });

  const line = blocks[1];
  assert.equal(line?.type, 'line');
  if (line?.type !== 'line') return;
  assert.deepEqual(line.range, { from: 8, to: source.length });
  assert.deepEqual(line.nodes.map(({ raw, range }) => ({ raw, range })), [
    { raw: '[* same]', range: { from: 8, to: 16 } },
    { raw: ' ', range: { from: 16, to: 17 } },
    { raw: '[* same]', range: { from: 17, to: 25 } },
    { raw: ' 😀', range: { from: 25, to: 28 } },
  ]);
  const first = line.nodes[0];
  const second = line.nodes[2];
  assert.ok(first?.type === 'decoration' && second?.type === 'decoration');
  assert.deepEqual(first.nodes[0]?.range, { from: 11, to: 15 });
  assert.deepEqual(second.nodes[0]?.range, { from: 20, to: 24 });
  for (const node of line.nodes) {
    assert.equal(source.slice(node.range.from, node.range.to), node.raw);
  }
});

void test('コードブロックとテーブルが消費する物理行範囲を空白行も含めて返す', () => {
  const source = 'Title\ncode:x\n \n  value\ntable:t\n a\tb\n same\tsame\n';
  const blocks = parsePageSyntax(source, { hasTitle: true });

  const code = blocks[1];
  assert.equal(code?.type, 'codeBlock');
  if (code?.type !== 'codeBlock') return;
  assert.deepEqual(code.lineRanges.map((range) => source.slice(range.from, range.to)), [
    'code:x',
    ' ',
    '  value',
  ]);
  assert.equal(source.slice(code.range.from, code.range.to), 'code:x\n \n  value');

  const table = blocks[2];
  assert.equal(table?.type, 'table');
  if (table?.type !== 'table') return;
  assert.deepEqual(table.lineRanges.map((range) => source.slice(range.from, range.to)), [
    'table:t',
    ' a\tb',
    ' same\tsame',
  ]);
  assert.deepEqual(
    table.cells[1]?.flat().map(({ raw, range }) => ({ raw, text: source.slice(range.from, range.to) })),
    [
      { raw: 'same', text: 'same' },
      { raw: 'same', text: 'same' },
    ],
  );

  const trailing = blocks[3];
  assert.equal(trailing?.type, 'line');
  assert.deepEqual(trailing?.range, { from: source.length, to: source.length });
});

void test('インデントは行範囲に含み、行内ノード範囲から除く', () => {
  const source = 'Title\n  [page]';
  const blocks = parsePageSyntax(source, { hasTitle: true });
  const line = blocks[1];
  assert.equal(line?.type, 'line');
  if (line?.type !== 'line') return;

  assert.deepEqual(line.range, { from: 6, to: 14 });
  assert.deepEqual(line.nodes[0]?.range, { from: 8, to: 14 });
});
