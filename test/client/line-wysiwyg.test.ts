import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState } from '@codemirror/state';
import { editingLineNumbers } from '../../src/client/editor/cm/lineWysiwyg.ts';

void test('空の選択はカーソルを含む物理行だけを編集行にする', () => {
  const state = EditorState.create({ doc: 'title\nfirst\nsecond', selection: { anchor: 8 } });
  assert.deepEqual([...editingLineNumbers(state)], [2]);
});

void test('複数行選択は終端が次行先頭でも触れる全行を編集行にする', () => {
  const state = EditorState.create({
    doc: 'title\nfirst\nsecond',
    selection: EditorSelection.create([EditorSelection.range(7, 12)]),
  });
  assert.deepEqual([...editingLineNumbers(state)], [2, 3]);
});

void test('複数カーソルと範囲選択が触れる行の和集合を返す', () => {
  const state = EditorState.create({
    doc: 'title\nfirst\nsecond\nthird',
    selection: EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.range(8, 20),
    ], 1),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  assert.deepEqual([...editingLineNumbers(state)], [1, 2, 3, 4]);
});
