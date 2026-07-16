import { RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { highlightSpans } from '../highlight.ts';

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of highlightSpans(view.state.doc.toString())) {
    builder.add(span.from, span.to, Decoration.mark({ class: `cm-sb-${span.kind}` }));
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
