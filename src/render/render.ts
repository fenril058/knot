import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import {
  indentMark,
  isLinkOnlyLine,
  presentationLines,
  type IndentMark,
  type KnownPage,
  type PresentedNode,
  type RenderConfig,
} from './presentation.ts';

export type { KnownPage, RenderConfig } from './presentation.ts';

export type RenderedLine = {
  lineId: string;
  indent: number;
  mark: IndentMark;
  // コードブロックの行（見出しと本文）は、行の高さが本文の行と違う。
  codeBlock: boolean;
  // リンクと埋め込みだけの行は、行末に編集を始める面を残す（presentation.ts の isLinkOnlyLine）。
  linkOnly: boolean;
  html: HtmlEscapedString | Promise<HtmlEscapedString>;
};
type RenderedHtml = HtmlEscapedString | Promise<HtmlEscapedString>;

// oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かず分岐漏れを型エラーにする
function renderNode(node: PresentedNode): RenderedHtml {
  switch (node.type) {
    case 'text':
      return html`${node.text}`;
    case 'code':
      return node.className === undefined
        ? html`<code>${node.text}</code>`
        : html`<code class="${node.className}">${node.text}</code>`;
    case 'container': {
      const children = node.children.map(renderNode);
      if (node.kind === 'strong') {
        return node.className === undefined
          ? html`<strong>${children}</strong>`
          : html`<strong class="${node.className}">${children}</strong>`;
      }
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
        return node.lazy
          ? html`<img src="${node.src}" alt="${node.alt}" class="${node.className}" loading="lazy">`
          : html`<img src="${node.src}" alt="${node.alt}" class="${node.className}">`;
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

function blockLabel(kind: 'code' | 'table', text: string): RenderedHtml {
  return html`<span class="${kind}-block-start">${text}</span>`;
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
    // タイトル行そのものを文書の見出しとして描く。閲覧表示のタイトルを本文の外に別途置くと、
    // Editor 起動時に本文の先頭行としても現れてタイトルが二重に見える。
    if (line.role === 'title') rendered = html`<h1 class="line-title">${line.text}</h1>`;
    else if (line.role === 'line') rendered = html`<div>${line.nodes.map(renderNode)}</div>`;
    // コードブロックと表の見出しは、名前だけを札にする。
    else if (line.role === 'codeHeader') rendered = html`<div class="code-header">${blockLabel('code', line.text)}</div>`;
    else if (line.role === 'codeLine') rendered = html`<div class="code-line">${line.text}</div>`;
    else if (line.role === 'tableHeader') rendered = html`<div class="table-header">${blockLabel('table', line.text)}</div>`;
    else if (line.role === 'tableRow') {
      rendered = html`<div class="table-row"><table data-table="${line.table}"><tr>${line.cells.map(
        (cell) => html`<td>${cell.map(renderNode)}</td>`,
      )}</tr></table></div>`;
    } else throw new Error('unknown presented line role');
    return {
      lineId: lines[index]!.id,
      indent: line.indent,
      mark: indentMark(line),
      codeBlock: line.role === 'codeHeader' || line.role === 'codeLine',
      linkOnly: isLinkOnlyLine(line),
      html: rendered,
    };
  });
}
