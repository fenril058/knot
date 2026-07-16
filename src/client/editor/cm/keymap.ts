import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';
import { indentLine, dedentLine } from '../indent.ts';

function changeSelectedLines(
  transform: (text: string) => string,
): KeyBinding['run'] {
  return (view) => {
    const lineStarts = new Set<number>();
    for (const range of view.state.selection.ranges) {
      const first = view.state.doc.lineAt(range.from).number;
      const last = view.state.doc.lineAt(range.to).number;
      for (let number = first; number <= last; number += 1) {
        lineStarts.add(view.state.doc.line(number).from);
      }
    }

    const changes: ChangeSpec[] = [];
    for (const from of lineStarts) {
      const line = view.state.doc.lineAt(from);
      const transformed = transform(line.text);
      if (transformed.length === line.text.length + 1 && transformed.endsWith(line.text)) {
        changes.push({ from, insert: transformed[0] });
      } else if (transformed.length === line.text.length - 1 && line.text.endsWith(transformed)) {
        changes.push({ from, to: from + 1 });
      }
    }
    if (changes.length !== 0) view.dispatch({ changes });
    return true;
  };
}

function insertIcon(userName: string): KeyBinding['run'] {
  return (view) => {
    view.dispatch(view.state.replaceSelection(`[${userName}.icon]`));
    return true;
  };
}

const wrapStrong: KeyBinding['run'] = (view) => {
  const transaction = view.state.changeByRange((range) => {
    const selected = view.state.sliceDoc(range.from, range.to);
    const insert = `[* ${selected}]`;
    const anchor = range.from + 3;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: selected.length === 0
        ? EditorSelection.cursor(anchor)
        : EditorSelection.range(anchor, anchor + selected.length),
    };
  });
  view.dispatch(transaction);
  return true;
};

export function editorKeymap(userName: string): KeyBinding[] {
  return [
    { key: 'Mod-i', run: insertIcon(userName) },
    { key: 'Mod-b', run: wrapStrong },
    { key: 'Tab', run: changeSelectedLines(indentLine) },
    { key: 'Shift-Tab', run: changeSelectedLines(dedentLine) },
  ];
}
