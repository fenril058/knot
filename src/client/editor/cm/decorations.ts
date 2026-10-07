import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { highlightSpans } from '../highlight.ts';

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of highlightSpans(view.state.doc.toString())) {
    // 装飾の見た目（太字・斜体・打ち消し・強調の段階）は、記法の種類の見た目に重ねる。
    const names = new Set<string>([span.kind, ...(span.styles ?? [])]);
    builder.add(span.from, span.to, Decoration.mark({ class: Array.from(names, (name) => `cm-sb-${name}`).join(' ') }));
  }
  return builder.finish();
}

export const syntaxHighlighting = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.decorations = buildDecorations(update.view);
  }
}, {
  decorations: (plugin) => plugin.decorations,
});
