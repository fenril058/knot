import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { parsePageSyntax, type SyntaxNode } from '../../../core/syntax.ts';
import { pageHref, titleLc } from '../../../core/title.ts';
import {
  knownPageMap,
  presentationLines,
  type KnownPage,
  type PresentedLine,
  type PresentedNode,
} from '../../../render/presentation.ts';

export type LineWysiwygConfig = {
  project: string;
  allowedImageHosts: string[];
  allowedMediaHosts: string[];
  knownPages: KnownPage[];
};

export function editingLineNumbers(state: EditorState): Set<number> {
  const numbers = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) numbers.add(number);
  }
  return numbers;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function appendNode(parent: ParentNode, node: PresentedNode): void {
  switch (node.type) {
    case 'text':
      parent.append(document.createTextNode(node.text));
      return;
    case 'code': {
      const code = document.createElement('code');
      code.textContent = node.text;
      parent.append(code);
      return;
    }
    case 'container': {
      const tag = node.kind === 'quote' ? 'q' : node.kind;
      const container = document.createElement(tag);
      if (node.kind === 'quote') container.className = 'cm-wysiwyg-quote';
      if (node.className !== undefined) container.className = node.className;
      for (const child of node.children) appendNode(container, child);
      parent.append(container);
      return;
    }
    case 'link': {
      const anchor = document.createElement('a');
      anchor.href = node.href;
      if (node.className !== undefined) anchor.className = node.className;
      if (node.external) anchor.rel = 'noopener noreferrer';
      for (const child of node.children) appendNode(anchor, child);
      parent.append(anchor);
      return;
    }
    case 'image': {
      const image = document.createElement('img');
      image.src = node.src;
      image.alt = node.alt;
      if (node.className !== undefined) image.className = node.className;
      if (node.lazy) image.loading = 'lazy';
      parent.append(image);
      return;
    }
    case 'video':
    case 'audio': {
      const media = document.createElement(node.type);
      media.controls = true;
      const source = document.createElement('source');
      source.src = node.src;
      media.append(source);
      parent.append(media);
      return;
    }
  }
}

function displayLines(state: EditorState, config: LineWysiwygConfig): PresentedLine[] {
  return presentationLines(state.doc.toString(), knownPageMap(config.knownPages), config.project, config);
}

function linkNodeAt(nodes: readonly SyntaxNode[], position: number): SyntaxNode | null {
  for (const node of nodes) {
    if (position < node.range.from || position >= node.range.to) continue;
    if ('nodes' in node) {
      const child = linkNodeAt(node.nodes, position);
      if (child !== null) return child;
    }
    if (node.type === 'link' || node.type === 'hashTag') return node;
  }
  return null;
}

function linkHrefAt(
  state: EditorState,
  project: string,
  knownPages: ReadonlyMap<string, KnownPage>,
): string | null {
  const selection = state.selection.main;
  if (!selection.empty) return null;
  const position = selection.head;
  const blocks = parsePageSyntax(state.doc.toString(), { hasTitle: true });
  for (const block of blocks) {
    const node = block.type === 'line'
      ? linkNodeAt(block.nodes, position)
      : block.type === 'table'
        ? linkNodeAt(block.cells.flat(2), position)
        : null;
    if (node?.type === 'hashTag') {
      const target = knownPages.get(titleLc(node.href))?.title ?? node.href;
      return pageHref(project, target);
    }
    if (node?.type === 'link' && node.pathType === 'relative') {
      const rawTarget = node.href.split('#')[0]!;
      const target = knownPages.get(titleLc(rawTarget))?.title ?? rawTarget;
      return pageHref(project, target);
    }
    if (node?.type === 'link' && isHttpUrl(node.href)) return node.href;
  }
  return null;
}

function openLinkAtCursor(config: LineWysiwygConfig): (view: EditorView) => boolean {
  const knownPages = knownPageMap(config.knownPages);
  return (view) => {
    const href = linkHrefAt(view.state, config.project, knownPages);
    if (href === null) return false;
    window.location.assign(href);
    return true;
  };
}

class FormattedLineWidget extends WidgetType {
  readonly line: PresentedLine;

  constructor(line: PresentedLine) {
    super();
    this.line = line;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof FormattedLineWidget
      && other.line.number === this.line.number
      && other.line.from === this.line.from
      && other.line.to === this.line.to
      && other.line.source === this.line.source
      && other.line.indent === this.line.indent
      && other.line.renderKey === this.line.renderKey;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('span');
    root.className = 'cm-wysiwyg-line';
    root.dataset.lineNumber = String(this.line.number);
    if (this.line.indent > 0) {
      const prefix = document.createElement('span');
      prefix.className = 'line-indent-prefix cm-wysiwyg-indent-prefix';
      prefix.ariaHidden = 'true';
      prefix.textContent = '\u2003'.repeat(this.line.indent);
      root.append(prefix);
    }
    const content = document.createElement('span');
    if (this.line.indent > 0) content.classList.add('cm-wysiwyg-indent-content');
    if (this.line.role === 'title') {
      const title = document.createElement('strong');
      title.className = 'cm-wysiwyg-title';
      title.textContent = this.line.text;
      content.append(title);
    } else if (this.line.role === 'line') {
      for (const node of this.line.nodes) appendNode(content, node);
    } else if (this.line.role === 'codeHeader' || this.line.role === 'tableHeader') {
      const header = document.createElement('span');
      header.className = this.line.role === 'codeHeader' ? 'code-header' : 'table-header';
      header.textContent = this.line.text;
      content.append(header);
    } else if (this.line.role === 'codeLine') {
      const code = document.createElement('code');
      code.className = 'code-line';
      code.textContent = this.line.text;
      content.append(code);
    } else if (this.line.role === 'tableRow') {
      const table = document.createElement('table');
      const tr = document.createElement('tr');
      for (const cell of this.line.cells) {
        const td = document.createElement('td');
        for (const node of cell) appendNode(td, node);
        tr.append(td);
      }
      table.append(tr);
      content.append(table);
    } else {
      throw new Error('unknown presented line role');
    }
    root.append(content);
    root.addEventListener('mousedown', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('a') !== null) return;
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.line.from }, scrollIntoView: true });
      view.focus();
    });
    return root;
  }
}

function buildDecorations(view: EditorView, config: LineWysiwygConfig): DecorationSet {
  const editing = editingLineNumbers(view.state);
  const builder = new RangeSetBuilder<Decoration>();
  try {
    for (const line of displayLines(view.state, config)) {
      if (editing.has(line.number)) continue;
      const widget = new FormattedLineWidget(line);
      if (line.from === line.to) {
        builder.add(line.from, line.to, Decoration.widget({ widget }));
      } else {
        builder.add(line.from, line.to, Decoration.replace({ widget }));
      }
    }
  } catch {
    return Decoration.none;
  }
  return builder.finish();
}

export function lineWysiwyg(config: LineWysiwygConfig): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view, config);
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet) this.decorations = buildDecorations(update.view, config);
    }
  }, {
    decorations: (value) => value.decorations,
  });
  return [
    EditorState.allowMultipleSelections.of(true),
    plugin,
    keymap.of([{ key: 'Mod-Enter', run: openLinkAtCursor(config) }]),
  ];
}
