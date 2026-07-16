import { EditorView } from '@codemirror/view';
import { highlightSpans } from '../highlight.ts';
import { transformPaste } from '../smartPaste.ts';

type UploadResult =
  | { kind: 'ok'; url: string }
  | { kind: 'error'; message: string };

type PasteOptions = {
  uploadFile: (file: File) => Promise<UploadResult>;
  onUploadError: (message: string) => void;
};

function transformText(view: EditorView, pasted: string, from: number, to: number): boolean {
  const docText = view.state.doc.toString();
  const transformed = transformPaste({
    docText,
    from,
    to,
    spans: highlightSpans(docText),
  }, pasted);
  if (transformed === null) return false;
  view.dispatch({
    changes: { from, to, insert: transformed },
    selection: { anchor: from + transformed.length },
  });
  return true;
}

function imageFile(files: FileList): File | undefined {
  return Array.from(files).find((file) => file.type.startsWith('image/'));
}

async function uploadAndInsert(
  view: EditorView,
  file: File,
  from: number,
  to: number,
  options: PasteOptions,
): Promise<void> {
  const startDoc = view.state.doc;
  const result = await options.uploadFile(file);
  if (result.kind === 'error') {
    options.onUploadError(result.message);
    return;
  }
  // アップロード中に編集があったら開始時の位置は信用できない。
  // 無関係のテキストを置換しないよう、現在のカーソル位置への挿入に切り替える。
  const changed = !view.state.doc.eq(startDoc);
  const range = changed ? view.state.selection.main : { from, to };
  view.dispatch({ changes: { from: range.from, to: range.to, insert: `[${result.url}]` } });
}

export function pasteHandlers(options: PasteOptions): ReturnType<typeof EditorView.domEventHandlers> {
  return EditorView.domEventHandlers({
    paste(event, view) {
      const data = event.clipboardData;
      if (data === null) return false;
      const file = imageFile(data.files);
      const range = view.state.selection.main;
      if (file !== undefined) {
        event.preventDefault();
        void uploadAndInsert(view, file, range.from, range.to, options);
        return true;
      }

      const pasted = data.getData('text/plain');
      const transformed = transformText(view, pasted, range.from, range.to);
      if (!transformed) return false;
      event.preventDefault();
      return true;
    },
    drop(event, view) {
      const data = event.dataTransfer;
      if (data === null) return false;
      const file = imageFile(data.files);
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return false;
      if (file !== undefined) {
        event.preventDefault();
        void uploadAndInsert(view, file, position, position, options);
        return true;
      }
      if (!transformText(view, data.getData('text/plain'), position, position)) return false;
      event.preventDefault();
      return true;
    },
  });
}
