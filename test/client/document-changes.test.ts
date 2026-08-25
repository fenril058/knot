import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, EditorSelection, EditorState, type SelectionRange } from '@codemirror/state';
import type { Line } from '../../src/core/ops.ts';
import { documentChanges } from '../../src/client/editor/documentChanges.ts';

const text = (lines: readonly Pick<Line, 'id' | 'text'>[]) => lines.map((line) => line.text).join('\n');

function position(lines: readonly Pick<Line, 'id' | 'text'>[], id: string, column: number): number {
  const index = lines.findIndex((line) => line.id === id);
  assert.notEqual(index, -1);
  return lines.slice(0, index).reduce((offset, line) => offset + line.text.length + 1, 0) + column;
}

function mappedSelection(
  before: readonly Pick<Line, 'id' | 'text'>[],
  after: readonly Pick<Line, 'id' | 'text'>[],
  selection: EditorSelection | SelectionRange,
): EditorSelection {
  const state = EditorState.create({
    doc: text(before),
    selection: selection instanceof EditorSelection ? selection : EditorSelection.create([selection]),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
  const updated = state.update({ changes: ChangeSet.of(documentChanges(before, after), text(before).length) }).state;
  assert.equal(updated.doc.toString(), text(after));
  return updated.selection;
}

void test('上方へ行を挿入してもカーソルは同じ行 ID と列に追従する', () => {
  const before = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'Ccc' },
  ];
  const after = [before[0]!, { id: 'x', text: 'X' }, before[1]!, before[2]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.cursor(position(before, 'c', 2)),
  );

  assert.equal(selection.main.head, position(after, 'c', 2));
});

void test('行先頭のカーソルも上方への行挿入後に同じ行 ID へ追従する', () => {
  const before = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'Ccc' },
  ];
  const after = [before[0]!, { id: 'x', text: 'XXXX' }, before[1]!, before[2]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.cursor(position(before, 'b', 0)),
  );

  assert.equal(selection.main.head, position(after, 'b', 0));
});

void test('上方の行を削除してもカーソルは同じ行 ID と列に追従する', () => {
  const before = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'Ccc' },
  ];
  const after = [before[0]!, before[2]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.cursor(position(before, 'c', 2)),
  );

  assert.equal(selection.main.head, position(after, 'c', 2));
});

void test('forward selection の両端を行の挿入へ追従させる', () => {
  const before = [
    { id: 'a', text: 'alpha' },
    { id: 'b', text: 'bravo' },
    { id: 'c', text: 'charlie' },
  ];
  const after = [before[0]!, { id: 'x', text: 'inserted' }, before[1]!, before[2]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.single(position(before, 'b', 2), position(before, 'c', 3)),
  );

  assert.equal(selection.main.anchor, position(after, 'b', 2));
  assert.equal(selection.main.head, position(after, 'c', 3));
});

void test('backward selection の向きと両端を行の削除後も維持する', () => {
  const before = [
    { id: 'a', text: 'alpha' },
    { id: 'b', text: 'bravo' },
    { id: 'c', text: 'charlie' },
  ];
  const after = [before[1]!, before[2]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.single(position(before, 'c', 4), position(before, 'b', 1)),
  );

  assert.equal(selection.main.anchor, position(after, 'c', 4));
  assert.equal(selection.main.head, position(after, 'b', 1));
  assert.equal(selection.main.anchor > selection.main.head, true);
});

void test('複数カーソルと mainIndex を上方への挿入後も維持する', () => {
  const before = [
    { id: 'a', text: 'alpha' },
    { id: 'b', text: 'bravo' },
    { id: 'c', text: 'charlie' },
  ];
  const after = [{ id: 'x', text: 'inserted' }, ...before];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.create([
      EditorSelection.cursor(position(before, 'b', 1)),
      EditorSelection.cursor(position(before, 'c', 2)),
    ], 1),
  );

  assert.equal(selection.ranges.length, 2);
  assert.deepEqual(selection.ranges.map((range) => range.head), [
    position(after, 'b', 1),
    position(after, 'c', 2),
  ]);
  assert.equal(selection.mainIndex, 1);
});

void test('複数カーソルと mainIndex を上方の削除後も維持する', () => {
  const before = [
    { id: 'a', text: 'alpha' },
    { id: 'b', text: 'bravo' },
    { id: 'c', text: 'charlie' },
    { id: 'd', text: 'delta' },
  ];
  const after = [before[0]!, before[2]!, before[3]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.create([
      EditorSelection.cursor(position(before, 'c', 1)),
      EditorSelection.cursor(position(before, 'd', 2)),
    ], 1),
  );

  assert.equal(selection.ranges.length, 2);
  assert.deepEqual(selection.ranges.map((range) => range.head), [
    position(after, 'c', 1),
    position(after, 'd', 2),
  ]);
  assert.equal(selection.mainIndex, 1);
});

void test('同じ行 ID の本文変更を CodeMirror の文字変更として map する', () => {
  const before = [{ id: 'line', text: 'abcdef' }];
  const after = [{ id: 'line', text: 'abXYZef' }];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.cursor(position(before, 'line', 5)),
  );

  assert.equal(selection.main.head, position(after, 'line', 6));
});

void test('astral character を含む行の端点を surrogate pair の途中へ移さない', () => {
  const before = [
    { id: 'title', text: 'Title' },
    { id: 'body', text: 'ab𝒵cd' },
  ];
  const after = [
    before[0]!,
    { id: 'inserted', text: 'remote' },
    { id: 'body', text: 'a𝒵cd' },
  ];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.single(position(before, 'body', 4), position(before, 'body', 2)),
  );
  const afterText = text(after);

  assert.equal(selection.main.anchor, position(after, 'body', 3));
  assert.equal(selection.main.head, position(after, 'body', 1));
  for (const endpoint of [selection.main.anchor, selection.main.head]) {
    const previous = afterText.charCodeAt(endpoint - 1);
    const current = afterText.charCodeAt(endpoint);
    assert.equal(previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF, false);
  }
});

void test('カーソルのある行自体を削除すると後続行の先頭へ map する', () => {
  const before = [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'Bbb' },
    { id: 'c', text: 'Ccc' },
  ];
  const after = [before[0]!, before[2]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.cursor(position(before, 'b', 2)),
  );

  assert.equal(selection.main.head, position(after, 'c', 0));
});

void test('末尾のカーソル行自体を削除すると直前行の末尾へ map する', () => {
  const before = [
    { id: 'a', text: 'Aaa' },
    { id: 'b', text: 'Bbb' },
  ];
  const after = [before[0]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.cursor(position(before, 'b', 2)),
  );

  assert.equal(selection.main.head, position(after, 'a', 3));
});

void test('同文行が複数あってもカーソルは残存する同じ行 ID へ追従する', () => {
  const before = [
    { id: 'first', text: 'same' },
    { id: 'second', text: 'same' },
    { id: 'third', text: 'same' },
  ];
  const after = [before[1]!, before[2]!];
  const selection = mappedSelection(
    before,
    after,
    EditorSelection.cursor(position(before, 'third', 2)),
  );

  assert.equal(selection.main.head, position(after, 'third', 2));
});
