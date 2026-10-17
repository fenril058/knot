import { html } from 'hono/html';
import type { SearchQueryProblem } from '../../core/searchQuery.ts';
import { pageHref } from '../../core/title.ts';
import { plainLineText } from '../../render/plain.ts';
import type { Project, SearchHit } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';
import { canDisplayCardImage } from './pageCard.ts';
import { pageNav } from './pageNav.ts';

// 全文検索の結果ページに並べる件数。/api/pages/:project/search/query と同じ。
const SEARCH_RESULT_LIMIT = 100;

export type SearchPageResult =
  | { kind: 'problem'; problem: SearchQueryProblem }
  | { kind: 'hits'; words: readonly string[]; hits: readonly SearchHit[] };

const problemMessages: Record<SearchQueryProblem, string> = {
  required: '検索する語を入れてください。',
  too_long: '検索する語が長すぎます。',
  too_many_terms: '検索する語が多すぎます。',
};

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

// 字の中の検索語を、Cosense の .search-matched と同じく太字・黄色の背景で示す。大文字小文字は区別しない。
function highlighted(text: string, words: readonly string[]): Html {
  const terms = words.filter((word) => word !== '');
  if (terms.length === 0) return html`${text}`;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'giu');
  return html`${text.split(pattern).map((part, index) => (index % 2 === 1 ? html`<strong class="search-matched">${part}</strong>` : part))}`;
}

function searchResult(projectName: string, hit: SearchHit, words: readonly string[], allowedImageHosts: string[]): Html {
  return html`<li class="search-result"><a href="${pageHref(projectName, hit.title)}">
${canDisplayCardImage(hit.image, allowedImageHosts) ? html`<img class="search-result-image" src="${hit.image}" alt="" loading="lazy">` : ''}
<div class="search-result-title">${highlighted(hit.title, words)}</div>
<div class="search-result-lines">${hit.lines.map((line) => html`<span>${highlighted(plainLineText(line), words)}</span>`)}</div>
</a></li>`;
}

function searchBody(projectName: string, query: string, result: SearchPageResult, allowedImageHosts: string[]): Html {
  if (result.kind === 'problem') return html`<p class="search-message">${problemMessages[result.problem]}</p>`;
  if (result.hits.length === 0) return html`<p class="search-message">「${query}」を含むページはありません。</p>`;
  return html`<ul class="search-results" role="list">${result.hits.slice(0, SEARCH_RESULT_LIMIT).map((hit) =>
    searchResult(projectName, hit, result.words, allowedImageHosts),
  )}</ul>`;
}

// 全文検索の結果ページ（#247）。Cosense の /:project/search/page と同じく、語を含むページを
// タイトルと、語を含む行の抜粋で 1 行ずつ並べる。
export function searchResultsPage(project: Project, query: string, result: SearchPageResult, allowedImageHosts: string[]): Html {
  const projectLink = html`<a href="/${encodeURIComponent(project.name)}">${project.displayName}</a>`;
  const count = result.kind === 'hits' ? html` <span class="search-count">(${Math.min(result.hits.length, SEARCH_RESULT_LIMIT)})</span>` : '';
  return layout(query.trim() === '' ? `検索 - ${project.displayName}` : `${query} - ${project.displayName}`, html`
${pageNav(project.name, projectLink, { query, searchOpen: true })}
<main class="search-main">
<h1 class="search-heading">ページ${count}</h1>
${searchBody(project.name, query, result, allowedImageHosts)}
</main>
<script type="module" src="/assets/build/search.js"></script>`,
  );
}
