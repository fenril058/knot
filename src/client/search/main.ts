import { rankTitles } from '../../core/match.ts';
import { pageHref } from '../../core/title.ts';

// 上部のバーの検索欄（#247）。入力中はタイトルの候補を入力欄の下に出す。候補を選ばずに Enter を
// 押したときは form のまま送り、全文検索の結果ページへ移る（JavaScript が無いときと同じ）。
// Cosense と同じく、↓ で候補へ focus を移し、Escape で候補を閉じて検索欄から抜ける。

// 候補の数の上限。Cosense は上限 100 件を、高さ 210px の中で scroll させる。
const CANDIDATE_LIMIT = 100;

type TitleEntry = { title: string };

const navElement = document.querySelector<HTMLElement>('.page-nav');
const formElement = document.querySelector<HTMLFormElement>('.nav-search');
const inputElement = formElement?.querySelector<HTMLInputElement>('.nav-search-input');
const listElement = formElement?.querySelector<HTMLUListElement>('.nav-search-candidates');
if (navElement === null || formElement === null || inputElement == null || listElement == null) {
  throw new Error('search controls are missing');
}
const nav = navElement;
const form = formElement;
const input = inputElement;
const list = listElement;
const toggle = nav.querySelector<HTMLAnchorElement>('.nav-search-toggle');
const projectName = form.dataset.project;
if (projectName === undefined) throw new Error('search data attributes are missing');
const project = projectName;

let titles: Promise<TitleEntry[]> | undefined;
let latestInput = 0;

async function fetchTitles(): Promise<TitleEntry[]> {
  const response = await fetch(`/api/pages/${encodeURIComponent(project)}/search/titles`);
  if (!response.ok) throw new Error(`title list request failed: ${response.status}`);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error('title list must be an array');
  return body.filter((entry: unknown): entry is TitleEntry =>
    typeof entry === 'object' && entry !== null && 'title' in entry && typeof entry.title === 'string');
}

// タイトルの一覧は最初の入力で 1 度だけ取る。失敗したら次の入力で取り直す。
function loadTitles(): Promise<TitleEntry[]> {
  titles ??= fetchTitles().catch((error: unknown) => {
    titles = undefined;
    throw error;
  });
  return titles;
}

function candidateLinks(): HTMLAnchorElement[] {
  return Array.from(list.querySelectorAll<HTMLAnchorElement>('a'));
}

function closeCandidates(): void {
  list.hidden = true;
  list.replaceChildren();
}

function showCandidates(entries: readonly TitleEntry[]): void {
  list.replaceChildren(...entries.map((entry) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.href = pageHref(project, entry.title);
    link.textContent = entry.title;
    item.append(link);
    return item;
  }));
  list.hidden = entries.length === 0;
}

input.addEventListener('input', () => {
  const query = input.value.trim();
  latestInput += 1;
  const current = latestInput;
  if (query === '') {
    closeCandidates();
    return;
  }
  loadTitles().then((all) => {
    // 一覧を待つ間に入力が進んだら、古い入力の候補は出さない。
    if (current !== latestInput) return;
    showCandidates(rankTitles(query, all, (entry) => entry.title, CANDIDATE_LIMIT));
  }).catch((error: unknown) => {
    console.error(error);
    if (current === latestInput) closeCandidates();
  });
});

function leaveSearch(): void {
  closeCandidates();
  if (document.activeElement instanceof HTMLElement && form.contains(document.activeElement)) {
    document.activeElement.blur();
  }
}

form.addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    leaveSearch();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const links = candidateLinks();
  if (list.hidden || links.length === 0) return;
  event.preventDefault();
  const index = event.target instanceof HTMLAnchorElement ? links.indexOf(event.target) : -1;
  const next = event.key === 'ArrowDown' ? Math.min(index + 1, links.length - 1) : index - 1;
  if (next < 0) input.focus();
  else links[next]?.focus();
});

// 検索欄の外を押すか、Tab などで focus が外の要素へ移ったら候補を閉じる。移った先が無い blur では
// 閉じない。Safari は押したリンクに focus を移さないので、候補を tap した瞬間に閉じると click が
// 候補ではなくその下の本文に届いてしまう。外を押したときは pointerdown で閉じる。
document.addEventListener('pointerdown', (event) => {
  if (event.target instanceof Node && !form.contains(event.target)) closeCandidates();
});
form.addEventListener('focusout', (event) => {
  if (event.relatedTarget instanceof Node && !form.contains(event.relatedTarget)) closeCandidates();
});

// 767px 以下の検索ボタン。バーの下に検索欄を開いて入力欄に focus を移す。開いているときは閉じる。
// JavaScript が無いときは検索の結果ページへのリンクなので、ここで button として振る舞わせる。
toggle?.setAttribute('role', 'button');
toggle?.setAttribute('aria-expanded', String(nav.classList.contains('search-open')));
toggle?.addEventListener('click', (event) => {
  event.preventDefault();
  const open = !nav.classList.contains('search-open');
  nav.classList.toggle('search-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  if (open) input.focus();
  else leaveSearch();
});
