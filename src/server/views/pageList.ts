import { html } from 'hono/html';
import type { PageSummary, Project } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';
import { pageCardListItem } from './pageCard.ts';
import { pageNav } from './pageNav.ts';

export function pageListPage(
  project: Project,
  result: { count: number; pages: PageSummary[] },
  skip: number,
  limit: number,
  allowedImageHosts: string[],
): Html {
  const nextSkip = skip + limit;
  return layout(project.displayName, html`
${pageNav(project.name, html`<a href="/">プロジェクト一覧</a>`)}
<main>
<h1 class="visually-hidden">${project.displayName}</h1>
<div id="page-list-root" class="page-list-toolbar" data-project="${project.name}">
<button type="button" id="create-page-button" class="tool-button">新規作成</button>
<dialog id="create-page-dialog"><form id="create-page-form">
<h2>ページを新規作成</h2>
<label>タイトル <input id="create-page-title" name="title" required></label>
<div class="dialog-actions"><button type="submit">作成</button><button type="button" data-dialog-close>キャンセル</button></div>
</form></dialog>
</div>
<ul class="card-grid" role="list">${result.pages.map((page) =>
    pageCardListItem(project.name, page, allowedImageHosts, { headingLevel: 2, imageLoading: 'eager' }),
  )}</ul>
${nextSkip < result.count
    ? html`<a href="/${encodeURIComponent(project.name)}?skip=${nextSkip}&limit=${limit}">もっと見る</a>`
    : ''}
</main>
<div class="page-list-status">${result.count} pages</div>
<script type="module" src="/assets/build/page-list.js"></script>
<script type="module" src="/assets/build/search.js"></script>`,
  );
}
