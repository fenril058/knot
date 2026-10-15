import { html } from 'hono/html';
import type { PageSort, PageSummary, Project } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';
import { pageCardListItem } from './pageCard.ts';
import { pageNav } from './pageNav.ts';
import { sortMenu } from './sortMenu.ts';

// プロジェクトのトップの並び替え（#291）。Cosense のプロジェクトのトップの並び替えと同じ名前と順。
const pageSorts = [
  { key: 'updated', label: '更新日時' },
  { key: 'created', label: '作成日時' },
  { key: 'accessed', label: '最終アクセス' },
  { key: 'linked', label: '被リンク数' },
  { key: 'views', label: '閲覧数' },
  { key: 'title', label: 'タイトル' },
] as const satisfies readonly { key: PageSort; label: string }[];

export function isPageSort(value: unknown): value is PageSort {
  return pageSorts.some(({ key }) => key === value);
}

// 並び替えの menu の項目は、その並び替えで最初から描き直すリンク。JS が無くても選べる。
function pageSortMenu(sort: PageSort): Html {
  const current = pageSorts.find(({ key }) => key === sort) ?? pageSorts[0];
  return sortMenu('page-sort-menu', current.label, html`${pageSorts.map(({ key, label }) => (key === sort
    ? html`<a href="?sort=${key}" aria-current="true">${label}</a>`
    : html`<a href="?sort=${key}">${label}</a>`))}`);
}

export function pageListPage(
  project: Project,
  result: { count: number; pages: PageSummary[] },
  skip: number,
  limit: number,
  sort: PageSort,
  allowedImageHosts: string[],
): Html {
  const nextSkip = skip + limit;
  return layout(project.displayName, html`
${pageNav(project.name, html`<a href="/">プロジェクト一覧</a>`)}
<main>
<h1 class="visually-hidden">${project.displayName}</h1>
<div id="page-list-root" class="page-list-toolbar" data-project="${project.name}">
<button type="button" id="create-page-button" class="tool-button">新規作成</button>
${pageSortMenu(sort)}
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
    ? html`<a href="/${encodeURIComponent(project.name)}?skip=${nextSkip}&limit=${limit}&sort=${sort}">もっと見る</a>`
    : ''}
</main>
<div class="page-list-status">${result.count} pages</div>
<script type="module" src="/assets/build/page-list.js"></script>
<script type="module" src="/assets/build/search.js"></script>`,
  );
}
