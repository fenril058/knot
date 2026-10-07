import { EditorSelection, findClusterBreak, type EditorState, type SelectionRange } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';

// double click で選ぶ語（#261）。Cosense と同じく、同じ種類の字が続く範囲を語にする。
// CodeMirror の既定は字を語・空白・その他の 3 つに分けるだけで、漢字・ひらがな・カタカナがどれも
// 語の字になり、日本語の行では句読点に当たるまで続けて選んでしまう。Cosense で観測した区切りに
// 合わせて、語の字を漢字・ひらがな・カタカナ（長音符を含む）と、それ以外の字（英数字と _）に分ける。
// 々 は漢字に含めない（Cosense は「色々」の「色」と「々」を別の語として選ぶ）。
type CharClass = 'space' | 'hiragana' | 'katakana' | 'kanji' | 'word' | 'other';

function charClass(char: string): CharClass {
  if (/^\s/u.test(char)) return 'space';
  if (/^[ぁ-ゟ]/u.test(char)) return 'hiragana';
  if (/^[゠-ヿㇰ-ㇿｦ-ﾟ]/u.test(char)) return 'katakana';
  if (/^[㐀-䶿一-鿿豈-﫿\u{20000}-\u{3134f}]/u.test(char)) return 'kanji';
  if (/^[\p{Alphabetic}\p{Number}_]/u.test(char)) return 'word';
  return 'other';
}

// text の index 字目の境界の後ろの字を含む語の範囲。Cosense は、押した点にいちばん近い字の境界
// （caret を置く位置）の後ろの字の語を選ぶ。字の右半分を押すと、次の字の語になる。行末では前の字を
// 取る。CodeMirror の double click（groupAt）と同じく、字の区切り（grapheme cluster）で進む。
export function wordRange(text: string, index: number): { from: number; to: number } {
  if (text.length === 0) return { from: index, to: index };
  const atEnd = index === text.length;
  let from = atEnd ? findClusterBreak(text, index, false) : index;
  let to = atEnd ? index : findClusterBreak(text, index);
  const kind = charClass(text.slice(from, to));
  while (from > 0) {
    const previous = findClusterBreak(text, from, false);
    if (charClass(text.slice(previous, from)) !== kind) break;
    from = previous;
  }
  while (to < text.length) {
    const next = findClusterBreak(text, to);
    if (charClass(text.slice(to, next)) !== kind) break;
    to = next;
  }
  return { from, to };
}

function wordSelectionRange(state: EditorState, pos: number): SelectionRange {
  const line = state.doc.lineAt(pos);
  const { from, to } = wordRange(line.text, pos - line.from);
  return EditorSelection.range(line.from + from, line.from + to);
}

// 編集表示の double click。CodeMirror の既定の mouse selection（basicMouseSelection）の double click と
// 同じ動き（押したまま動かすと語の単位で広げる、shift で今の選択を広げる）で、語の区切りだけを変える。
export const doubleClickWordSelection = EditorView.mouseSelectionStyle.of((view, event) => {
  if (event.button !== 0 || event.detail !== 2) return null;
  let start = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  let startSelection = view.state.selection;
  return {
    update(update: ViewUpdate): void {
      if (!update.docChanged) return;
      start = update.changes.mapPos(start);
      startSelection = startSelection.map(update.changes);
    },
    get(current: MouseEvent, extend: boolean, multiple: boolean): EditorSelection {
      const point = view.posAtCoords({ x: current.clientX, y: current.clientY }, false);
      let range = wordSelectionRange(view.state, point);
      if (point !== start && !extend) {
        const startRange = wordSelectionRange(view.state, start);
        const from = Math.min(startRange.from, range.from);
        const to = Math.max(startRange.to, range.to);
        range = from < range.from ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
      }
      if (extend) return startSelection.replaceRange(startSelection.main.extend(range.from, range.to));
      if (multiple) return startSelection.addRange(range);
      return EditorSelection.create([range]);
    },
  };
});
