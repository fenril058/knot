import { html } from 'hono/html';
import { extractRefs } from '../../core/links.ts';
import type { Line } from '../../core/ops.ts';
import { pageHref, titleLc } from '../../core/title.ts';
import { knownPageMap, type IndentMark } from '../../render/presentation.ts';
import { relatedSorts, relatedSortTabs } from '../../render/relatedSort.ts';
import type { KnownPage, RenderConfig, RenderedLine } from '../../render/render.ts';
import { telomereWidth } from '../../render/telomere.ts';
import type { PageSnapshot, Project, RelatedPage, RelatedPages, Visit } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';
import { canDisplayCardImage, pageCardListItem } from './pageCard.ts';
import { pageNav } from './pageNav.ts';
import { sortMenu } from './sortMenu.ts';

function knownTitleMap(knownPages: readonly KnownPage[]): Map<string, string> {
  return new Map(knownPages.map(({ title }) => [titleLc(title), title]));
}

function projectLink(project: Project): Html {
  return html`<a href="/${encodeURIComponent(project.name)}">${project.displayName}</a>`;
}

function nestIndentedLine(content: Html, indent: number, mark: IndentMark): Html {
  if (indent === 0) return content;
  const className = mark === 'dot' ? 'line-indent-content' : `line-indent-content mark-${mark}`;
  return html`<span class="line-indent-prefix" aria-hidden="true">${'\u2003'.repeat(indent)}</span><div class="${className}">${content}</div>`;
}

// テロメアの線の太さは、表示した時刻からの行の経過時間で決める（Cosense と同じく、ページの中の相対値ではない）。
// テロメアは押せるボタン（#173）。行のあいだは矢印キーで移るので、tab stop は先頭の行の 1 つだけにする。
function lineRow(line: Line, rendered: RenderedLine, previousVisit: Visit | null, now: number, first: boolean): Html {
  const unread = previousVisit === null || line.updatedVersion > previousVisit.lastSeenVersion;
  const width = telomereWidth(now - line.updated);
  const classes = ['line-row'];
  if (rendered.codeBlock) classes.push('code-block-line');
  if (rendered.linkOnly) classes.push('link-only');
  return html`<div class="${classes.join(' ')}" id="L${line.id}">
<button type="button" class="telomere${unread ? ' unread' : ''} w-${width}" tabindex="${first ? '0' : '-1'}" aria-label="行の更新日時" data-updated="${line.updated}"></button>
${nestIndentedLine(rendered.html, rendered.indent, rendered.mark)}
</div>`;
}

// ページメニューのボタンの印（Cosense の Page info menu と Page edit menu）。色は文字色に従う。
const infoIcon = html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><circle cx="12" cy="7.5" r="1.25" fill="currentColor"/></svg>`;
const shuffleIcon = html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M3 7h3.5c2.2 0 3.6 1 4.8 3l1.4 2.4c1.2 2 2.6 3 4.8 3H21M3 17h3.5c2.2 0 3.6-1 4.8-3M14.5 9c1-1.3 2.2-2 4-2H21M18 4l3 3-3 3M18 13l3 3-3 3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>`;
const documentIcon = html`<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><path d="M6 3h8l4 4v14H6z" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2"/><path d="M14 3v4h4M9 12h6M9 16h6" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/></svg>`;

// ページの作成・更新の日時。閲覧者の時間帯と相対の日時は page-menu.js が書き直すので、
// サーバでは時間帯によらない UTC の日時を置く。
function pageTime(unixSeconds: number): Html {
  const iso = new Date(unixSeconds * 1000).toISOString();
  return html`<time datetime="${iso}">${iso.slice(0, 16).replace('T', ' ')} UTC</time>`;
}

// 関連ページの見出しの札に添えるリンクの印。色は文字色（currentColor）に従う。
const linkIcon = html`<svg class="relation-label-icon" viewBox="0 0 24 24" width="36" height="36" aria-hidden="true" focusable="false"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/></svg>`;
// 「New Links」の見出しの札に添える、切れたリンクの印（#283）。
const linkOffIcon = html`<svg class="relation-label-icon" viewBox="0 0 24 24" width="36" height="36" aria-hidden="true" focusable="false"><path d="m12.5 6.5 2-2a3.54 3.54 0 0 1 5 5l-2 2M11.5 17.5l-2 2a3.54 3.54 0 0 1-5-5l2-2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2"/><path d="M9 4.5v2M4.5 9h2M15 19.5v-2M19.5 15h-2" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/></svg>`;
// 「New Links」の札で、説明文の代わりに描く 5 本の線（#283）。
const cardPlaceholder = html`<span class="card-placeholder" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></span>`;

