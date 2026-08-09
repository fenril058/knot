import { parse, type Node } from '@progfay/scrapbox-parser';
import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { classifyUrl, isAllowedImageUrl, isAttachmentUrl, isHostAllowed } from '../core/media.ts';
import { pageHref, titleLc } from '../core/title.ts';

export type KnownPage = { title: string; image: string | null };
export type RenderConfig = { allowedImageHosts: string[]; allowedMediaHosts: string[] };
export type RenderedLine = { lineId: string; html: HtmlEscapedString | Promise<HtmlEscapedString> };

type RenderedHtml = HtmlEscapedString | Promise<HtmlEscapedString>;

function isHttpUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hasUriScheme(href: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(href);
}

function countIndentedBodyLines(lines: { text: string }[], headerIndex: number, headerIndent: number): number {
  let count = 0;
  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const indent = /^\s+/.exec(lines[lineIndex]!.text)?.[0].length ?? 0;
    if (indent <= headerIndent) break;
    count += 1;
  }
  return count;
}

const renderExternalLink = (url: string, label: string | undefined): RenderedHtml =>
  label === undefined
    ? html`<a href="${url}" rel="noopener noreferrer">${url}</a>`
    : html`<a href="${url}" rel="noopener noreferrer">${label}</a>`;

function makeRenderer(knownPages: Map<string, KnownPage>, projectName: string, config: RenderConfig) {
  // oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かないことで、分岐漏れを型エラーにしている
  const renderMedia = (url: string, label: string | undefined): RenderedHtml => {
    // サイト内の添付ファイルは同一オリジン配信（img-src/media-src 'self'）なので allowlist を通さない
    if (isAttachmentUrl(url)) {
      switch (classifyUrl(url)) {
        case 'image':
          return html`<img src="${url}" alt="" loading="lazy">`;
        case 'video':
          return html`<video controls><source src="${url}"></video>`;
        case 'audio':
          return html`<audio controls><source src="${url}"></audio>`;
        case 'other':
          return label === undefined ? html`<a href="${url}">${url}</a>` : html`<a href="${url}">${label}</a>`;
      }
    }
    if (!isHttpUrl(url)) return label === undefined ? html`${url}` : html`${label} (${url})`;

    const hostname = new URL(url).hostname;
    switch (classifyUrl(url)) {
      case 'image':
        if (!isHostAllowed(hostname, config.allowedImageHosts)) return renderExternalLink(url, label);
        return html`<img src="${url}" alt="" loading="lazy">`;
      case 'video':
        if (!isHostAllowed(hostname, config.allowedMediaHosts)) return renderExternalLink(url, label);
        return html`<video controls><source src="${url}"></video>`;
      case 'audio':
        if (!isHostAllowed(hostname, config.allowedMediaHosts)) return renderExternalLink(url, label);
        return html`<audio controls><source src="${url}"></audio>`;
      case 'other':
        return renderExternalLink(url, label);
    }
  };

  // oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かないことで、分岐漏れを型エラーにしている
  const renderNode = (node: Node): RenderedHtml => {
    switch (node.type) {
      case 'plain':
      case 'blank':
        return html`${node.text}`;
      case 'code':
        return html`<code>${node.text}</code>`;
      case 'formula':
        return html`<code>${node.formula}</code>`;
      case 'helpfeel':
        return html`${node.text}`;
      case 'strong':
        return html`<strong>${node.nodes.map(renderNode)}</strong>`;
      case 'quote':
        return html`<blockquote>${node.nodes.map(renderNode)}</blockquote>`;
      case 'decoration':
        if (
          node.decos.includes('"')
          && node.nodes.some(
            (child) => child.type === 'link' && child.pathType === 'absolute' && classifyUrl(child.href) === 'image',
          )
        ) {
          return html`<span>${node.nodes
            .filter(
              (child) => child.type === 'link' && child.pathType === 'absolute' && classifyUrl(child.href) === 'image',
            )
            .map(renderNode)}</span>`;
        }
        if (node.decos.includes('/')) return html`<em>${node.nodes.map(renderNode)}</em>`;
        if (node.decos.includes('-')) return html`<del>${node.nodes.map(renderNode)}</del>`;
        if (node.decos.some((deco) => deco.startsWith('*'))) {
          return html`<strong>${node.nodes.map(renderNode)}</strong>`;
        }
        return html`<span>${node.nodes.map(renderNode)}</span>`;
      case 'numberList':
        return html`<span class="num-list">${node.rawNumber}. ${node.nodes.map(renderNode)}</span>`;
      case 'commandLine':
        return html`<code>${node.symbol}${node.text}</code>`;
      case 'hashTag': {
        const entry = knownPages.get(titleLc(node.href));
        const href = pageHref(projectName, entry?.title ?? node.href);
        return entry
          ? html`<a href="${href}">#${node.href}</a>`
          : html`<a href="${href}" class="empty-link">#${node.href}</a>`;
      }
      case 'icon':
      case 'strongIcon': {
        if (node.pathType !== 'relative') return html`<span class="icon-link">[${node.path}]</span>`;
        const entry = knownPages.get(titleLc(node.path));
        const href = pageHref(projectName, entry?.title ?? node.path);
        if (entry?.image && isAllowedImageUrl(entry.image, config.allowedImageHosts)) {
          return html`<a href="${href}" class="icon-link"><img src="${entry.image}" alt="${node.path}" class="icon-img"></a>`;
        }
        return entry
          ? html`<a href="${href}" class="icon-link">[${node.path}]</a>`
          : html`<a href="${href}" class="icon-link empty-link">[${node.path}]</a>`;
      }
      case 'image':
      case 'strongImage':
        return renderMedia(node.src, undefined);
      case 'googleMap':
        return html`${node.raw}`;
      case 'link': {
        if (hasUriScheme(node.href) && !isHttpUrl(node.href)) return html`${node.raw}`;
        if (node.pathType === 'relative') {
          const target = node.href.split('#')[0]!;
          const entry = knownPages.get(titleLc(target));
          const label = node.content === '' ? target : node.content;
          const href = pageHref(projectName, entry?.title ?? target);
          return entry
            ? html`<a href="${href}">${label}</a>`
            : html`<a href="${href}" class="empty-link">${label}</a>`;
        }
        if (isHttpUrl(node.href)) {
          return renderMedia(node.href, node.content === '' ? node.href : node.content);
        }
        if (isAttachmentUrl(node.href)) {
          return renderMedia(node.href, node.content === '' ? undefined : node.content);
        }
        return node.content === '' ? html`${node.href}` : html`${node.content} (${node.href})`;
      }
    }
  };

  const renderTableCell = (nodes: Node[]): RenderedHtml => html`<td>${nodes.map(renderNode)}</td>`;
  return { renderNode, renderTableCell };
}

