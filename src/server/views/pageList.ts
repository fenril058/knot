import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { encodeTitleForUrl } from '../../core/title.ts';
import type { PageSummary, Project } from '../../storage/types.ts';
import { layout } from './layout.ts';

function card(project: Project, page: PageSummary): HtmlEscapedString {
  const href = `/${project.name}/${encodeTitleForUrl(page.title)}`;
  return html`<a class="card ${page.pinned ? 'pinned' : ''}" href="${href}">
${page.image === null ? '' : html`<img class="card-image" src="${page.image}" alt="">`}
<h3>${page.title}</h3>
${page.descriptions.map((description) => html`<p>${description}</p>`)}
</a>` as unknown as HtmlEscapedString;
}

export function pageListPage(
  project: Project,
  result: { count: number; pages: PageSummary[] },
  skip: number,
  limit: number,
): HtmlEscapedString {
  const nextSkip = skip + limit;
  return layout(project.displayName, html`
<h1>${project.displayName}</h1>
<input id="search-box" type="search" placeholder="検索">
<div id="search-results" hidden></div>
<div class="card-grid">${result.pages.map((page) => card(project, page))}</div>
${nextSkip < result.count
    ? html`<a href="/${project.name}?skip=${nextSkip}&limit=${limit}">もっと見る</a>`
    : ''}
<script src="/assets/search.js" defer data-project="${project.name}"></script>`,
  );
}
