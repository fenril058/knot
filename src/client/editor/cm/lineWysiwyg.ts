import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { classifyUrl, isAttachmentUrl, isHostAllowed } from '../../../core/media.ts';
import { parsePageSyntax, type SyntaxBlock, type SyntaxNode } from '../../../core/syntax.ts';
import { pageHref } from '../../../core/title.ts';

export type LineWysiwygConfig = {
  project: string;
  allowedImageHosts: string[];
  allowedMediaHosts: string[];
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

function hasUriScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value);
}

function appendText(parent: ParentNode, text: string): void {
  parent.append(document.createTextNode(text));
}

function externalAnchor(url: string, label: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener noreferrer';
  anchor.textContent = label;
  return anchor;
}

function mediaElement(url: string, label: string | undefined, config: LineWysiwygConfig): Node {
  const isLocal = isAttachmentUrl(url);
  if (!isLocal && !isHttpUrl(url)) return document.createTextNode(label === undefined ? url : `${label} (${url})`);
  const hostname = isLocal ? '' : new URL(url).hostname;
  const kind = classifyUrl(url);
  if (kind === 'image' && (isLocal || isHostAllowed(hostname, config.allowedImageHosts))) {
    const image = document.createElement('img');
    image.src = url;
    image.alt = '';
    image.loading = 'lazy';
    return image;
  }
  if (kind === 'video' && (isLocal || isHostAllowed(hostname, config.allowedMediaHosts))) {
    const video = document.createElement('video');
    video.controls = true;
    const source = document.createElement('source');
    source.src = url;
    video.append(source);
    return video;
  }
  if (kind === 'audio' && (isLocal || isHostAllowed(hostname, config.allowedMediaHosts))) {
    const audio = document.createElement('audio');
    audio.controls = true;
    const source = document.createElement('source');
    source.src = url;
    audio.append(source);
    return audio;
  }
  return externalAnchor(url, label ?? url);
}

function appendNodes(parent: ParentNode, nodes: readonly SyntaxNode[], config: LineWysiwygConfig): void {
  for (const node of nodes) appendNode(parent, node, config);
}

function appendNode(parent: ParentNode, node: SyntaxNode, config: LineWysiwygConfig): void {
  switch (node.type) {
    case 'plain':
    case 'blank':
      appendText(parent, node.text);
      return;
    case 'helpfeel':
      appendText(parent, node.text);
      return;
    case 'code': {
      const code = document.createElement('code');
      code.textContent = node.text;
      parent.append(code);
      return;
    }
    case 'commandLine': {
      const code = document.createElement('code');
      code.textContent = node.symbol + node.text;
      parent.append(code);
      return;
    }
    case 'formula': {
      const code = document.createElement('code');
      code.textContent = node.formula;
      parent.append(code);
      return;
    }
    case 'strong': {
      const strong = document.createElement('strong');
      appendNodes(strong, node.nodes, config);
      parent.append(strong);
      return;
    }
    case 'quote': {
      const quote = document.createElement('span');
      quote.className = 'cm-wysiwyg-quote';
      appendNodes(quote, node.nodes, config);
      parent.append(quote);
      return;
    }
    case 'decoration': {
      const tag = node.decos.includes('/') ? 'em'
        : node.decos.includes('-') ? 'del'
          : node.decos.some((deco) => deco.startsWith('*')) ? 'strong' : 'span';
      const element = document.createElement(tag);
      appendNodes(element, node.nodes, config);
      parent.append(element);
      return;
    }
    case 'numberList': {
      const number = document.createElement('span');
      number.className = 'num-list';
      appendText(number, `${node.rawNumber}. `);
      appendNodes(number, node.nodes, config);
      parent.append(number);
      return;
    }
    case 'hashTag': {
      const anchor = document.createElement('a');
      anchor.href = pageHref(config.project, node.href);
      anchor.textContent = `#${node.href}`;
      parent.append(anchor);
      return;
    }
    case 'icon':
    case 'strongIcon': {
      if (node.pathType !== 'relative') {
        appendText(parent, `[${node.path}]`);
        return;
      }
      const anchor = document.createElement('a');
      anchor.href = pageHref(config.project, node.path);
      anchor.className = 'icon-link';
      anchor.textContent = `[${node.path}]`;
      parent.append(anchor);
      return;
    }
    case 'image':
    case 'strongImage':
      parent.append(mediaElement(node.src, undefined, config));
      return;
    case 'googleMap':
      appendText(parent, node.raw);
      return;
    case 'link': {
      if (node.pathType === 'relative') {
        const target = node.href.split('#')[0]!;
        const anchor = document.createElement('a');
        anchor.href = pageHref(config.project, target);
        anchor.textContent = node.content === '' ? target : node.content;
        parent.append(anchor);
        return;
      }
      if (isAttachmentUrl(node.href)) {
        parent.append(mediaElement(node.href, node.content === '' ? undefined : node.content, config));
        return;
      }
      if (isHttpUrl(node.href)) {
        parent.append(mediaElement(node.href, node.content === '' ? node.href : node.content, config));
        return;
      }
      appendText(parent, hasUriScheme(node.href) ? node.raw : node.content === '' ? node.href : `${node.content} (${node.href})`);
    }
  }
}

