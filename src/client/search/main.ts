import { rankTitles } from '../../core/match.ts';
import { pageHref } from '../../core/title.ts';

const DEBOUNCE_MS = 200;

type TitleEntry = { title: string };
type PageHit = { title: string; lines: string[] };

const root = document.querySelector<HTMLElement>('#search-root');
const searchBox = document.querySelector<HTMLInputElement>('#search-box');
const resultsElement = document.querySelector<HTMLElement>('#search-results');
if (root === null || searchBox === null || resultsElement === null) throw new Error('search root is missing');
const results = resultsElement;

const data = root.dataset;
if (data.project === undefined) throw new Error('search data attributes are missing');
const project = data.project;

const createButton = document.querySelector<HTMLButtonElement>('#create-page-button');
const createDialog = document.querySelector<HTMLDialogElement>('#create-page-dialog');
const createForm = document.querySelector<HTMLFormElement>('#create-page-form');
const createTitle = document.querySelector<HTMLInputElement>('#create-page-title');
if (createButton === null || createDialog === null || createForm === null || createTitle === null) {
  throw new Error('create page controls are missing');
}
createButton.addEventListener('click', () => createDialog.showModal());
createForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.location.assign(`${pageHref(project, createTitle.value.trim())}/edit`);
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-dialog-close]')) {
  button.addEventListener('click', () => button.closest('dialog')?.close());
}

let titles: TitleEntry[] | null = null;
let debounceTimer: number | undefined;
let latestSeq = 0;

async function loadTitles(): Promise<TitleEntry[]> {
  if (titles !== null) return titles;
  const res = await fetch(`/api/pages/${encodeURIComponent(project)}/search/titles`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  titles = await res.json() as TitleEntry[];
  return titles;
}

function renderHits<T extends { title: string }>(items: readonly T[], formatLabel: (item: T) => string): void {
  results.replaceChildren();
  if (items.length === 0) {
    results.hidden = true;
    return;
  }
  results.hidden = false;
  for (const item of items) {
    const a = document.createElement('a');
    a.href = pageHref(project, item.title);
    a.className = 'search-hit';
    a.textContent = formatLabel(item);
    results.appendChild(a);
  }
}

async function runFullTextSearch(query: string, seq: number): Promise<void> {
  const res = await fetch(`/api/pages/${encodeURIComponent(project)}/search/query?q=${encodeURIComponent(query)}`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const body = await res.json() as { pages: PageHit[] };
  if (seq !== latestSeq) return;
  renderHits(body.pages, (p) => `${p.title}: ${p.lines[0] ?? ''}`);
}

searchBox.addEventListener('input', (event) => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const query = (event.target as HTMLInputElement).value.trim();
  const seq = ++latestSeq;
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
  if (query === '') {
    results.replaceChildren();
    results.hidden = true;
    return;
  }

  void (async () => {
    const all = await loadTitles();
    if (seq !== latestSeq) return;
    renderHits(rankTitles(query, all, (t) => t.title), (t) => t.title);
  })();

  debounceTimer = window.setTimeout(() => {
    void runFullTextSearch(query, seq);
  }, DEBOUNCE_MS);
});
