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

type PageCardOptions = {
  headingLevel: 2 | 3;
  imageLoading: 'eager' | 'lazy';
};

export function canDisplayCardImage(image: string | null, allowedImageHosts: string[]): image is string {
  return image !== null && (isAttachmentUrl(image) || isAllowedImageUrl(image, allowedImageHosts));
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
  return html`<li><a class="${className}" href="${href}">
${canDisplayCardImage(page.image, allowedImageHosts)
    ? html`<img class="card-image" src="${page.image}" alt="" width="320" height="100" loading="${options.imageLoading}">`
    : ''}
${heading}
${page.descriptions.map((description) => html`<p>${plainLineText(description)}</p>`)}
</a></li>`;
}
