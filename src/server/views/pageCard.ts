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

export function pageCard(projectName: string, page: CardPage, allowedImageHosts: string[]): Html {
  const href = pageHref(projectName, page.title);
  return html`<li><a class="card ${page.pinned ? 'pinned' : ''}" href="${href}">
${page.image !== null && (isAttachmentUrl(page.image) || isAllowedImageUrl(page.image, allowedImageHosts))
    ? html`<img class="card-image" src="${page.image}" alt="" width="320" height="100">`
    : ''}
<h3>${page.title}</h3>
${page.descriptions.map((description) => html`<p>${plainLineText(description)}</p>`)}
</a></li>`;
}
