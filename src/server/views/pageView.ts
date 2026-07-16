import { html } from 'hono/html';
import type { Line } from '../../core/ops.ts';
import { pageHref } from '../../core/title.ts';
import type { RenderedLine } from '../../render/render.ts';
import type { PageSnapshot, Project, RelatedPages, Visit } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';

const TELOMERE_AGE_BUCKETS = [86400, 7 * 86400];

function ageClass(page: PageSnapshot, updated: number): string {
  const age = page.updated - updated;
  if (age < TELOMERE_AGE_BUCKETS[0]!) return 'age-1';
  if (age < TELOMERE_AGE_BUCKETS[1]!) return 'age-2';
  return 'age-3';
}

function lineRow(page: PageSnapshot, line: Line, rendered: RenderedLine, previousVisit: Visit | null): Html {
  const unread = previousVisit === null || line.updatedVersion > previousVisit.lastSeenVersion;
  return html`<div class="line-row" id="L${line.id}">
<span class="telomere${unread ? ' unread' : ''} ${ageClass(page, line.updated)}" data-updated="${line.updated}" data-user="${line.userId}"></span>
${rendered.html}
</div>`;
}

function relatedSection(title: string, pages: { title: string }[], projectName: string): Html {
  if (pages.length === 0) return html``;
  return html`<section><h2>${title}</h2><ul>${pages.map(
    (page) => html`<li><a href="${pageHref(projectName, page.title)}">${page.title}</a></li>`,
  )}</ul></section>`;
}

export function pageViewPage(
  project: Project,
  page: PageSnapshot,
  rendered: RenderedLine[],
  previousVisit: Visit | null,
  related: RelatedPages,
): Html {
  const editHref = `${pageHref(project.name, page.title)}/edit`;
  return layout(page.title, html`
<nav class="page-nav"><a href="/${encodeURIComponent(project.name)}">${project.displayName}</a></nav>
<h1>${page.title}</h1>
<a href="${editHref}">編集</a>
<div id="page-menu-root" data-project="${project.name}" data-title="${page.title}" data-version="${page.version}">
<details id="page-actions" class="page-actions">
<summary>操作</summary>
<div class="page-actions-menu">
<button type="button" id="duplicate-button">複製</button>
<button type="button" id="rename-button">リネーム</button>
<button type="button" id="delete-button">削除</button>
</div>
</details>
<dialog id="duplicate-dialog"><form id="duplicate-form">
<h2>ページを複製</h2>
<label>新しいタイトル <input id="duplicate-title" name="title" required></label>
<p id="duplicate-error" class="error" hidden></p>
<div class="dialog-actions"><button type="submit">複製</button><button type="button" data-dialog-close>キャンセル</button></div>
</form></dialog>
<dialog id="rename-dialog"><form id="rename-form">
<h2>ページをリネーム</h2>
<label>新しいタイトル <input id="rename-title" name="title" value="${page.title}" required></label>
<label><input id="rename-rewrite-links" name="rewriteLinks" type="checkbox"> リンクも書き換える</label>
<p id="rename-error" class="error" hidden></p>
<div class="dialog-actions"><button type="submit">リネーム</button><button type="button" data-dialog-close>キャンセル</button></div>
</form></dialog>
<dialog id="delete-dialog"><form id="delete-form">
<h2>ページを削除</h2>
<p>「${page.title}」を削除しますか？</p>
<p id="delete-error" class="error" hidden></p>
<div class="dialog-actions"><button type="submit" class="danger">削除</button><button type="button" data-dialog-close>キャンセル</button></div>
</form></dialog>
</div>
${related.hasBackLinks ? html`<p class="backlinks-badge">逆リンクまたはアイコン参照あり</p>` : ''}
<div class="page-body">${rendered.map((line, index) => lineRow(page, page.lines[index]!, line, previousVisit))}</div>
${relatedSection('関連ページ', related.links1hop, project.name)}
${relatedSection('2-hop リンク', related.links2hop, project.name)}
<script src="/assets/line-ui.js" defer></script>
<script type="module" src="/assets/build/page-menu.js"></script>`,
  );
}

export function pageNotFoundPage(project: Project, title: string): Html {
  const editHref = `${pageHref(project.name, title)}/edit`;
  return layout('ページが見つかりません', html`
<h1>「${title}」はまだありません</h1>
<a href="${editHref}">このタイトルで新規作成する</a>`,
  );
}

export function projectNotFoundPage(projectName: string): Html {
  return layout('プロジェクトが見つかりません', html`
<main>
<h1>プロジェクトが見つかりません</h1>
<p>「${projectName}」というプロジェクトはありません。</p>
<a href="/">プロジェクト一覧へ戻る</a>
</main>`,
  );
}
