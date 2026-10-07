import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { titleLc } from '../../../core/title.ts';
import { knownPageMap, type KnownPage } from '../../../render/presentation.ts';
import { highlightSpans, type IsKnownTitle } from '../highlight.ts';

function buildDecorations(view: EditorView, isKnownTitle: IsKnownTitle): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const span of highlightSpans(view.state.doc.toString(), isKnownTitle)) {
    // 装飾の見た目（太字・斜体・打ち消し・強調の段階）は、記法の種類の見た目に重ねる。
    const names = new Set<string>([span.kind, ...(span.styles ?? [])]);
    builder.add(span.from, span.to, Decoration.mark({ class: Array.from(names, (name) => `cm-sb-${name}`).join(' ') }));
  }
  return builder.finish();
}

// カーソル行の原文表示の、記法ごとの見た目。ページがあるかどうかは閲覧表示と同じ一覧で決める。
export function syntaxHighlighting(knownPages: readonly KnownPage[]): Extension {
  const known = knownPageMap(knownPages);
  const isKnownTitle: IsKnownTitle = (title) => known.has(titleLc(title));
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, isKnownTitle);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged) this.decorations = buildDecorations(update.view, isKnownTitle);
    }
  }, {
    decorations: (plugin) => plugin.decorations,
  });
}
