import { html } from 'hono/html';
import type { Html } from './layout.ts';

// 並び替えの menu を開くボタンの下向きの印。色は文字色に従う。
const caretIcon = html`<svg class="sort-menu-caret" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="m7.5 9.5 4.5 4.5 4.5-4.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5"/></svg>`;

// 並び替えの menu（Cosense の .page-sort-menu）。関連ページ（#281）とプロジェクトのトップ（#291）が同じ見た目で使う。
// 展開ボタンには、いまの並び替えの名前を出す。menu は見出し「ソート」と、並び替えを選ぶ項目（items）。
// Escape と menu の外を押したときに閉じるのは client/sortMenu.ts。
export function sortMenu(className: string, currentLabel: string, items: Html): Html {
  return html`<details class="sort-menu ${className}">
<summary class="tool-button sort-menu-toggle"><span class="visually-hidden">並び替え: </span><span class="sort-menu-current">${currentLabel}</span>${caretIcon}</summary>
<div class="sort-menu-options">
<p class="sort-menu-heading">ソート</p>
${items}
</div>
</details>`;
}
