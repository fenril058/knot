// テロメアの更新日時とメニュー（#173 / #195）。Cosense と同じく、テロメアの右に幅 160px の帯で
// 「<日時>に更新」を出し、押したときはその下に行へのリンクをコピーする項目を足す。閲覧表示のテロメア
// （lineUi）と、編集表示の gutter のテロメア（cm/telomere.ts）の両方がこの 1 つの帯を使う。

export type TelomereTarget = {
  anchor: HTMLElement;
  updated: number;
  // 行へのリンクに使う行の ID。サーバにまだ無い行には無い。
  lineId: string | undefined;
  // リンクと一緒にコピーするページのタイトル。編集でタイトルが変わるので、コピーするときに読む。
  title: () => string;
};

// Cosense の「2026/1/24 10:53:39に更新」「2020/7/22 2:23:18に更新」と同じ形（月・日・時は 0 で埋めない）。
const updatedFormat = new Intl.DateTimeFormat('ja-JP', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

export function updatedLabel(unixSeconds: number): string {
  return `${updatedFormat.format(new Date(unixSeconds * 1000))}に更新`;
}

type PageLocation = Pick<Location, 'origin' | 'pathname'>;

// 行へのリンク。Cosense と同じく、URL の fragment に行の ID をそのまま置く。
export function lineHref(lineId: string, page: PageLocation = location): string {
  return `${page.origin}${page.pathname}#${lineId}`;
}

// fragment が指しうる行の ID。Cosense と同じ #<行の ID> を先に試し、行の要素の id（L<行の ID>）を
// そのまま書いた #L<行の ID> も受ける。
export function linkedLineIds(hash: string): string[] {
  const body = hash.slice(1);
  if (body === '') return [];
  return body.startsWith('L') ? [body, body.slice(1)] : [body];
}

// Cosense の「リーダブルリンク」と同じく、タイトルを percent-encode しない形。URL の区切りになる字と
// 空白・制御文字だけは encode したまま残す。
function readableSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return segment;
  }
  return Array.from(decoded, (char) => (/[/?#%\s\p{Cc}]/u.test(char) ? encodeURIComponent(char) : char)).join('');
}

export function readableLineHref(lineId: string, page: PageLocation = location): string {
  return `${page.origin}${page.pathname.split('/').map(readableSegment).join('/')}#${lineId}`;
}

// コピーは async にして、clipboard API が無いときの例外も reject として受ける。最初の await までは
// 同期に進むので、clipboard への書き込みは押した操作の中で始まる（Safari はそれを求める）。
async function copyLink(target: TelomereTarget, lineId: string): Promise<void> {
  // Cosense と同じく、テキストには「タイトル URL」、HTML には「タイトル#行の ID」を文字にしたリンクを書く。
  const href = lineHref(lineId);
  const title = target.title();
  const link = document.createElement('a');
  link.href = href;
  link.textContent = `${title}#${lineId}`;
  await navigator.clipboard.write([new ClipboardItem({
    'text/plain': new Blob([`${title} ${href}`], { type: 'text/plain' }),
    'text/html': new Blob([link.outerHTML], { type: 'text/html' }),
  })]);
}

async function copyReadableLink(_target: TelomereTarget, lineId: string): Promise<void> {
  await navigator.clipboard.writeText(readableLineHref(lineId));
}

const copyItems = [
  { label: 'リンクをコピー', copy: copyLink },
  { label: 'リーダブルリンクをコピー', copy: copyReadableLink },
];

let panel: HTMLElement | undefined;
let shownFor: TelomereTarget | undefined;
let menuOpen = false;

function closeAndFocusAnchor(): HTMLElement | undefined {
  const anchor = shownFor?.anchor;
  hideTelomereInfo();
  anchor?.focus();
  return anchor;
}

function ensurePanel(): HTMLElement {
  if (panel !== undefined) return panel;
  const element = document.createElement('div');
  element.className = 'telomere-info';
  element.hidden = true;
  element.addEventListener('mouseleave', () => {
    if (!menuOpen) hideTelomereInfo();
  });
  // 帯は本文から離れた body の末尾にあるので、Tab で帯から出るときはテロメアへ戻す。前へ出るときは
  // テロメアに止め、後ろへ出るときはテロメアから既定の Tab で次の要素へ進ませる。
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab') return;
    const items = Array.from(element.querySelectorAll('button'));
    const index = document.activeElement instanceof HTMLButtonElement ? items.indexOf(document.activeElement) : -1;
    if (event.shiftKey ? index > 0 : index < items.length - 1) return;
    if (closeAndFocusAnchor() !== undefined && event.shiftKey) event.preventDefault();
  });
  document.body.append(element);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || element.hidden) return;
    if (element.contains(document.activeElement)) {
      event.preventDefault();
      closeAndFocusAnchor();
    } else {
      hideTelomereInfo();
    }
  });
  // 帯の外を押したら閉じる。テロメアそのものを押したときは、そのテロメアの click が開き直す。
  document.addEventListener('pointerdown', (event) => {
    if (!menuOpen || !(event.target instanceof Node)) return;
    if (element.contains(event.target) || shownFor?.anchor.contains(event.target) === true) return;
    hideTelomereInfo();
  });
  panel = element;
  return element;
}