type DisplayLine = {
  number: number;
  from: number;
  to: number;
  source: string;
  indent: number;
  render: (parent: HTMLElement) => void;
};

function displayLines(state: EditorState, config: LineWysiwygConfig): DisplayLine[] {
  const source = state.doc.toString();
  const blocks = parsePageSyntax(source, { hasTitle: true });
  const result: DisplayLine[] = [];
  for (const block of blocks) appendBlockLines(result, block, state, config);
  return result;
}

function baseLine(state: EditorState, block: SyntaxBlock, offset: number): Omit<DisplayLine, 'render'> {
  const range = block.lineRanges[offset];
  if (range === undefined) throw new Error('syntax block line is missing');
  const line = state.doc.lineAt(range.from);
  return {
    number: line.number,
    from: range.from,
    to: range.to,
    source: state.sliceDoc(range.from, range.to),
    indent: /^\s*/.exec(line.text)?.[0].length ?? 0,
  };
}

function appendBlockLines(
  result: DisplayLine[],
  block: SyntaxBlock,
  state: EditorState,
  config: LineWysiwygConfig,
): void {
  if (block.type === 'title') {
    result.push({ ...baseLine(state, block, 0), indent: 0, render: (parent) => {
      const title = document.createElement('strong');
      title.className = 'cm-wysiwyg-title';
      title.textContent = block.text;
      parent.append(title);
    } });
    return;
  }
  if (block.type === 'line') {
    result.push({ ...baseLine(state, block, 0), indent: block.indent, render: (parent) => appendNodes(parent, block.nodes, config) });
    return;
  }
  if (block.type === 'codeBlock') {
    result.push({ ...baseLine(state, block, 0), render: (parent) => {
      const header = document.createElement('span');
      header.className = 'code-header';
      header.textContent = block.fileName;
      parent.append(header);
    } });
    const contents = block.content === '' ? [] : block.content.split('\n');
    for (let offset = 1; offset < block.lineRanges.length; offset += 1) {
      result.push({ ...baseLine(state, block, offset), render: (parent) => {
        const code = document.createElement('code');
        code.className = 'code-line';
        code.textContent = contents[offset - 1] ?? '';
        parent.append(code);
      } });
    }
    return;
  }
  result.push({ ...baseLine(state, block, 0), render: (parent) => {
    const header = document.createElement('span');
    header.className = 'table-header';
    header.textContent = block.fileName;
    parent.append(header);
  } });
  for (let offset = 1; offset < block.lineRanges.length; offset += 1) {
    const row = block.cells[offset - 1] ?? [];
    result.push({ ...baseLine(state, block, offset), render: (parent) => {
      const table = document.createElement('table');
      const tr = document.createElement('tr');
      for (const cell of row) {
        const td = document.createElement('td');
        appendNodes(td, cell, config);
        tr.append(td);
      }
      table.append(tr);
      parent.append(table);
    } });
  }
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

function linkHrefAt(state: EditorState, project: string): string | null {
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
    if (node?.type === 'hashTag') return pageHref(project, node.href);
    if (node?.type === 'link' && node.pathType === 'relative') {
      return pageHref(project, node.href.split('#')[0]!);
    }
    if (node?.type === 'link' && isHttpUrl(node.href)) return node.href;
  }
  return null;
}

function openLinkAtCursor(project: string): (view: EditorView) => boolean {
  return (view) => {
    const href = linkHrefAt(view.state, project);
    if (href === null) return false;
    window.location.assign(href);
    return true;
  };
}

class FormattedLineWidget extends WidgetType {
  readonly line: DisplayLine;

  constructor(line: DisplayLine) {
    super();
    this.line = line;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof FormattedLineWidget
      && other.line.number === this.line.number
      && other.line.from === this.line.from
      && other.line.to === this.line.to
      && other.line.source === this.line.source
      && other.line.indent === this.line.indent;
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('span');
    root.className = 'cm-wysiwyg-line';
    root.dataset.lineNumber = String(this.line.number);
    let content = root;
    for (let depth = 0; depth < this.line.indent; depth += 1) {
      const nested = document.createElement('span');
      nested.className = 'cm-wysiwyg-indent';
      content.append(nested);
      content = nested;
    }
    if (this.line.indent > 0) content.classList.add('cm-wysiwyg-indent-content');
    this.line.render(content);
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
  return [plugin, keymap.of([{ key: 'Mod-Enter', run: openLinkAtCursor(config.project) }])];
}
