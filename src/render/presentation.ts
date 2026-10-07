import { classifyUrl, isAllowedImageUrl, isAttachmentUrl, isHostAllowed } from '../core/media.ts';
import { parsePageSyntax, type SourceRange, type SyntaxNode } from '../core/syntax.ts';
import { pageHref, titleLc } from '../core/title.ts';

export type KnownPage = { title: string; image: string | null };
export type RenderConfig = { allowedImageHosts: string[]; allowedMediaHosts: string[] };

// 描いた字や画像が、原文（文書の先頭からの位置）のどこから来たか。押した位置に caret を置くのに使う。
// verbatim なら字が原文そのままで、i 字目は from + i の字に当たる。そうでない node（画像や、
// アイコンの代わりに描く [name] のように原文と違う字）は、範囲の両端にだけ対応させる。
export type SourceSpan = { from: number; to: number; verbatim: boolean };

export type PresentedNode =
  | { type: 'text'; text: string; span: SourceSpan }
  | { type: 'code'; text: string; className?: string; span: SourceSpan }
  | { type: 'container'; kind: 'span' | 'strong' | 'em' | 'del' | 'quote'; className?: string; children: PresentedNode[] }
  | { type: 'link'; href: string; className?: string; external: boolean; children: PresentedNode[] }
  | { type: 'image'; src: string; alt: string; className?: string; lazy: boolean; span: SourceSpan }
  | { type: 'video' | 'audio'; src: string; span: SourceSpan };

type PresentedLineBase = {
  number: number;
  from: number;
  to: number;
  source: string;
  indent: number;
  renderKey: string;
};

export type PresentedLine = PresentedLineBase & (
  | { role: 'title' | 'codeHeader' | 'codeLine' | 'tableHeader'; text: string; textSpan: SourceSpan }
  | { role: 'line'; nodes: PresentedNode[] }
  // table は表の見出しの行番号。同じ表の行の列の幅を揃えるのに使う（#276）。
  | { role: 'tableRow'; cells: PresentedNode[][]; table: number }
);

// 字下げした行の行頭の印。Cosense と同じく、引用行と番号付きの行は横線にし、
// コードブロックの本文行と表の行には付けない。閲覧表示と編集表示がこの 1 つの規則を使う。
export type IndentMark = 'dot' | 'dash' | 'none';

export function indentMark(line: PresentedLine): IndentMark {
  if (line.role === 'codeLine' || line.role === 'tableRow') return 'none';
  if (line.role !== 'line') return 'dot';
  if (isQuoteLine(line)) return 'dash';
  const first = line.nodes[0];
  return first?.type === 'container' && first.className === 'num-list' ? 'dash' : 'dot';
}

// 行全体が引用の行。引用は行頭の > から行末までなので、先頭の node が引用なら行全体が引用になる。
export function isQuoteLine(line: PresentedLine): boolean {
  if (line.role !== 'line') return false;
  const first = line.nodes[0];
  return first?.type === 'container' && first.kind === 'quote';
}

// 行の中身がリンクと埋め込み（動画・音声）と空白だけの行。リンクが行末まで届くと、行を押して
// 編集を始める面が残らない（#186）。閲覧表示と編集表示は、この行にだけ行末の余白を置く（#245）。
export function isLinkOnlyLine(line: PresentedLine): boolean {
  if (line.role !== 'line') return false;
  let links = 0;
  const onlyLinks = (nodes: readonly PresentedNode[]): boolean => nodes.every((node) => {
    if (node.type === 'link' || node.type === 'video' || node.type === 'audio') {
      links += 1;
      return true;
    }
    if (node.type === 'text') return node.text.trim() === '';
    return node.type === 'container' && onlyLinks(node.children);
  });
  return onlyLinks(line.nodes) && links > 0;
}

