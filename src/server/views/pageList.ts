import { html } from 'hono/html';
import type { PageSummary, Project } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';
import { pageCardListItem } from './pageCard.ts';

export function pageListPage(
  project: Project,
  result: { count: number; pages: PageSummary[] },
  skip: number,
  limit: number,
  allowedImageHosts: string[],
): Html {
  const nextSkip = skip + limit;
  return layout(project.displayName, html`
<nav class="page-nav"><a href="/">プロジェクト一覧</a></nav>
<h1>${project.displayName}</h1>
<div id="search-root" data-project="${project.name}">
<button type="button" id="create-page-button">新規作成</button>
<dialog id="create-page-dialog"><form id="create-page-form">
<h2>ページを新規作成</h2>
<label>タイトル <input id="create-page-title" name="title" required></label>
<div class="dialog-actions"><button type="submit">作成</button><button type="button" data-dialog-close>キャンセル</button></div>
</form></dialog>
<input id="search-box" type="search" placeholder="検索">
<div id="search-results" hidden></div>
</div>
<ul class="card-grid" role="list">${result.pages.map((page) =>
    pageCardListItem(project.name, page, allowedImageHosts, 'eager'),
  )}</ul>
${nextSkip < result.count
    ? html`<a href="/${encodeURIComponent(project.name)}?skip=${nextSkip}&limit=${limit}">もっと見る</a>`
    : ''}
<script type="module" src="/assets/build/search.js"></script>`,
  );
}
