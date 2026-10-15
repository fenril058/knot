import {
  hideTelomereInfo,
  leaveTelomere,
  linkedLineIds,
  openTelomereMenu,
  showTelomereUpdated,
  telomereTapEditsLine,
  updatedLabel,
  type TelomereTarget,
} from '../telomereInfo.ts';
import { measureTableColumns, writeTableColumns } from '../tableColumns.ts';

// 閲覧表示の行の操作。行へのリンク（#<行の ID>）で開いた行を強調し、テロメアのボタンで更新日時と
// 行へのリンクのメニューを出す（#173）。

function markHighlighted(row: Element | null): void {
  for (const element of document.querySelectorAll('.line-row.highlight')) element.classList.remove('highlight');
  row?.classList.add('highlight');
}

// 行へのリンクで開いた行（Cosense の .line.permalink）。Cosense と同じく、行の上端（ページの先頭から）に 10px を
// 足しても画面の高さより上なら、行は先頭の画面に入っているので先頭のまま置き、入っていなければ行の上端を画面の
// 上から 100px に置く。同じページの行へのリンクを押したときも、開き直したときと同じ位置にする（#311）。
const LINKED_LINE_TOP = 100;
const FIRST_SCREEN_MARGIN = 10;

function highlight(): void {
  const row = linkedLineIds(location.hash)
    .map((id) => document.getElementById(`L${id}`))
    .find((element) => element?.classList.contains('line-row') === true);
  markHighlighted(row ?? null);
  if (row === undefined || row === null) return;
  const top = row.getBoundingClientRect().top + window.scrollY;
  window.scrollTo(0, top + FIRST_SCREEN_MARGIN < window.innerHeight ? 0 : top - LINKED_LINE_TOP);
}

window.addEventListener('hashchange', highlight);
highlight();

const editorRoot = document.getElementById('editor-root');
const canHover = window.matchMedia('(hover: hover)');

// 表の列の幅を揃える（#276）。閲覧表示にはすべての行があるので、測った幅をそのまま使う。
function alignTables(): void {
  if (editorRoot === null || editorRoot.classList.contains('editor-active')) return;
  const measured = measureTableColumns(editorRoot);
  if (measured.size === 0) return;
  writeTableColumns(new Map(Array.from(measured, ([key, { widths }]) => [key, widths])), editorRoot.dataset.cspNonce);
}

alignTables();
// セルの中の画像（アイコンなど）は、読み込むまで幅が決まらない。
for (const image of editorRoot?.querySelectorAll<HTMLImageElement>('table[data-table] img') ?? []) {
  if (!image.complete) image.addEventListener('load', alignTables, { once: true });
}

function targetOf(button: HTMLElement): TelomereTarget {
  const row = button.closest('.line-row');
  const lineId = row !== null && row.id.startsWith('L') ? row.id.slice(1) : undefined;
  return {
    anchor: button,
    updated: Number(button.dataset.updated),
    lineId,
    title: () => editorRoot?.dataset.title ?? '',
  };
}

const telomeres = Array.from(document.querySelectorAll<HTMLButtonElement>('#editor-root .line-row > .telomere'));

for (const button of telomeres) {
  // 読み上げでは、帯と同じ「<日時>に更新」をボタンの名前にする。
  button.setAttribute('aria-label', updatedLabel(Number(button.dataset.updated)));
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('mouseenter', () => {
    if (canHover.matches) showTelomereUpdated(targetOf(button));
  });
  button.addEventListener('mouseleave', leaveTelomere);
  // 押すと、Cosense と同じく行を強調して URL を行へのリンクにし、メニューを出す。
  // キーボードで押したとき（detail が 0）は、メニューへ focus を移す。touch の端末で指で押したときは、
  // メニューを出さない（その行の編集を editor.js が始める）。
  button.addEventListener('click', (event) => {
    if (telomereTapEditsLine(event)) return;
    const target = targetOf(button);
    if (target.lineId !== undefined) {
      history.replaceState(history.state, '', `#${target.lineId}`);
      markHighlighted(button.closest('.line-row'));
    }
    openTelomereMenu(target, event.detail === 0);
  });
  // テロメアは 1 つの tab stop にまとめ、上下の矢印キーで行のあいだを移る（roving tabindex）。
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const index = telomeres.indexOf(button);
    const next = telomeres[event.key === 'ArrowDown' ? index + 1 : index - 1];
    if (next === undefined) return;
    event.preventDefault();
    hideTelomereInfo();
    button.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });
}
