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
  indentMark,
  isQuoteLine,
  knownPageMap,
  presentationLines,
  type IndentMark,
  type KnownPage,
  type PresentedLine,
  type PresentedNode,
} from '../../../render/presentation.ts';
import { clickTarget, lineElements, sourcePosition } from '../caretPosition.ts';

export type LineWysiwygConfig = {
  project: string;
  allowedImageHosts: string[];
  allowedMediaHosts: string[];
  knownPages: KnownPage[];
  // 閲覧表示で描かれた画像の大きさ（imageSizeKey ごと）。編集表示は img を作り直すので、
  // ブラウザがキャッシュから同期的に再利用できないと、読み込みが終わるまで画像の行が縮む (#211)。
  imageSizes?: ReadonlyMap<string, ImageSize>;
};

export type ImageSize = { width: number; height: number };

// 同じ画像でも、本文の画像とアイコンでは描かれる大きさが違うので、class と組にして引く。
export function imageSizeKey(src: string, className: string): string {
  return `${className}\n${src}`;
}

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

function appendNode(parent: ParentNode, node: PresentedNode, imageSizes: ReadonlyMap<string, ImageSize>): void {
  switch (node.type) {
    case 'text':
      parent.append(document.createTextNode(node.text));
      return;
    case 'code': {
      const code = document.createElement('code');
      if (node.className !== undefined) code.className = node.className;
      code.textContent = node.text;
      parent.append(code);
      return;
    }
    case 'container': {
      // 引用行は閲覧表示（src/render/render.ts）と同じ blockquote で描く。q は inline で
      // 引用符も付くため、要素を変えると字下げも行の高さも色も揃わない。
      const container = document.createElement(node.kind === 'quote' ? 'blockquote' : node.kind);
      if (node.className !== undefined) container.className = node.className;
      for (const child of node.children) appendNode(container, child, imageSizes);
      parent.append(container);
      return;
    }
    case 'link': {
      const anchor = document.createElement('a');
      anchor.href = node.href;
      if (node.className !== undefined) anchor.className = node.className;
      if (node.external) anchor.rel = 'noopener noreferrer';
      for (const child of node.children) appendNode(anchor, child, imageSizes);
      parent.append(anchor);
      return;
    }
    case 'image': {
      const image = document.createElement('img');
      image.src = node.src;
      image.alt = node.alt;
      if (node.className !== undefined) image.className = node.className;
      const size = imageSizes.get(imageSizeKey(node.src, node.className ?? ''));
      if (size !== undefined) {
        // 閲覧表示で描かれた大きさで場所を取る。原寸ではなく描かれた大きさにするのは、本文の
        // 画像には CSS の上限（高さ 300px など）があり、原寸と上限の組み合わせでは横長の画像の
        // 高さが閲覧時と変わるため。小数の大きさを保つよう属性ではなく style に置く。
        image.style.width = `${size.width}px`;
        image.style.height = `${size.height}px`;
        // 場所取りは読み込みまで。取り直した画像の大きさが閲覧時と違っても、
        // 読み込み後は画像そのものの大きさと CSS の規則に従わせる。
        const release = (): void => {
          image.style.removeProperty('width');
          image.style.removeProperty('height');
        };
        image.addEventListener('load', release, { once: true });
        image.addEventListener('error', release, { once: true });
      }
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

// 字下げした行の caret を置く位置。字下げの後ろ（本文の先頭）に置き、入力で字下げを崩さない。
function textStart(line: PresentedLine): number {
  return line.role === 'line' ? line.from + line.indent : line.from;
}

// 編集を始めるときに caret を置く位置。閲覧表示の行を押したときも、整形表示の行を押したときと
// 同じく、字下げした行では本文の先頭に置く。
export function editStartPosition(state: EditorState, lineNumber: number): number {
  const line = state.doc.line(lineNumber);
  try {
    const block = parsePageSyntax(state.doc.toString(), { hasTitle: true })
      .find((candidate) => candidate.range.from === line.from);
    return block?.type === 'line' ? line.from + block.indent : line.from;
  } catch {
    return line.from;
  }
}

// カーソル行の字下げ。字下げの空白 1 文字ずつを、整形表示の 1 段と同じ幅で描く（#241）。
// 空白は文書に残るので、Tab / Backspace / Enter / undo / IME による編集の意味は変わらない。
// 最後の 1 文字の widget が、整形表示と同じ位置に行頭の印を描く。
class IndentSpaceWidget extends WidgetType {
  readonly mark: IndentMark | undefined;

  constructor(mark: IndentMark | undefined) {
    super();
    this.mark = mark;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof IndentSpaceWidget && other.mark === this.mark;
  }

  toDOM(): HTMLElement {
    const space = document.createElement('span');
    space.className = this.mark === undefined ? 'cm-indent-space' : `cm-indent-space mark-${this.mark}`;
    space.ariaHidden = 'true';
    return space;
  }
}

class FormattedLineWidget extends WidgetType {
  readonly line: PresentedLine;
  readonly imageSizes: ReadonlyMap<string, ImageSize>;

  constructor(line: PresentedLine, imageSizes: ReadonlyMap<string, ImageSize>) {
    super();
    this.line = line;
    this.imageSizes = imageSizes;
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
      // \u95b2\u89a7\u8868\u793a\u306e .line-row \u3068\u540c\u3058\u304f\u3001\u5b57\u4e0b\u3052\u3068\u672c\u6587\u3092\u4e26\u3079\u3066\u672c\u6587\u3092\u5b57\u4e0b\u3052\u306e\u4f4d\u7f6e\u3067\u6298\u308a\u8fd4\u3059\u3002
      root.classList.add('cm-wysiwyg-indented');
      const prefix = document.createElement('span');
      prefix.className = 'line-indent-prefix cm-wysiwyg-indent-prefix';
      prefix.ariaHidden = 'true';
      prefix.textContent = '\u2003'.repeat(this.line.indent);
      root.append(prefix);
    }
    const content = document.createElement('span');
    if (this.line.indent > 0) {
      content.classList.add('cm-wysiwyg-indent-content');
      const mark = indentMark(this.line);
      if (mark !== 'dot') content.classList.add(`mark-${mark}`);
    }
    if (this.line.role === 'title') {
      // 閲覧表示の h1 と同じく太字にしない。字の大きさと行送りは行（.cm-title-line）が持つ。
      content.textContent = this.line.text;
    } else if (this.line.role === 'line') {
      // 引用の帯も、閲覧表示と同じく行の幅いっぱいに引けるようにする。
      if (isQuoteLine(this.line)) root.classList.add('cm-wysiwyg-quote-line');
      for (const node of this.line.nodes) appendNode(content, node, this.imageSizes);
    } else if (this.line.role === 'codeHeader' || this.line.role === 'tableHeader') {
      // 閲覧表示と同じく、見出しは名前だけを札にする。
      const kind = this.line.role === 'codeHeader' ? 'code' : 'table';
      const header = document.createElement('span');
      header.className = `${kind}-header`;
      const label = document.createElement('span');
      label.className = `${kind}-block-start`;
      label.textContent = this.line.text;
      header.append(label);
      content.append(header);
    } else if (this.line.role === 'codeLine') {
      // 閲覧表示の block の帯と同じく、行の幅いっぱいに帯を引けるようにする。
      root.classList.add('cm-wysiwyg-code-line');
      const code = document.createElement('code');
      code.className = 'code-line';
      code.textContent = this.line.text;
      content.append(code);
    } else if (this.line.role === 'tableRow') {
      const table = document.createElement('table');
      const tr = document.createElement('tr');
      for (const cell of this.line.cells) {
        const td = document.createElement('td');
        for (const node of cell) appendNode(td, node, this.imageSizes);
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
      // 押した字の位置に caret を置く。DOM と行の対応が取れないときは本文の先頭に置く。
      const elements = lineElements(root);
      const click = elements === undefined ? undefined : clickTarget(elements, event.clientX, event.clientY);
      const anchor = elements === undefined || click === undefined ? undefined : sourcePosition(this.line, elements, click);
      view.dispatch({ selection: { anchor: anchor ?? textStart(this.line) }, scrollIntoView: true });
      view.focus();
    });
    return root;
  }
}

function buildDecorations(view: EditorView, config: LineWysiwygConfig): DecorationSet {
  const editing = editingLineNumbers(view.state);
  const imageSizes = config.imageSizes ?? new Map<string, ImageSize>();
  const builder = new RangeSetBuilder<Decoration>();
  try {
    for (const line of displayLines(view.state, config)) {
      // SSR の h1 は Editor 起動時に置換されるため、編集中も先頭行を見出しとして公開する。
      // 字の大きさは行に掛ける。閲覧表示では h1 が行そのものなので、行の高さの計算も
      // 原文表示に切り替えたときの字の大きさも、こちら側だけで合う。
      if (line.role === 'title') {
        builder.add(line.from, line.from, Decoration.line({
          class: 'cm-title-line',
          attributes: { role: 'heading', 'aria-level': '1' },
        }));
      }
      // コードブロックの行の高さも行に掛ける。カーソルが入って原文表示になっても変わらない。
      if (line.role === 'codeHeader' || line.role === 'codeLine') {
        builder.add(line.from, line.from, Decoration.line({ class: 'code-block-line' }));
      }
      if (editing.has(line.number)) {
        if (line.role === 'line' && line.indent > 0) {
          // 段数は custom property で渡す。CodeMirror は line decoration の style を
          // style.cssText（CSSOM）で書くので、style 属性と違って CSP の style-src に止められない。
          builder.add(line.from, line.from, Decoration.line({
            class: 'cm-active-indent',
            attributes: { style: `--indent-level: ${line.indent}` },
          }));
          const mark = indentMark(line);
          for (let offset = 0; offset < line.indent; offset += 1) {
            builder.add(line.from + offset, line.from + offset + 1, Decoration.replace({
              widget: new IndentSpaceWidget(offset === line.indent - 1 ? mark : undefined),
            }));
          }
        }
        continue;
      }
      const widget = new FormattedLineWidget(line, imageSizes);
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
