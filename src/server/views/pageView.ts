import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import { encodeTitleForUrl } from '../../core/title.ts';
import type { RenderedLine } from '../../render/render.ts';
import type { PageSnapshot, Project, RelatedPages, Visit } from '../../storage/types.ts';
import { layout } from './layout.ts';

const TELOMERE_AGE_BUCKETS = [86400, 7 * 86400];

function ageClass(page: PageSnapshot, updated: number): string {
  const age = page.updated - updated;
  if (age < TELOMERE_AGE_BUCKETS[0]!) return 'age-1';
  if (age < TELOMERE_AGE_BUCKETS[1]!) return 'age-2';
  return 'age-3';
}

function lineRow(page: PageSnapshot, rendered: RenderedLine, previousVisit: Visit | null): HtmlEscapedString {
  const line = page.lines.find((candidate) => candidate.id === rendered.lineId)!;
  const unread = previousVisit === null || line.updatedVersion > previousVisit.lastSeenVersion;
  return html`<div class="line-row" id="L${line.id}">
<span class="telomere${unread ? ' unread' : ''} ${ageClass(page, line.updated)}" data-updated="${line.updated}" data-user="${line.userId}"></span>
${rendered.html}
</div>` as unknown as HtmlEscapedString;
}

function relatedSection(title: string, pages: { title: string }[], projectName: string): HtmlEscapedString {
  if (pages.length === 0) return html`` as unknown as HtmlEscapedString;
  return html`<section><h2>${title}</h2><ul>${pages.map(
    (page) => html`<li><a href="/${encodeURIComponent(projectName)}/${encodeTitleForUrl(page.title)}">${page.title}</a></li>`,
  )}</ul></section>` as unknown as HtmlEscapedString;
}

export function pageViewPage(
  project: Project,
  page: PageSnapshot,
  rendered: RenderedLine[],
  previousVisit: Visit | null,
  related: RelatedPages,
): HtmlEscapedString {
  return layout(page.title, html`
<h1>${page.title}</h1>
${related.hasBackLinks ? html`<p class="backlinks-badge">逆リンクまたはアイコン参照あり</p>` : ''}
<div class="page-body">${rendered.map((line) => lineRow(page, line, previousVisit))}</div>
${relatedSection('関連ページ', related.links1hop, project.name)}
${relatedSection('2-hop リンク', related.links2hop, project.name)}
<script src="/assets/line-ui.js" defer></script>`,
  );
}

export function pageNotFoundPage(project: Project, title: string): HtmlEscapedString {
  const editHref = `/${encodeURIComponent(project.name)}/${encodeTitleForUrl(title)}/edit`;
  return layout('ページが見つかりません', html`
<h1>「${title}」はまだありません</h1>
<a href="${editHref}">このタイトルで新規作成する</a>`,
  );
}

export function projectNotFoundPage(projectName: string): HtmlEscapedString {
  return layout('プロジェクトが見つかりません', html`
<main>
<h1>プロジェクトが見つかりません</h1>
<p>「${projectName}」というプロジェクトはありません。</p>
<a href="/">プロジェクト一覧へ戻る</a>
</main>`,
  );
}
