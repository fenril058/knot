// 編集中のページへのページ操作（複製・リネーム・削除）の前に、手元の編集を保存し終えるための
// 約束事（#192）。ページメニューが document へ SETTLE_EDITS_EVENT を投げ、編集中の Editor が
// detail.settled に「保存し終えたときのページの版とタイトル」を返す Promise を入れる。
// Editor が動いていなければ settled は空のままで、ページメニューは閲覧表示の値を使う。

const SETTLE_EDITS_EVENT = 'knot:settle-edits';

export type SettledPage = { version: number; title: string };

type SettleEditsDetail = { settled: Promise<SettledPage> | undefined };

function isSettleEditsDetail(value: unknown): value is SettleEditsDetail {
  return typeof value === 'object' && value !== null && 'settled' in value;
}

// ページメニューの側。編集中なら、保存し終えたときのページの状態を待つ Promise を返す。
export function requestSettledPage(): Promise<SettledPage> | undefined {
  const detail: SettleEditsDetail = { settled: undefined };
  document.dispatchEvent(new CustomEvent(SETTLE_EDITS_EVENT, { detail }));
  return detail.settled;
}

// Editor の側。編集中でなければ handler は undefined を返す。
export function answerSettleEdits(handler: () => Promise<SettledPage> | undefined): void {
  document.addEventListener(SETTLE_EDITS_EVENT, (event) => {
    if (!(event instanceof CustomEvent) || !isSettleEditsDetail(event.detail)) return;
    event.detail.settled = handler();
  });
}
