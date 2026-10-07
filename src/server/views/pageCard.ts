import { html } from 'hono/html';
import { isAllowedImageUrl, isAttachmentUrl } from '../../core/media.ts';
import { pageHref } from '../../core/title.ts';
import { plainLineText } from '../../render/plain.ts';
import { presentationLines, type KnownPage, type PresentedNode } from '../../render/presentation.ts';
import type { Html } from './layout.ts';

type CardPage = {
  title: string;
  image: string | null;
  descriptions: string[];
  pinned?: number;
};

type PageCardOptions = {
  headingLevel: 2 | 3;
  imageLoading: 'eager' | 'lazy';
  // アイコンを画像で描くための、ページのタイトルと代表画像（title_lc ごと）。無ければアイコンは名前の字。
  knownPages?: ReadonlyMap<string, KnownPage>;
};

export function canDisplayCardImage(image: string | null, allowedImageHosts: string[]): image is string {
  return image !== null && (isAttachmentUrl(image) || isAllowedImageUrl(image, allowedImageHosts));
}

// 札の説明文の中の 1 つの node（#256）。Cosense と同じく、リンク・コード・アイコンだけを見た目で示し、
// 強調などの装飾は付けない。札全体が 1 つのリンクなので、説明文の中のリンクは押せない span にする。
// oxlint-disable-next-line typescript/consistent-return -- union を網羅する switch。末尾の return を書かず分岐漏れを型エラーにする
function descriptionNode(node: PresentedNode): Html {
  switch (node.type) {
    case 'text':
      return html`${node.text}`;
    case 'code':
      return html`<code>${node.text}</code>`;
    case 'container':
      return html`${node.children.map(descriptionNode)}`;
    case 'link': {
      // 画像の分からないアイコンは、閲覧表示の [name] から括弧を外した名前にする。
      const children = node.className?.includes('icon-link') === true
        ? node.children.map((child) => (child.type === 'text' ? html`${child.text.replace(/^\[(.*)\]$/u, '$1')}` : descriptionNode(child)))
        : node.children.map(descriptionNode);
      return html`<span class="${node.external ? 'card-url' : 'card-link'}">${children}</span>`;
    }
    case 'image':
      return node.className?.includes('icon-img') === true ? html`<img class="inline-icon" src="${node.src}" alt="">` : html``;
    case 'video':
    case 'audio':
      return html``;
  }
}

function descriptionLine(
  projectName: string,
  line: string,
  allowedImageHosts: string[],
  knownPages: ReadonlyMap<string, KnownPage>,
): Html {
  try {
    const presented = presentationLines(`_\n${line}`, knownPages, projectName, { allowedImageHosts, allowedMediaHosts: [] })[1];
    if (presented?.role === 'line') return html`${presented.nodes.map(descriptionNode)}`;
  } catch {
    // 解析できない行は、記法を外した字で描く。
  }
  return html`${plainLineText(line)}`;
}

export function pageCardListItem(
  projectName: string,
  page: CardPage,
  allowedImageHosts: string[],
  options: PageCardOptions,
): Html {
  const href = pageHref(projectName, page.title);
  const className = page.pinned ? 'card pinned' : 'card';
  const heading = options.headingLevel === 2 ? html`<h2>${page.title}</h2>` : html`<h3>${page.title}</h3>`;
  const knownPages = options.knownPages ?? new Map<string, KnownPage>();
  // Cosense と同じく、タイトルの下には画像のあるページなら画像だけ、無いページなら説明文を置く。
  return html`<li><a class="${className}" href="${href}">
${heading}
${canDisplayCardImage(page.image, allowedImageHosts)
    ? html`<img class="card-image" src="${page.image}" alt="" width="320" height="100" loading="${options.imageLoading}">`
    : page.descriptions.map((description) => html`<p>${descriptionLine(projectName, description, allowedImageHosts, knownPages)}</p>`)}
</a></li>`;
}