function place(element: HTMLElement, anchor: HTMLElement): void {
  const box = anchor.getBoundingClientRect();
  // 帯は Cosense と同じく、テロメアの左端から 2px 右、行の上端から出す。
  element.style.left = `${box.left + window.scrollX + 2}px`;
  element.style.top = `${box.top + window.scrollY}px`;
}

function setExpanded(target: TelomereTarget | undefined, expanded: boolean): void {
  if (target?.anchor instanceof HTMLButtonElement) target.anchor.setAttribute('aria-expanded', String(expanded));
}

function render(target: TelomereTarget, withMenu: boolean): HTMLElement {
  const element = ensurePanel();
  const updated = document.createElement('div');
  updated.className = 'telomere-updated';
  updated.textContent = updatedLabel(target.updated);
  // Cosense の帯はテロメアの中にあり、帯を押すことはテロメアを押すことと同じ。knot の帯は
  // body に置くので、押されたらテロメアの click として渡す。detail（押した回数、キーボードなら 0）は
  // 元の click のものを渡し、マウスで押したのにメニューへ focus が移らないようにする。
  if (!withMenu) {
    updated.addEventListener('click', (event) => {
      target.anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: event.detail }));
    });
  }
  const items: HTMLElement[] = [updated];
  // clipboard は安全なコンテキスト（HTTPS か localhost）でしか使えない。使えないときは、押したときに
  // 行へのリンクになった URL をアドレスバーからコピーしてもらう。
  if (withMenu && target.lineId !== undefined && window.isSecureContext) {
    const lineId = target.lineId;
    for (const { label, copy } of copyItems) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'telomere-menu-item';
      button.textContent = label;
      button.addEventListener('click', () => {
        copy(target, lineId).catch((error: unknown) => console.error('failed to copy the line link', error));
        closeAndFocusAnchor();
      });
      items.push(button);
    }
  }
  element.replaceChildren(...items);
  place(element, target.anchor);
  element.hidden = false;
  if (shownFor !== target) setExpanded(shownFor, false);
  shownFor = target;
  setExpanded(target, withMenu);
  return element;
}

// hover で「<日時>に更新」だけを出す。メニューを開いている間は出し直さない。
export function showTelomereUpdated(target: TelomereTarget): void {
  if (menuOpen) return;
  render(target, false);
}

// 押したときのメニュー。Cosense と同じく、開いているテロメアをもう一度押しても閉じない。
// キーボードで開いたときは、メニューの最初の項目へ focus を移す。
export function openTelomereMenu(target: TelomereTarget, focusFirst: boolean): void {
  menuOpen = true;
  const element = render(target, true);
  if (focusFirst) element.querySelector<HTMLElement>('.telomere-menu-item')?.focus();
}

export function hideTelomereInfo(): void {
  setExpanded(shownFor, false);
  menuOpen = false;
  shownFor = undefined;
  if (panel !== undefined) {
    panel.hidden = true;
    panel.replaceChildren();
  }
}

// hover の帯は、テロメアから外れたら消す（帯へ移ったときは帯の mouseleave が消す）。
export function leaveTelomere(event: MouseEvent): void {
  if (menuOpen) return;
  if (event.relatedTarget instanceof Node && panel?.contains(event.relatedTarget) === true) return;
  hideTelomereInfo();
}
