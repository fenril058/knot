import { html } from 'hono/html';
import { extractRefs } from '../../core/links.ts';
import type { Line } from '../../core/ops.ts';
import { pageHref, titleLc } from '../../core/title.ts';
import { knownPageMap, type IndentMark } from '../../render/presentation.ts';
import type { KnownPage, RenderConfig, RenderedLine } from '../../render/render.ts';
import { telomereWidth } from '../../render/telomere.ts';
import type { PageSnapshot, Project, RelatedPage, RelatedPages, Visit } from '../../storage/types.ts';
import { layout, type Html } from './layout.ts';
import { canDisplayCardImage, pageCardListItem } from './pageCard.ts';
import { pageNav } from './pageNav.ts';

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
function lineRow(line: Line, rendered: RenderedLine, previousVisit: Visit | null, now: number): Html {
  const unread = previousVisit === null || line.updatedVersion > previousVisit.lastSeenVersion;
  const width = telomereWidth(now - line.updated);
  const classes = ['line-row'];
  if (rendered.codeBlock) classes.push('code-block-line');
  if (rendered.linkOnly) classes.push('link-only');
  return html`<div class="${classes.join(' ')}" id="L${line.id}">
<span class="telomere${unread ? ' unread' : ''} w-${width}" data-updated="${line.updated}" data-user="${line.userId}"></span>
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

type RelatedGroup = { label: string; href: string | null; pages: RelatedPage[] };

// 2-hop の札を、このページと共有するリンク先ごとに分ける。行の順は、このページの中でリンクが
// 最初に現れた順（Cosense と同じ）。見出しはリンク先のページのタイトル（無ければ書かれたリンク）。
function twoHopGroups(
  page: PageSnapshot,
  links2hop: readonly RelatedPage[],
  projectName: string,
  knownTitles: ReadonlyMap<string, string>,
): RelatedGroup[] {
  const targets = extractRefs(page.lines.slice(1).map(({ text }) => text).join('\n')).linkTargets;
  const order = new Map(targets.map((target, index) => [target.titleLc, { index, title: target.title }]));
  const groups = new Map<string, RelatedPage[]>();
  for (const related of links2hop) {
    for (const shared of related.linksLc) groups.set(shared, [...(groups.get(shared) ?? []), related]);
  }
  return [...groups]
    .toSorted(([left], [right]) => (order.get(left)?.index ?? Infinity) - (order.get(right)?.index ?? Infinity))
    .map(([sharedLc, pages]) => {
      const label = knownTitles.get(sharedLc) ?? order.get(sharedLc)?.title ?? sharedLc;
      return { label, href: pageHref(projectName, label), pages };
    });
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
    }),
  )}</ul>`;
}

// 関連ページ（#249）。Cosense と同じく見出しを置かず、行の先頭に札と同じ大きさの見出しの札を置く。
// 1-hop の行は「Links」、2-hop の行は共有するリンク先の名前の札で始まる。
function relatedSection(
  page: PageSnapshot,
  related: RelatedPages,
  projectName: string,
  allowedImageHosts: string[],
  knownPages: readonly KnownPage[],
  eagerImagePageId: string | null,
): Html {
  const groups: RelatedGroup[] = [
    ...(related.links1hop.length === 0 ? [] : [{ label: 'Links', href: null, pages: related.links1hop }]),
    ...twoHopGroups(page, related.links2hop, projectName, knownTitleMap(knownPages)),
  ];
  if (groups.length === 0) return html``;
  const cardPages = knownPageMap(knownPages);
  return html`<section class="related-pages" aria-labelledby="related-pages-title"><h2 id="related-pages-title" class="visually-hidden">関連ページ</h2>${groups.map((group) =>
    relatedGroupList(group, projectName, allowedImageHosts, cardPages, eagerImagePageId),
  )}</section>`;
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
  const eagerImagePageId = [...related.links1hop, ...related.links2hop].find((relatedPage) =>
    canDisplayCardImage(relatedPage.image, renderConfig.allowedImageHosts),
  )?.id ?? null;
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
>${rendered.map((line, index) => lineRow(page.lines[index]!, line, previousVisit, now))}</div>
</div>
${relatedSection(page, related, project.name, renderConfig.allowedImageHosts, knownPages, eagerImagePageId)}
</div>
</div>
</main>
<script src="/assets/line-ui.js" defer></script>
<script type="module" src="/assets/build/page-menu.js"></script>
<script type="module" src="/assets/build/editor.js"></script>
<script type="module" src="/assets/build/search.js"></script>`,
  );
}

export function pageNotFoundPage(
  project: Project,
  title: string,
  userName: string,
  styleNonce: string,
  renderConfig: RenderConfig,
  knownPages: readonly KnownPage[],
): Html {
  return layout('ページが見つかりません', html`
${pageNav(project.name, projectLink(project))}
<main>
<div class="page-column">
<div class="page-main">
<div id="save-status" aria-live="polite" hidden></div>
${editConflictPanel()}
${recoveryDialog()}
<div class="page">
<h1>「${title}」はまだありません</h1>
<button type="button" id="edit-page-button">このタイトルで新規作成する</button>
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
><p>このページはまだ作成されていません。</p></div>
</div>
</div>
</div>
</main>
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
