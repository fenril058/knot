import type { PresentedLine, PresentedNode, SourceSpan } from '../../render/presentation.ts';

// 押した位置に caret を置く（#243）。閲覧表示の行も、編集表示の整形表示の行も、同じ PresentedLine
// から描いた DOM で、原文の位置は DOM に書き込まない。PresentedLine から描いた順の字と画像の並び
// （piece）を作り、DOM の text node と画像へ字の内容で突き合わせて、押した位置を原文の位置に直す。
// 突き合わせが合わない（閲覧表示を描いた後で本文が変わったなど）ときは位置を返さず、呼び出し側が
// 従来の位置を使う。

type TextPiece = { kind: 'text'; text: string; span: SourceSpan };
type AtomPiece = { kind: 'atom'; span: SourceSpan };
type Piece = TextPiece | AtomPiece;

export type AlignItem = { kind: 'text'; text: string } | { kind: 'atom' };
type TextEntry = { piece: TextPiece; start: number };
export type AlignedItem = { kind: 'text'; entries: TextEntry[] } | { kind: 'atom'; piece: AtomPiece };

// 行の DOM のうち、字下げ（.line-indent-prefix）と本文。閲覧表示の .line-row と、
// 編集表示の整形表示 widget は、どちらも本文を最後の子要素に置く。
export type LineElements = { prefix: Element | null; content: Element };
type DomPosition = { node: Node; offset: number };
// pastEnd は、本文の最後の字（か画像）より右を押したこと。原文の行末（] などの記法の後ろ）に置く。
export type ClickTarget = DomPosition & { pastEnd: boolean };

// oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かず分岐漏れを型エラーにする
function nodePieces(node: PresentedNode): Piece[] {
  switch (node.type) {
    case 'text':
    case 'code':
      return [{ kind: 'text', text: node.text, span: node.span }];
    case 'container':
    case 'link':
      return node.children.flatMap(nodePieces);
    case 'image':
    case 'video':
    case 'audio':
      return [{ kind: 'atom', span: node.span }];
  }
}

// 描いた順の piece。字下げは 1 段を全角空白 1 字で描くので、その 1 字を字下げの 1 字に対応させる。
export function linePieces(line: PresentedLine): Piece[] {
  const prefix: Piece[] = line.indent === 0
    ? []
    : [{
        kind: 'text',
        text: ' '.repeat(line.indent),
        span: { from: line.from, to: line.from + line.indent, verbatim: true },
      }];
  if (line.role === 'line') return [...prefix, ...line.nodes.flatMap(nodePieces)];
  if (line.role === 'tableRow') return [...prefix, ...line.cells.flat().flatMap(nodePieces)];
  return [...prefix, { kind: 'text', text: line.text, span: line.textSpan }];
}

// DOM の text node と画像の並びに piece を割り当てる。閲覧表示の HTML では隣り合う字の piece が
// 1 つの text node にまとまるので、text node の字を先頭から piece で埋めていく。
export function alignPieces(items: readonly AlignItem[], pieces: readonly Piece[]): AlignedItem[] | undefined {
  const queue = pieces.filter((piece) => piece.kind === 'atom' || piece.text !== '');
  const aligned: AlignedItem[] = [];
  let next = 0;
  for (const item of items) {
    if (item.kind === 'atom') {
      const piece = queue[next];
      if (piece?.kind !== 'atom') return undefined;
      aligned.push({ kind: 'atom', piece });
      next += 1;
      continue;
    }
    const entries: TextEntry[] = [];
    let start = 0;
    while (start < item.text.length) {
      const piece = queue[next];
      if (piece?.kind !== 'text' || !item.text.startsWith(piece.text, start)) return undefined;
      entries.push({ piece, start });
      start += piece.text.length;
      next += 1;
    }
    aligned.push({ kind: 'text', entries });
  }
  return next === queue.length ? aligned : undefined;
}

// text node の offset 字目の境界が、原文のどこに当たるか。piece の境界では前の piece の末尾を取る。
// 原文と字が対応しない piece は、前半なら原文の範囲の先頭、後半なら末尾に寄せる。
export function textPosition(entries: readonly TextEntry[], offset: number): number | undefined {
  let entry = entries[0];
  for (const candidate of entries) {
    if (candidate.start < offset) entry = candidate;
  }
  if (entry === undefined) return undefined;
  const { span, text } = entry.piece;
  const local = Math.min(Math.max(offset - entry.start, 0), text.length);
  if (span.verbatim) return span.from + local;
  return local * 2 < text.length ? span.from : span.to;
}

function itemStart(item: AlignedItem): number | undefined {
  return item.kind === 'atom' ? item.piece.span.from : textPosition(item.entries, 0);
}

function itemEnd(item: AlignedItem): number | undefined {
  if (item.kind === 'atom') return item.piece.span.to;
  const last = item.entries.at(-1);
  return last === undefined ? undefined : textPosition(item.entries, last.start + last.piece.text.length);
}