type RelatedGroup = { label: string; href: string | null; pages: RelatedPage[] };

// 関連度の順（#278）。Cosense の関連ページの既定の並びと同じく、このページがリンクする札（前方リンク）を先に、
// 次に「札がこのページにリンクしていれば 1」と「札とこのページが共通にリンクするリンク先の数」の和の大きい順、
// 同じなら更新日時の新しい順に並べる。2-hop の札の linksLc は共有するリンク先だけなので、共有する数の順になる。
function byRelevance(pages: readonly RelatedPage[], pageTitleLc: string, pageLinks: ReadonlySet<string>): RelatedPage[] {
  const keyed = pages.map((related) => ({
    related,
    forward: pageLinks.has(related.titleLc) ? 1 : 0,
    score: (related.linksLc.includes(pageTitleLc) ? 1 : 0) + related.linksLc.filter((link) => pageLinks.has(link)).length,
  }));
  return keyed
    .toSorted((left, right) =>
      right.forward - left.forward || right.score - left.score || right.related.updated - left.related.updated)
    .map(({ related }) => related);
}

// 2-hop の札を、このページと共有するリンク先ごとの行に分ける。Cosense と同じく、本文のリンクの順に
// リンク先をたどり、そのリンク先を共有する札のうち、まだどの行にも入っていない札をその行に置く（#278）。
// 見出しはリンク先のページのタイトル（無ければ書かれたリンク）。
function twoHopGroups(
  links2hop: readonly RelatedPage[],
  pageLinks: readonly { title: string; titleLc: string }[],
  projectName: string,
  knownTitles: ReadonlyMap<string, string>,
  order: (pages: readonly RelatedPage[]) => RelatedPage[],
): RelatedGroup[] {
  const written = new Map(pageLinks.map((link) => [link.titleLc, link.title]));
  // 本文から読めないリンク先（保存した時の本文と、いまの本文の違いなど）を共有する札も落とさず、後ろの行に置く。
  const targets = [...new Set([...written.keys(), ...links2hop.flatMap((related) => related.linksLc)])];
  const position = new Map(targets.map((target, index) => [target, index]));
  const rows = new Map<string, RelatedPage[]>();
  for (const related of links2hop) {
    const first = related.linksLc.toSorted((left, right) => (position.get(left) ?? 0) - (position.get(right) ?? 0))[0];
    if (first === undefined) continue;
    const row = rows.get(first);
    if (row === undefined) rows.set(first, [related]);
    else row.push(related);
  }
  return targets.flatMap((target) => {
    const pages = rows.get(target);
    if (pages === undefined) return [];
    const label = knownTitles.get(target) ?? written.get(target) ?? target;
    return [{ label, href: pageHref(projectName, label), pages: order(pages) }];
  });
}

// 札の並び替えと絞り込みに使う値（#281）。絞り込みは、Cosense と同じく札のタイトル・説明文・リンク先で探す。
function relatedCardData(related: RelatedPage): Html {
  const search = [related.title, ...related.descriptions, ...related.linksLc].join('\n');
  return html` data-title="${related.title}" data-created="${related.created}" data-updated="${related.updated}" data-accessed="${related.accessed}" data-linked="${related.linked}" data-search="${search}"`;
}

function relatedGroupList(
  group: RelatedGroup,
  projectName: string,
  allowedImageHosts: string[],
  knownPages: ReadonlyMap<string, KnownPage>,
  eagerImagePageId: string | null,
): Html {
  const labelClass = group.href === null ? 'relation-label links' : 'relation-label headword';
  const labelBody = html`<span class="relation-label-title">${group.label}</span>${linkIcon}`;
  return html`<ul class="card-grid related-group" role="list" aria-label="${group.label}"><li class="${labelClass}">${group.href === null
    ? html`<span class="relation-label-card">${labelBody}</span>`
    : html`<a class="relation-label-card" href="${group.href}">${labelBody}</a>`}</li>${group.pages.map((related) =>
    pageCardListItem(projectName, related, allowedImageHosts, {
      headingLevel: 3,
      imageLoading: related.id === eagerImagePageId ? 'eager' : 'lazy',
      knownPages,
      itemAttributes: relatedCardData(related),
    }),
  )}</ul>`;
}

