import { html } from 'hono/html';
import { isAllowedImageUrl, isAttachmentUrl } from '../../core/media.ts';
import { pageHref } from '../../core/title.ts';
import { plainLineText } from '../../render/plain.ts';
import type { Html } from './layout.ts';

type CardPage = {
  title: string;
  image: string | null;
  descriptions: string[];
  pinned?: number;
};

export function pageCardListItem(
  projectName: string,
  page: CardPage,
  allowedImageHosts: string[],
  imageLoading: 'eager' | 'lazy',
): Html {
  const href = pageHref(projectName, page.title);
  const className = page.pinned ? 'card pinned' : 'card';
  return html`<li><a class="${className}" href="${href}">
${page.image !== null && (isAttachmentUrl(page.image) || isAllowedImageUrl(page.image, allowedImageHosts))
    ? html`<img class="card-image" src="${page.image}" alt="" width="320" height="100" loading="${imageLoading}">`
    : ''}
<h3>${page.title}</h3>
${page.descriptions.map((description) => html`<p>${plainLineText(description)}</p>`)}
</a></li>`;
}
