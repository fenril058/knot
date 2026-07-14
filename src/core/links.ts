import { parse, type Node } from '@progfay/scrapbox-parser';
import { titleLc } from './title.ts';
import { classifyUrl } from './media.ts';

export const LINE_ID_RE = /^([0-9a-f]{24}|[0-9A-HJKMNP-TV-Z]{26})$/;

export type LinkTarget = { title: string; titleLc: string };
export type PageRefs = { linkTargets: LinkTarget[]; image: string | null };

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
