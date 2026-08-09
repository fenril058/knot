import { titleLc } from './title.ts';
import { classifyUrl, isAttachmentUrl } from './media.ts';
import { parsePageSyntax, type SyntaxNode } from './syntax.ts';

const LINE_ID_RE = /^([0-9a-f]{24}|[0-9A-HJKMNP-TV-Z]{26})$/;

type LinkTarget = { title: string; titleLc: string };
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

  const visit = (node: SyntaxNode): void => {
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

  for (const block of parsePageSyntax(text, { hasTitle: false })) {
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
 * 内部構文ノードのソース範囲を使うため、同じ文字列が先行していても別の箇所を書き換えない。
 */
export function rewritePageLinks(lines: string[], oldTitleLc: string, newTitle: string): (string | null)[] {
  const source = lines.join('\n');
  const blocks = parsePageSyntax(source, { hasTitle: true });
  const hashtagSafe = !HASHTAG_UNSAFE_RE.test(newTitle);
  const replacements: { from: number; to: number; text: string }[] = [];

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'link' && node.pathType === 'relative') {
      const target = stripLineId(node.href);
      if (titleLc(target) === oldTitleLc) {
        const fragment = node.href.slice(target.length);
        replacements.push({ ...node.range, text: `[${newTitle}${fragment}]` });
      }
    } else if (node.type === 'hashTag' && titleLc(node.href) === oldTitleLc) {
      replacements.push({ ...node.range, text: hashtagSafe ? `#${newTitle}` : `[${newTitle}]` });
    } else if (node.type === 'icon' && node.pathType === 'relative' && titleLc(node.path) === oldTitleLc) {
      replacements.push({ ...node.range, text: `[${newTitle}.icon]` });
    }
    if ('nodes' in node) for (const child of node.nodes) visit(child);
  };

  for (const block of blocks) {
    if (block.type === 'line') for (const node of block.nodes) visit(node);
    if (block.type === 'table') for (const row of block.cells) for (const cell of row) for (const node of cell) visit(node);
  }

  let rewritten = source;
  for (const replacement of replacements.toSorted((left, right) => right.from - left.from)) {
    rewritten = rewritten.slice(0, replacement.from) + replacement.text + rewritten.slice(replacement.to);
  }
  const rewrittenLines = rewritten.split('\n');
  return lines.map((line, index) => rewrittenLines[index] === line ? null : rewrittenLines[index] ?? null);
}
