import { html } from 'hono/html';
import type { Html } from './layout.ts';

// 虫眼鏡の印。色は文字色（currentColor）に従う。
const searchIcon = html`<svg class="search-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false"><circle cx="8.5" cy="8.5" r="6" fill="none" stroke="currentColor" stroke-width="2"/><path d="m13 13 5 5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/></svg>`;

// 全文検索の結果ページ。Cosense と同じ URL。
function searchPagePath(projectName: string): string {
  return `/${encodeURIComponent(projectName)}/search/page`;
}

type PageNavOptions = {
  // 検索欄に入れておく語（検索の結果ページ）。
  query?: string;
  // 767px 以下でも検索欄を開いておく（検索の結果ページ）。
  searchOpen?: boolean;
  // 767px 以下でページメニューがバーの右端に重なるページ（ページの閲覧表示）。
  pageMenu?: boolean;
};

// 上部のバー（#247）。Cosense の navbar と同じく、左にプロジェクトへの導線、真ん中に検索欄を置く。
// 検索欄は Enter で全文検索の結果ページへ GET で移るので、JavaScript が無くても使える。
// 767px 以下では検索欄を隠し、右の検索ボタンで開く。JavaScript が無いときは、そのボタンが
// 検索の結果ページへのリンクとして働く。
export function pageNav(projectName: string, start: Html, options: PageNavOptions = {}): Html {
  const classes = ['page-nav'];
  if (options.searchOpen === true) classes.push('search-open');
  if (options.pageMenu === true) classes.push('with-page-menu');
  const searchPath = searchPagePath(projectName);
  return html`<nav class="${classes.join(' ')}">
<div class="page-nav-start">${start}</div>
<form class="nav-search" role="search" action="${searchPath}" method="get" data-project="${projectName}">
<input class="nav-search-input" type="search" name="q" value="${options.query ?? ''}" aria-label="ページを検索" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
<button class="nav-search-button" type="submit" aria-label="検索">${searchIcon}</button>
<ul class="nav-search-candidates" role="list" hidden></ul>
</form>
<a class="nav-search-toggle" href="${searchPath}" aria-label="検索欄を開く">${searchIcon}</a>
</nav>`;
}