export function knownPageMap(pages: readonly KnownPage[]): Map<string, KnownPage> {
  return new Map(pages.map((page) => [titleLc(page.title), page]));
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

const text = (value: string, span: SourceSpan): PresentedNode => ({ type: 'text', text: value, span });

function wholeSpan(node: SyntaxNode): SourceSpan {
  return { from: node.range.from, to: node.range.to, verbatim: false };
}

// node の原文の offset 字目から value がそのまま続くなら、字ごとに対応させる。
// 続かないときは node 全体に対応させるので、位置の計算を誤っても caret が node の外へは出ない。
function spanAt(node: SyntaxNode, value: string, offset: number): SourceSpan {
  return offset >= 0 && node.raw.startsWith(value, offset)
    ? { from: node.range.from + offset, to: node.range.from + offset + value.length, verbatim: true }
    : wholeSpan(node);
}

// リンクのラベルが原文のどこにあるか。[URL ラベル] ならラベルは ] の直前、[ラベル URL] なら先頭側にある。
function labelSpan(node: SyntaxNode & { type: 'link' }, label: string): SourceSpan {
  if (label === node.href || !node.raw.startsWith(`[${node.href}`)) return spanAt(node, label, node.raw.indexOf(label));
  return spanAt(node, label, node.raw.length - 1 - label.length);
}

// 原文の行の末尾と一致する字（見出しの名前、コードの行、タイトル）。code: などの接頭辞と字下げは描かない。
function suffixSpan(source: string, range: SourceRange, value: string): SourceSpan {
  return source.slice(range.from, range.to).endsWith(value)
    ? { from: range.to - value.length, to: range.to, verbatim: true }
    : { from: range.from, to: range.to, verbatim: false };
}

function externalLink(url: string, label: string, span: SourceSpan, external = true): PresentedNode {
  return { type: 'link', href: url, external, children: [text(label, span)] };
}

// [*** x] の強調の段階。parser は *-3 のように表す。強調でなければ undefined。
// 編集表示のカーソル行（client/editor/highlight.ts）も同じ段階で描く。
export function strongLevel(decos: readonly string[]): number | undefined {
  for (const deco of decos) {
    const match = /^\*-(\d+)$/.exec(deco);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

// strong は [[画像]]。Cosense と同じく高さの上限を外した大きい画像として描く。
// label は字で描くときの原文の位置（label が無ければ url の位置）、media は node 全体。
function presentMedia(
  url: string,
  label: string | undefined,
  config: RenderConfig,
  spans: { label: SourceSpan; media: SourceSpan },
  strong = false,
): PresentedNode {
  const isLocal = isAttachmentUrl(url);
  if (!isLocal && !isHttpUrl(url)) {
    return label === undefined ? text(url, spans.label) : text(`${label} (${url})`, spans.media);
  }
  const hostname = isLocal ? '' : new URL(url).hostname;
  const kind = classifyUrl(url);
  if (kind === 'image' && (isLocal || isHostAllowed(hostname, config.allowedImageHosts))) {
    return strong
      ? { type: 'image', src: url, alt: '', className: 'strong-image', lazy: true, span: spans.media }
      : { type: 'image', src: url, alt: '', lazy: true, span: spans.media };
  }
  if (kind === 'video' && (isLocal || isHostAllowed(hostname, config.allowedMediaHosts))) {
    return { type: 'video', src: url, span: spans.media };
  }
  if (kind === 'audio' && (isLocal || isHostAllowed(hostname, config.allowedMediaHosts))) {
    return { type: 'audio', src: url, span: spans.media };
  }
  return externalLink(url, label ?? url, spans.label, !isLocal);
}

function presentNodes(
  nodes: readonly SyntaxNode[],
  knownPages: ReadonlyMap<string, KnownPage>,
  project: string,
  config: RenderConfig,
): PresentedNode[] {
  return nodes.map((node) => presentNode(node, knownPages, project, config));
}

// oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かず分岐漏れを型エラーにする
function presentNode(
  node: SyntaxNode,
  knownPages: ReadonlyMap<string, KnownPage>,
  project: string,
  config: RenderConfig,
): PresentedNode {
  const children = (nodes: readonly SyntaxNode[]): PresentedNode[] => presentNodes(nodes, knownPages, project, config);
  switch (node.type) {
    case 'plain':
      return text(node.text, spanAt(node, node.text, 0));
    // [ ] の中の空白と、? の後ろの字。
    case 'blank':
      return text(node.text, spanAt(node, node.text, 1));
    case 'helpfeel':
      return text(node.text, spanAt(node, node.text, node.raw.length - node.text.length));
    case 'code':
      return { type: 'code', text: node.text, span: spanAt(node, node.text, 1) };
    // コマンドラインと数式もコードの見た目で描く。バッククオートで囲んだコードと区別する。
    // parser は記号の直後の空白を 1 つ落とすので、原文（$ git reset）のまま描く。
    case 'commandLine':
      return { type: 'code', text: node.raw, className: 'cli', span: spanAt(node, node.raw, 0) };
    // [$ 数式] の数式は 3 字目から。
    case 'formula':
      return { type: 'code', text: node.formula, className: 'formula', span: spanAt(node, node.formula, 3) };
    case 'strong':
      return { type: 'container', kind: 'strong', children: children(node.nodes) };
    case 'quote':
      return { type: 'container', kind: 'quote', children: children(node.nodes) };
    case 'decoration': {
      if (
        node.decos.includes('"')
        && node.nodes.some(
          (child) => child.type === 'link' && child.pathType === 'absolute' && classifyUrl(child.href) === 'image',
        )
      ) {
        const images = node.nodes.filter(
          (child) => child.type === 'link' && child.pathType === 'absolute' && classifyUrl(child.href) === 'image',
        );
        return { type: 'container', kind: 'span', children: children(images) };
      }
      // 装飾は重ねられる（[/* x] は太字の斜体）。内側から打ち消し・斜体・強調の順に包む。
      const inner = children(node.nodes);
      let decorated: PresentedNode | undefined;
      const wrap = (kind: 'strong' | 'em' | 'del', className?: string): void => {
        const wrapped = decorated === undefined ? inner : [decorated];
        decorated = className === undefined
          ? { type: 'container', kind, children: wrapped }
          : { type: 'container', kind, className, children: wrapped };
      };
      if (node.decos.includes('-')) wrap('del');
      if (node.decos.includes('/')) wrap('em');
      const level = strongLevel(node.decos);
      // 段階 1 は本文と同じ大きさの太字なので class を付けない。
      if (level !== undefined) wrap('strong', level > 1 ? `level-${level}` : undefined);
      return decorated ?? { type: 'container', kind: 'span', children: inner };
    }
    case 'numberList':
      return {
        type: 'container',
        kind: 'span',
        className: 'num-list',
        children: [text(`${node.rawNumber}. `, spanAt(node, `${node.rawNumber}. `, 0)), ...children(node.nodes)],
      };
    case 'hashTag': {
      const entry = knownPages.get(titleLc(node.href));
      return {
        type: 'link',
        href: pageHref(project, entry?.title ?? node.href),
        className: entry === undefined ? 'empty-link' : 'page-link',
        external: false,
        children: [text(`#${node.href}`, spanAt(node, `#${node.href}`, 0))],
      };
    }
    case 'icon':
    case 'strongIcon': {
      if (node.pathType !== 'relative') {
        return {
          type: 'container',
          kind: 'span',
          className: 'icon-link',
          children: [text(`[${node.path}]`, wholeSpan(node))],
        };
      }
      const entry = knownPages.get(titleLc(node.path));
      // [[name.icon]] は Cosense と同じく大きいアイコンとして描く。
      const className = node.type === 'strongIcon' ? 'icon-img strong-icon' : 'icon-img';
      const linkChildren: PresentedNode[] = entry?.image && isAllowedImageUrl(entry.image, config.allowedImageHosts)
        ? [{ type: 'image', src: entry.image, alt: node.path, className, lazy: false, span: wholeSpan(node) }]
        : [text(`[${node.path}]`, wholeSpan(node))];
      return {
        type: 'link',
        href: pageHref(project, entry?.title ?? node.path),
        className: entry === undefined ? 'icon-link empty-link' : 'icon-link',
        external: false,
        children: linkChildren,
      };
    }
    case 'image':
    case 'strongImage': {
      const spans = { label: spanAt(node, node.src, node.raw.indexOf(node.src)), media: wholeSpan(node) };
      return presentMedia(node.src, undefined, config, spans, node.type === 'strongImage');
    }
    case 'googleMap':
      return text(node.raw, spanAt(node, node.raw, 0));
    case 'link': {
      if (hasUriScheme(node.href) && !isHttpUrl(node.href)) return text(node.raw, spanAt(node, node.raw, 0));
      if (node.pathType === 'relative') {
        const target = node.href.split('#')[0]!;
        const entry = knownPages.get(titleLc(target));
        const label = node.content === '' ? target : node.content;
        return {
          type: 'link',
          href: pageHref(project, entry?.title ?? target),
          className: entry === undefined ? 'empty-link' : 'page-link',
          external: false,
          children: [text(label, spanAt(node, label, node.content === '' ? 1 : node.raw.indexOf(label)))],
        };
      }
      const label = node.content === '' ? node.href : node.content;
      if (isHttpUrl(node.href)) {
        return presentMedia(node.href, label, config, { label: labelSpan(node, label), media: wholeSpan(node) });
      }
      if (isAttachmentUrl(node.href)) {
        const spans = { label: labelSpan(node, label), media: wholeSpan(node) };
        return presentMedia(node.href, node.content === '' ? undefined : node.content, config, spans);
      }
      return node.content === ''
        ? text(node.href, labelSpan(node, node.href))
        : text(`${node.content} (${node.href})`, wholeSpan(node));
    }
  }
}

function lineBase(source: string, range: SourceRange, number: number, indent: number) {
  return { number, from: range.from, to: range.to, source: source.slice(range.from, range.to), indent };
}

function withRenderKey<T extends Omit<PresentedLine, 'renderKey'>>(line: T): T & { renderKey: string } {
  return { ...line, renderKey: JSON.stringify(line) };
}

export function presentationLines(
  source: string,
  knownPages: ReadonlyMap<string, KnownPage>,
  project: string,
  config: RenderConfig,
): PresentedLine[] {
  const blocks = parsePageSyntax(source, { hasTitle: true });
  const result: PresentedLine[] = [];
  let number = 1;

  for (const block of blocks) {
    const firstRange = block.lineRanges[0];
    if (firstRange === undefined) throw new Error('syntax block line is missing');
    if (block.type === 'title') {
      result.push(withRenderKey({
        ...lineBase(source, firstRange, number, 0),
        role: 'title',
        text: block.text,
        textSpan: suffixSpan(source, firstRange, block.text),
      }));
      number += 1;
      continue;
    }
    if (block.type === 'line') {
      result.push(withRenderKey({
        ...lineBase(source, firstRange, number, block.indent),
        role: 'line',
        nodes: presentNodes(block.nodes, knownPages, project, config),
      }));
      number += 1;
      continue;
    }
    if (block.type === 'codeBlock') {
      result.push(withRenderKey({
        ...lineBase(source, firstRange, number, block.indent),
        role: 'codeHeader',
        text: block.fileName,
        textSpan: suffixSpan(source, firstRange, block.fileName),
      }));
      number += 1;
      const contents = block.content === '' ? [] : block.content.split('\n');
      for (let offset = 1; offset < block.lineRanges.length; offset += 1) {
        const range = block.lineRanges[offset];
        if (range === undefined) throw new Error('syntax block line is missing');
        const code = contents[offset - 1] ?? '';
        result.push(withRenderKey({
          ...lineBase(source, range, number, block.indent),
          role: 'codeLine',
          text: code,
          textSpan: suffixSpan(source, range, code),
        }));
        number += 1;
      }
      continue;
    }

    const table = number;
    result.push(withRenderKey({
      ...lineBase(source, firstRange, number, block.indent),
      role: 'tableHeader',
      text: block.fileName,
      textSpan: suffixSpan(source, firstRange, block.fileName),
    }));
    number += 1;
    for (let offset = 1; offset < block.lineRanges.length; offset += 1) {
      const range = block.lineRanges[offset];
      if (range === undefined) throw new Error('syntax block line is missing');
      const row = block.cells[offset - 1] ?? [];
      result.push(withRenderKey({
        ...lineBase(source, range, number, block.indent),
        role: 'tableRow',
        cells: row.map((cell) => presentNodes(cell, knownPages, project, config)),
        table,
      }));
      number += 1;
    }
  }
  return result;
}