// 絞り込み欄の検索の印。色は文字色に従う。
const filterIcon = html`<svg class="related-filter-icon" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false"><circle cx="5.75" cy="5.75" r="4.25" fill="none" stroke="currentColor" stroke-width="2.5"/><path d="m9 9 3.5 3.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-width="2.75"/></svg>`;

// 関連ページの絞り込み欄と並び替え（#281）。Cosense の関連ページの toolbar と同じ並びで、動きは
// related-pages.js が付ける。広い画面では関連度と更新日時をタブに、残りを menu に置き、狭い画面では
// すべてを menu に置く（CSS で切り替える）。閲覧表示は関連度の順で描く。
function relatedToolbar(): Html {
  const [initial] = relatedSorts;
  const pressed = (key: string): string => (key === initial.key ? 'true' : 'false');
  const tabs = relatedSorts.filter(({ key }) => relatedSortTabs.includes(key));
  return html`<div class="related-toolbar">
<div class="related-filter">${filterIcon}<input class="related-filter-input" type="search" autocomplete="off" spellcheck="false" aria-label="関連ページを絞り込む"></div>
<div class="related-sort" data-tab-selected="${String(relatedSortTabs.includes(initial.key))}">
<div class="related-sort-tabs" role="group" aria-label="並び替え">${tabs.map(({ key, label }) =>
    html`<button type="button" class="tool-button related-sort-tab" data-sort="${key}" aria-pressed="${pressed(key)}">${label}</button>`)}</div>
${sortMenu('related-sort-menu', initial.label, html`${relatedSorts.map(({ key, label }) => (relatedSortTabs.includes(key)
    ? html`<button type="button" data-sort="${key}" data-tab-sort aria-pressed="${pressed(key)}">${label}</button>`
    : html`<button type="button" data-sort="${key}" aria-pressed="${pressed(key)}">${label}</button>`))}`)}
</div>
</div>`;
}

type PageLink = { title: string; titleLc: string };
// 関連ページを描くのに使う、ページのタイトルと行。ページの無いタイトル（#289）では行が無い。
type RelatedSource = Pick<PageSnapshot, 'title' | 'lines'>;

// 本文（タイトル行を除く）のリンク先。本文のリンクの順。
function pageLinkTargets(page: RelatedSource): PageLink[] {
  return extractRefs(page.lines.slice(1).map(({ text }) => text).join('\n')).linkTargets;
}

// 関連ページの札のリンク先。ほかのページがこのページのリンク先にリンクしていれば、そのページは 1-hop の札
// （linksLc はそのページのすべてのリンク先）か 2-hop の札（linksLc は共有するリンク先）なので、ここに現れる。
function linkedByRelatedPages(related: RelatedPages): Set<string> {
  return new Set([...related.links1hop, ...related.links2hop].flatMap((relatedPage) => relatedPage.linksLc));
}

// 本文のリンク先のうち、ページは無いが、ほかのページからリンクされているもの（#285）。Cosense と同じく空リンクの
// 色にしないので、閲覧表示と編集表示がリンクの見た目を決める既知のページに足す。
export function linkedEmptyPages(page: RelatedSource, related: RelatedPages, knownTitlesLc: ReadonlySet<string>): KnownPage[] {
  const linked = linkedByRelatedPages(related);
  return pageLinkTargets(page)
    .filter((link) => !knownTitlesLc.has(link.titleLc) && linked.has(link.titleLc))
    .map((link) => ({ title: link.title, image: null }));
}

// 本文のリンク先のうち、ページが無く、ほかのどのページからもリンクされていないもの（#283）。本文のリンクの順。
function newLinkTargets(pageLinks: readonly PageLink[], related: RelatedPages, knownTitles: ReadonlyMap<string, string>): PageLink[] {
  const linked = linkedByRelatedPages(related);
  return pageLinks.filter((link) => !knownTitles.has(link.titleLc) && !linked.has(link.titleLc));
}

