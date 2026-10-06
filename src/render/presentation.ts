import { classifyUrl, isAllowedImageUrl, isAttachmentUrl, isHostAllowed } from '../core/media.ts';
import { parsePageSyntax, type SourceRange, type SyntaxNode } from '../core/syntax.ts';
import { pageHref, titleLc } from '../core/title.ts';

export type KnownPage = { title: string; image: string | null };
export type RenderConfig = { allowedImageHosts: string[]; allowedMediaHosts: string[] };

export type PresentedNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string; className?: string }
  | { type: 'container'; kind: 'span' | 'strong' | 'em' | 'del' | 'quote'; className?: string; children: PresentedNode[] }
  | { type: 'link'; href: string; className?: string; external: boolean; children: PresentedNode[] }
  | { type: 'image'; src: string; alt: string; className?: string; lazy: boolean }
  | { type: 'video' | 'audio'; src: string };

type PresentedLineBase = {
  number: number;
  from: number;
  to: number;
  source: string;
  indent: number;
  renderKey: string;
};

export type PresentedLine = PresentedLineBase & (
  | { role: 'title' | 'codeHeader' | 'codeLine' | 'tableHeader'; text: string }
  | { role: 'line'; nodes: PresentedNode[] }
  | { role: 'tableRow'; cells: PresentedNode[][] }
);

// 字下げした行の行頭の印。Cosense と同じく、引用行と番号付きの行は横線にし、
// コードブロックの本文行と表の行には付けない。閲覧表示と編集表示がこの 1 つの規則を使う。
export type IndentMark = 'dot' | 'dash' | 'none';

export function indentMark(line: PresentedLine): IndentMark {
  if (line.role === 'codeLine' || line.role === 'tableRow') return 'none';
  if (line.role !== 'line') return 'dot';
  const first = line.nodes[0];
  return first?.type === 'container' && (first.kind === 'quote' || first.className === 'num-list') ? 'dash' : 'dot';
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

const text = (value: string): PresentedNode => ({ type: 'text', text: value });

function externalLink(url: string, label: string, external = true): PresentedNode {
  return { type: 'link', href: url, external, children: [text(label)] };
}

// [*** x] の強調の段階。parser は *-3 のように表す。強調でなければ undefined。
function strongLevel(decos: readonly string[]): number | undefined {
  for (const deco of decos) {
    const match = /^\*-(\d+)$/.exec(deco);
    if (match !== null) return Number(match[1]);
  }
  return undefined;
}

// strong は [[画像]]。Cosense と同じく高さの上限を外した大きい画像として描く。
function presentMedia(url: string, label: string | undefined, config: RenderConfig, strong = false): PresentedNode {
  const isLocal = isAttachmentUrl(url);
  if (!isLocal && !isHttpUrl(url)) return text(label === undefined ? url : `${label} (${url})`);
  const hostname = isLocal ? '' : new URL(url).hostname;
  const kind = classifyUrl(url);
  if (kind === 'image' && (isLocal || isHostAllowed(hostname, config.allowedImageHosts))) {
    return strong
      ? { type: 'image', src: url, alt: '', className: 'strong-image', lazy: true }
      : { type: 'image', src: url, alt: '', lazy: true };
  }
  if (kind === 'video' && (isLocal || isHostAllowed(hostname, config.allowedMediaHosts))) {
    return { type: 'video', src: url };
  }
  if (kind === 'audio' && (isLocal || isHostAllowed(hostname, config.allowedMediaHosts))) {
    return { type: 'audio', src: url };
  }
  return externalLink(url, label ?? url, !isLocal);
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
    case 'blank':
    case 'helpfeel':
      return text(node.text);
    case 'code':
      return { type: 'code', text: node.text };
    // コマンドラインと数式もコードの見た目で描く。バッククオートで囲んだコードと区別する。
    case 'commandLine':
      return { type: 'code', text: node.symbol + node.text, className: 'cli' };
    case 'formula':
      return { type: 'code', text: node.formula, className: 'formula' };
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
        children: [text(`${node.rawNumber}. `), ...children(node.nodes)],
      };
    case 'hashTag': {
      const entry = knownPages.get(titleLc(node.href));
      return {
        type: 'link',
        href: pageHref(project, entry?.title ?? node.href),
        className: entry === undefined ? 'empty-link' : 'page-link',
        external: false,
        children: [text(`#${node.href}`)],
      };
    }
    case 'icon':
    case 'strongIcon': {
      if (node.pathType !== 'relative') {
        return { type: 'container', kind: 'span', className: 'icon-link', children: [text(`[${node.path}]`)] };
      }
      const entry = knownPages.get(titleLc(node.path));
      // [[name.icon]] は Cosense と同じく大きいアイコンとして描く。
      const className = node.type === 'strongIcon' ? 'icon-img strong-icon' : 'icon-img';
      const linkChildren: PresentedNode[] = entry?.image && isAllowedImageUrl(entry.image, config.allowedImageHosts)
        ? [{ type: 'image', src: entry.image, alt: node.path, className, lazy: false }]
        : [text(`[${node.path}]`)];
      return {
        type: 'link',
        href: pageHref(project, entry?.title ?? node.path),
        className: entry === undefined ? 'icon-link empty-link' : 'icon-link',
        external: false,
        children: linkChildren,
      };
    }
    case 'image':
      return presentMedia(node.src, undefined, config);
    case 'strongImage':
      return presentMedia(node.src, undefined, config, true);
    case 'googleMap':
      return text(node.raw);
    case 'link': {
      if (hasUriScheme(node.href) && !isHttpUrl(node.href)) return text(node.raw);
      if (node.pathType === 'relative') {
        const target = node.href.split('#')[0]!;
        const entry = knownPages.get(titleLc(target));
        return {
          type: 'link',
          href: pageHref(project, entry?.title ?? target),
          className: entry === undefined ? 'empty-link' : 'page-link',
          external: false,
          children: [text(node.content === '' ? target : node.content)],
        };
      }
      if (isHttpUrl(node.href)) {
        return presentMedia(node.href, node.content === '' ? node.href : node.content, config);
      }
      if (isAttachmentUrl(node.href)) {
        return presentMedia(node.href, node.content === '' ? undefined : node.content, config);
      }
      return text(node.content === '' ? node.href : `${node.content} (${node.href})`);
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
      result.push(withRenderKey({ ...lineBase(source, firstRange, number, 0), role: 'title', text: block.text }));
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
      }));
      number += 1;
      const contents = block.content === '' ? [] : block.content.split('\n');
      for (let offset = 1; offset < block.lineRanges.length; offset += 1) {
        const range = block.lineRanges[offset];
        if (range === undefined) throw new Error('syntax block line is missing');
        result.push(withRenderKey({
          ...lineBase(source, range, number, block.indent),
          role: 'codeLine',
          text: contents[offset - 1] ?? '',
        }));
        number += 1;
      }
      continue;
    }

    result.push(withRenderKey({
      ...lineBase(source, firstRange, number, block.indent),
      role: 'tableHeader',
      text: block.fileName,
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
      }));
      number += 1;
    }
  }
  return result;
}
