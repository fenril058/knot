import { parse } from '@progfay/scrapbox-parser';
import { titleLc } from './title.ts';
import { classifyUrl } from './media.ts';

export const LINE_ID_RE = /^([0-9a-f]{24}|[0-9A-HJKMNP-TV-Z]{26})$/;

export type PageRefs = { linkTargets: string[]; image: string | null };

function stripLineId(href: string): string {
  const i = href.lastIndexOf('#');
  if (i > 0 && LINE_ID_RE.test(href.slice(i + 1))) return href.slice(0, i);
  return href;
}

export function extractRefs(text: string): PageRefs {
  const targets = new Set<string>();
  let image: string | null = null;

  const visit = (node: unknown): void => {
    const n = node as {
      type?: string;
      pathType?: string;
      href?: string;
      path?: string;
      nodes?: unknown[];
    };
    if (n.type === 'link' && n.pathType === 'relative' && n.href) {
      targets.add(titleLc(stripLineId(n.href)));
    } else if (n.type === 'hashTag' && n.href) {
      targets.add(titleLc(n.href));
    } else if (n.type === 'link' && n.pathType === 'absolute' && n.href) {
      if (image === null && classifyUrl(n.href) === 'image') image = n.href;
    } else if (n.type === 'icon' && n.pathType === 'relative' && n.path) {
      targets.add(titleLc(n.path));
    }
    for (const child of n.nodes ?? []) visit(child);
  };

  for (const block of parse(text)) {
    if (block.type === 'line') for (const node of block.nodes) visit(node);
  }
  return { linkTargets: [...targets], image };
}