// 「New Links」の行（#283）。Cosense と同じく関連ページの最後に置き、見出しの札は空リンクの色、札はそのページへの
// リンクで、説明文の代わりに線を描く。絞り込みはタイトルで探す。
function newLinksList(links: readonly PageLink[], projectName: string): Html {
  return html`<ul class="card-grid related-group" role="list" aria-label="New Links"><li class="relation-label empty-links"><span class="relation-label-card"><span class="relation-label-title">New Links</span>${linkOffIcon}</span></li>${links.map(({ title }) =>
    html`<li class="new-link" data-title="${title}" data-search="${title}"><a class="card" href="${pageHref(projectName, title)}">
<h3>${title}</h3>
${cardPlaceholder}
</a></li>`)}</ul>`;
}

// 関連ページ（#249）。Cosense と同じく見出しを置かず、行の先頭に札と同じ大きさの見出しの札を置く。
// 1-hop の行は「Links」、2-hop の行は共有するリンク先の名前、最後の行は「New Links」の札で始まる。
function relatedSection(
  page: RelatedSource,
  related: RelatedPages,
  projectName: string,
  allowedImageHosts: string[],
  knownPages: readonly KnownPage[],
): Html {
  const pageLinks = pageLinkTargets(page);
  const linkSet = new Set(pageLinks.map((link) => link.titleLc));
  const knownTitles = knownTitleMap(knownPages);
  const order = (pages: readonly RelatedPage[]): RelatedPage[] => byRelevance(pages, titleLc(page.title), linkSet);
  const groups: RelatedGroup[] = [
    ...(related.links1hop.length === 0 ? [] : [{ label: 'Links', href: null, pages: order(related.links1hop) }]),
    ...twoHopGroups(related.links2hop, pageLinks, projectName, knownTitles, order),
  ];
  const newLinks = newLinkTargets(pageLinks, related, knownTitles);
  if (groups.length === 0 && newLinks.length === 0) return html``;
  // 画面で最初に現れる画像の札だけ、画像をすぐに読む。
  const eagerImagePageId = groups.flatMap((group) => group.pages)
    .find((relatedPage) => canDisplayCardImage(relatedPage.image, allowedImageHosts))?.id ?? null;
  const cardPages = knownPageMap(knownPages);
  return html`<section class="related-pages" aria-labelledby="related-pages-title"><h2 id="related-pages-title" class="visually-hidden">関連ページ</h2>${relatedToolbar()}${groups.map((group) =>
    relatedGroupList(group, projectName, allowedImageHosts, cardPages, eagerImagePageId),
  )}${newLinks.length === 0 ? '' : newLinksList(newLinks, projectName)}</section>`;
}

function editConflictPanel(): Html {
  return html`<section id="edit-conflict" class="edit-conflict" aria-labelledby="edit-conflict-title" tabindex="-1" hidden>
<h2 id="edit-conflict-title">同じ行の編集が競合しました</h2>
<p>手元の内容はエディタに残っています。基準とサーバ上の内容を確認して編集し、現在の内容で保存してください。</p>
<ol id="edit-conflict-list"></ol>
<button type="button" id="resolve-edit-conflict">現在の内容で保存する</button>
</section>`;
}

function recoveryDialog(): Html {
  return html`<dialog id="recovery-dialog" aria-labelledby="recovery-dialog-title">
<h2 id="recovery-dialog-title">未保存の編集があります</h2>
<p>復元する内容を選んでください。別のタブで編集中の内容も含まれる場合があります。</p>
<ul id="recovery-records"></ul>
<button type="button" id="start-fresh-edit">復元せずに編集する</button>
</dialog>`;
}

