import { parse, type Node } from '@progfay/scrapbox-parser';
import { titleLc } from './title.ts';
import { classifyUrl, isAttachmentUrl } from './media.ts';

export const LINE_ID_RE = /^([0-9a-f]{24}|[0-9A-HJKMNP-TV-Z]{26})$/;

export type LinkTarget = { title: string; titleLc: string };
export type PageRefs = { linkTargets: LinkTarget[]; image: string | null };

const HASHTAG_UNSAFE_RE = /[\s[\]#`]/;

function stripLineId(href: string): string {
  const i = href.lastIndexOf('#');
  if (i > 0 && LINE_ID_RE.test(href.slice(i + 1))) return href.slice(0, i);
  return href;
}

export function extractRefs(text: string): PageRefs {
  const targets = new Map<string, string>();
  let image: string | null = null;

  const add = (title: string): void => {
    const lc = titleLc(title);
    if (!targets.has(lc)) targets.set(lc, title);
  };

  const visit = (node: Node): void => {
    if (node.type === 'link' && node.pathType === 'relative') {
      add(stripLineId(node.href));
    } else if (node.type === 'hashTag') {
      add(node.href);
    } else if (node.type === 'link' && node.pathType === 'absolute') {
      if (image === null && classifyUrl(node.href) === 'image') image = node.href;
    } else if (node.type === 'link' && node.pathType === 'root') {
      if (image === null && isAttachmentUrl(node.href) && classifyUrl(node.href) === 'image') {
        image = node.href;
      }
    } else if (node.type === 'icon' && node.pathType === 'relative') {
      add(node.path);
    } else if (node.type === 'image' || node.type === 'strongImage') {
      if (image === null) image = node.src;
    }
    if ('nodes' in node) for (const child of node.nodes) visit(child);
  };

  for (const block of parse(text)) {
    if (block.type === 'line') {
      for (const node of block.nodes) visit(node);
    } else if (block.type === 'table') {
      for (const row of block.cells) for (const cell of row) for (const node of cell) visit(node);
    }
  }
  return { linkTargets: [...targets].map(([lc, title]) => ({ title, titleLc: lc })), image };
}

/**
 * ページ本文中の旧タイトルへのリンクを新タイトルに書き換える。
 * 返り値は lines と同じ長さで、変更のない行（タイトル行、コードブロック内を含む）は null。
 * scrapbox-parser のブロック構造で行位置を追跡する。
 * 置換はノードの出現順に cursor を進めながら位置を特定して行う。code 記法内などに
 * 同じ文字列が先行していても、AST が指すノードと別の箇所を書き換えることがない。
 */
export function rewritePageLinks(lines: string[], oldTitleLc: string, newTitle: string): (string | null)[] {
  const result: (string | null)[] = lines.map(() => null);
  const blocks = parse(lines.join('\n'), { hasTitle: true });
  const hashtagSafe = !HASHTAG_UNSAFE_RE.test(newTitle);

  // ノードの raw 全体を置き換えた文字列を返す。書き換え不要なら null。
  const rewriteNode = (node: Node): string | null => {
    if (node.type === 'link' && node.pathType === 'relative') {
      const target = stripLineId(node.href);
      if (titleLc(target) !== oldTitleLc) return null;
      const fragment = node.href.slice(target.length); // '#<行ID>' または ''
      return `[${newTitle}${fragment}]`;
    }
    if (node.type === 'hashTag') {
      if (titleLc(node.href) !== oldTitleLc) return null;
      return hashtagSafe ? `#${newTitle}` : `[${newTitle}]`;
    }
    if (node.type === 'icon' && node.pathType === 'relative') {
      if (titleLc(node.path) !== oldTitleLc) return null;
      return `[${newTitle}.icon]`;
    }
    if ('nodes' in node) {
      // 子ノードを raw 内で出現順に位置特定しながら再帰的に置換する
      return spliceChildren(node.raw, node.nodes);
    }
    return null;
  };

  // text 中で nodes を順に位置特定し、書き換え結果を継ぎ合わせる。変更がなければ null。
  const spliceChildren = (text: string, nodes: Node[]): string | null => {
    let out = '';
    let cursor = 0;
    let changed = false;
    for (const node of nodes) {
      const pos = text.indexOf(node.raw, cursor);
      if (pos === -1) continue; // 位置を特定できないノードは触らない
      const replacement = rewriteNode(node);
      out += text.slice(cursor, pos) + (replacement ?? node.raw);
      cursor = pos + node.raw.length;
      if (replacement !== null) changed = true;
    }
    out += text.slice(cursor);
    return changed ? out : null;
  };

  const rewriteAt = (index: number, nodes: Node[]): void => {
    const rewrittenLine = spliceChildren(result[index] ?? lines[index], nodes);
    if (rewrittenLine !== null) result[index] = rewrittenLine;
  };

  let index = 0;
  for (const block of blocks) {
    if (block.type === 'title') {
      index += 1; // タイトル行は書き換えない
    } else if (block.type === 'line') {
      rewriteAt(index, block.nodes);
      index += 1;
    } else if (block.type === 'codeBlock') {
      index += 1 + (block.content === '' ? 0 : block.content.split('\n').length);
    } else if (block.type === 'table') {
      block.cells.forEach((row, r) => rewriteAt(index + 1 + r, row.flat()));
      index += 1 + block.cells.length;
    }
  }
  return result;
}
