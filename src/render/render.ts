import { html, raw } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
  presentationLines,
  type KnownPage,
  type PresentedNode,
  type RenderConfig,
} from './presentation.ts';

export type { KnownPage, RenderConfig } from './presentation.ts';

export type RenderedLine = { lineId: string; indent: number; html: HtmlEscapedString | Promise<HtmlEscapedString> };
type RenderedHtml = HtmlEscapedString | Promise<HtmlEscapedString>;

// oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かず分岐漏れを型エラーにする
function renderNode(node: PresentedNode): RenderedHtml {
  switch (node.type) {
    case 'text':
      return html`${node.text}`;
    case 'code':
      return html`<code>${node.text}</code>`;
    case 'container': {
      const children = node.children.map(renderNode);
      if (node.kind === 'strong') return html`<strong>${children}</strong>`;
      if (node.kind === 'em') return html`<em>${children}</em>`;
      if (node.kind === 'del') return html`<del>${children}</del>`;
      if (node.kind === 'quote') return html`<blockquote>${children}</blockquote>`;
      return node.className === undefined
        ? html`<span>${children}</span>`
        : html`<span class="${node.className}">${children}</span>`;
    }
    case 'link': {
      const children = node.children.map(renderNode);
      if (node.className !== undefined && node.external) {
        return html`<a href="${node.href}" class="${node.className}" rel="noopener noreferrer">${children}</a>`;
      }
      if (node.className !== undefined) return html`<a href="${node.href}" class="${node.className}">${children}</a>`;
      if (node.external) return html`<a href="${node.href}" rel="noopener noreferrer">${children}</a>`;
      return html`<a href="${node.href}">${children}</a>`;
    }
    case 'image':
      if (node.className !== undefined) {
        return html`<img src="${node.src}" alt="${node.alt}" class="${node.className}">`;
      }
      return node.lazy
        ? html`<img src="${node.src}" alt="${node.alt}" loading="lazy">`
        : html`<img src="${node.src}" alt="${node.alt}">`;
    case 'video':
      return html`<video controls><source src="${node.src}"></video>`;
    case 'audio':
      return html`<audio controls><source src="${node.src}"></audio>`;
  }
}

export function renderLines(
  lines: { id: string; text: string }[],
  knownPages: Map<string, KnownPage>,
  projectName: string,
  config: RenderConfig,
): RenderedLine[] {
  const plans = presentationLines(lines.map(({ text }) => text).join('\n'), knownPages, projectName, config);
  return plans.map((line, index) => {
    let rendered: RenderedHtml;
    if (line.role === 'title') rendered = raw('');
    else if (line.role === 'line') rendered = html`<div>${line.nodes.map(renderNode)}</div>`;
    else if (line.role === 'codeHeader') rendered = html`<div class="code-header">${line.text}</div>`;
    else if (line.role === 'codeLine') rendered = html`<div class="code-line">${line.text}</div>`;
    else if (line.role === 'tableHeader') rendered = html`<div class="table-header">${line.text}</div>`;
    else if (line.role === 'tableRow') {
      rendered = html`<div class="table-row"><table><tr>${line.cells.map(
        (cell) => html`<td>${cell.map(renderNode)}</td>`,
      )}</tr></table></div>`;
    } else throw new Error('unknown presented line role');
    return { lineId: lines[index]!.id, indent: line.indent, html: rendered };
  });
}