export function renderLines(
  lines: { id: string; text: string }[],
  knownPages: Map<string, KnownPage>,
  projectName: string,
  config: RenderConfig,
): RenderedLine[] {
  const { renderNode, renderTableCell } = makeRenderer(knownPages, projectName, config);
  const result: RenderedLine[] = lines.map(({ id }) => ({ lineId: id, html: raw('') }));
  const blocks = parse(lines.map(({ text }) => text).join('\n'), { hasTitle: true });

  let index = 0;
  for (const block of blocks) {
    if (block.type === 'title') {
      index += 1;
    } else if (block.type === 'line') {
      result[index] = { lineId: lines[index]!.id, html: html`<div>${block.nodes.map(renderNode)}</div>` };
      index += 1;
    } else if (block.type === 'codeBlock') {
      const bodyLineCount = countIndentedBodyLines(lines, index, block.indent);
      const contentLines = block.content === '' ? [] : block.content.split('\n');
      result[index] = { lineId: lines[index]!.id, html: html`<div class="code-header">${block.fileName}</div>` };
      Array.from({ length: bodyLineCount }, (_, offset) => contentLines[offset] ?? '').forEach((content, offset) => {
        const lineIndex = index + 1 + offset;
        result[lineIndex] = {
          lineId: lines[lineIndex]!.id,
          html: html`<div class="code-line">${content}</div>`,
        };
      });
      index += 1 + bodyLineCount;
    } else if (block.type === 'table') {
      const bodyLineCount = countIndentedBodyLines(lines, index, block.indent);
      result[index] = { lineId: lines[index]!.id, html: html`<div class="table-header">${block.fileName}</div>` };
      Array.from({ length: bodyLineCount }, (_, offset) => block.cells[offset] ?? []).forEach((row, offset) => {
        const lineIndex = index + 1 + offset;
        result[lineIndex] = {
          lineId: lines[lineIndex]!.id,
          html: html`<div class="table-row"><table><tr>${row.map(renderTableCell)}</tr></table></div>`,
        };
      });
      index += 1 + bodyLineCount;
    } else {
      block satisfies never;
    }
  }

  return result;
}