export function pageViewPage(
  project: Project,
  page: PageSnapshot,
  rendered: RenderedLine[],
  previousVisit: Visit | null,
  related: RelatedPages,
  userName: string,
  styleNonce: string,
  renderConfig: RenderConfig,
  knownPages: readonly KnownPage[],
  now: number,
): Html {
  return layout(page.title, html`
${pageNav(project.name, projectLink(project), { pageMenu: true })}
<main>
<div class="page-column">
<div class="page-menu">
<div id="page-menu-root" data-project="${project.name}" data-title="${page.title}" data-page-id="${page.id}" data-version="${page.version}">
<details id="page-info" class="page-actions">
<summary aria-label="ページ情報">${infoIcon}</summary>
<div class="page-actions-menu page-info-menu">
<p class="page-info-row">作成 ${pageTime(page.created)}</p>
<p class="page-info-row">更新 ${pageTime(page.updated)}</p>
</div>
</details>
<details id="page-actions" class="page-actions">
<summary aria-label="ページの操作">${documentIcon}</summary>
<div class="page-actions-menu">
<button type="button" id="duplicate-button">複製</button>
<button type="button" id="rename-button">リネーム</button>
<button type="button" id="delete-button">削除</button>
</div>
</details>
<a class="page-menu-link" href="/${encodeURIComponent(project.name)}/random/page" aria-label="ランダムなページへ移る">${shuffleIcon}</a>
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
</div>
<div class="page-main">
<div id="save-status" aria-live="polite" hidden></div>
${editConflictPanel()}
${recoveryDialog()}
<div class="page">
<div
  id="editor-root"
  class="page-body"
  data-project="${project.name}"
  data-page-id="${page.id}"
  data-title="${page.title}"
  data-user-name="${userName}"
  data-last-seen-version="${previousVisit?.lastSeenVersion ?? 0}"
  data-csp-nonce="${styleNonce}"
  data-allowed-image-hosts="${JSON.stringify(renderConfig.allowedImageHosts)}"
  data-allowed-media-hosts="${JSON.stringify(renderConfig.allowedMediaHosts)}"
  data-known-pages="${JSON.stringify(knownPages)}"
  data-rendered-at="${now}"
>${rendered.map((line, index) => lineRow(page.lines[index]!, line, previousVisit, now, index === 0))}</div>
</div>
${relatedSection(page, related, project.name, renderConfig.allowedImageHosts, knownPages)}
</div>
</div>
</main>
<script type="module" src="/assets/build/line-ui.js"></script>
<script type="module" src="/assets/build/related-pages.js"></script>
<script type="module" src="/assets/build/page-menu.js"></script>
<script type="module" src="/assets/build/editor.js"></script>
<script type="module" src="/assets/build/search.js"></script>`,
  );
}

// ページの無いタイトルの画面（#289）。Cosense と同じく、タイトルの行だけの紙面を不透明度を下げて描き、その下に、
// このタイトルへリンクしているページを関連ページとして描く。ページのあるときと同じく、タイトルの行を押すか
// ctrl(cmd) + e で編集を始め、字を書いたときにページができる。テロメアは未読の太さで描くが、行がまだ無いので押せない。
export function emptyPageView(
  project: Project,
  title: string,
  related: RelatedPages,
  userName: string,
  styleNonce: string,
  renderConfig: RenderConfig,
  knownPages: readonly KnownPage[],
): Html {
  return layout(title, html`
${pageNav(project.name, projectLink(project))}
<main>
<div class="page-column">
<div class="page-main">
<div id="save-status" aria-live="polite" hidden></div>
${editConflictPanel()}
${recoveryDialog()}
<div class="page not-persistent">
<div
  id="editor-root"
  class="page-body"
  data-project="${project.name}"
  data-title="${title}"
  data-user-name="${userName}"
  data-last-seen-version="0"
  data-csp-nonce="${styleNonce}"
  data-allowed-image-hosts="${JSON.stringify(renderConfig.allowedImageHosts)}"
  data-allowed-media-hosts="${JSON.stringify(renderConfig.allowedMediaHosts)}"
  data-known-pages="${JSON.stringify(knownPages)}"
><div class="line-row" id="Lnew-title">
<span class="telomere unread w-10" aria-hidden="true"></span>
<h1 class="line-title">${title}</h1>
</div></div>
</div>
${relatedSection({ title, lines: [] }, related, project.name, renderConfig.allowedImageHosts, knownPages)}
</div>
</div>
</main>
<script type="module" src="/assets/build/related-pages.js"></script>
<script type="module" src="/assets/build/editor.js"></script>
<script type="module" src="/assets/build/search.js"></script>`,
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