type DomItem = { kind: 'text'; node: Text } | { kind: 'atom'; node: Element };

function domItems(root: Element | null): DomItem[] {
  const items: DomItem[] = [];
  const visit = (node: Node): void => {
    if (node instanceof Text) {
      if (node.data !== '') items.push({ kind: 'text', node });
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.matches('img, video, audio')) {
      items.push({ kind: 'atom', node });
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  if (root !== null) visit(root);
  return items;
}

export function lineElements(root: Element): LineElements | undefined {
  const content = root.lastElementChild;
  if (content === null) return undefined;
  return { prefix: root.querySelector(':scope > .line-indent-prefix'), content };
}

// caretPositionFromPoint を持たないブラウザ（古い Safari）は caretRangeFromPoint を使う。
type CaretLookup = {
  caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function domPositionAt(x: number, y: number): DomPosition | undefined {
  const lookup: CaretLookup = document;
  const position = lookup.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = lookup.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : undefined;
}

// position が本文の最後の字（か画像）の後ろにあり、押した点がその右端より右か。
function isPastEnd(content: Element, position: DomPosition, x: number): boolean {
  const last = domItems(content).at(-1);
  if (last === undefined) return true;
  const range = document.createRange();
  range.setStart(position.node, position.offset);
  if (last.kind === 'atom') {
    return range.comparePoint(last.node, 0) < 0 && x > last.node.getBoundingClientRect().right;
  }
  const length = last.node.data.length;
  if (range.comparePoint(last.node, length) > 0) return false;
  const lastChar = document.createRange();
  lastChar.setStart(last.node, length - 1);
  lastChar.setEnd(last.node, length);
  const rect = Array.from(lastChar.getClientRects()).at(-1);
  return rect !== undefined && x > rect.right;
}

// 押した点の DOM 上の位置。本文より右（行末の余白）を押したときは、同じ高さの本文の右端で探す。
export function clickTarget(elements: LineElements, x: number, y: number): ClickTarget | undefined {
  const box = elements.content.getBoundingClientRect();
  const position = domPositionAt(Math.min(x, box.right - 1), y);
  if (position === undefined) return undefined;
  if (!elements.content.contains(position.node) && elements.prefix?.contains(position.node) !== true) return undefined;
  return { ...position, pastEnd: elements.content.contains(position.node) && isPastEnd(elements.content, position, x) };
}

// 行の DOM の字と画像の並びに、PresentedLine の piece を割り当てる。対応しないときは undefined。
function alignLine(line: PresentedLine, elements: LineElements): { items: DomItem[]; aligned: AlignedItem[] } | undefined {
  const items = [...domItems(elements.prefix), ...domItems(elements.content)];
  const aligned = alignPieces(
    items.map((item) => (item.kind === 'text' ? { kind: 'text', text: item.node.data } : { kind: 'atom' })),
    linePieces(line),
  );
  return aligned === undefined ? undefined : { items, aligned };
}

// 行の DOM が PresentedLine と同じ字と画像の並びで描かれているか（描いた後で本文が変わっていないか）。
export function matchesLine(line: PresentedLine, elements: LineElements): boolean {
  return alignLine(line, elements) !== undefined;
}

// 押した位置の原文の位置（文書の先頭から）。DOM と PresentedLine が対応しないときは undefined。
export function sourcePosition(line: PresentedLine, elements: LineElements, target: ClickTarget): number | undefined {
  const alignment = alignLine(line, elements);
  if (alignment === undefined) return undefined;
  const { items, aligned } = alignment;
  if (target.pastEnd) return line.to;
  const index = items.findIndex((item) => item.node === target.node);
  const hit = aligned[index];
  if (hit?.kind === 'text') return textPosition(hit.entries, target.offset);
  // 要素の子の間（画像の前後など）を指しているときは、その後ろにある最初の字か画像の先頭に置く。
  const range = document.createRange();
  range.setStart(target.node, target.offset);
  const after = items.findIndex((item) => range.comparePoint(item.node, 0) >= 0);
  if (after !== -1) return itemStart(aligned[after]!);
  const last = aligned.at(-1);
  return last === undefined ? line.to : itemEnd(last);
}

// selection の端の原文の位置。inLine は端が行の字下げか本文の中にあること。triple click で行を
// 選ぶと、終わりの端は次の行の頭（テロメア）に来る。本文の外の端は、本文より前なら行頭、
// 後ろなら行末にする。
export type SelectionPoint = { position: number; inLine: boolean };

export function selectionPoint(line: PresentedLine, elements: LineElements, node: Node, offset: number): SelectionPoint | undefined {
  if (elements.content.contains(node) || elements.prefix?.contains(node) === true) {
    const position = sourcePosition(line, elements, { node, offset, pastEnd: false });
    return position === undefined ? undefined : { position, inLine: true };
  }
  const range = document.createRange();
  range.setStart(node, offset);
  return { position: range.comparePoint(elements.prefix ?? elements.content, 0) >= 0 ? line.from : line.to, inLine: false };
}
