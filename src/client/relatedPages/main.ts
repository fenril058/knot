import {
  compareRelatedCards,
  isRelatedSort,
  matchesRelatedFilter,
  relatedFilterTerms,
  relatedSorts,
  relatedSortTabs,
  type RelatedCardKeys,
  type RelatedSort,
} from '../../render/relatedSort.ts';

// 関連ページの絞り込み欄と並び替え（#281）。閲覧表示の toolbar に Cosense と同じ動きを付ける。
// 並び替えは行の並びを変えずに各行の中の札を並べ替え、選んだ並び替えはブラウザに残す（Cosense も localStorage に
// 残し、ほかのページやプロジェクトでも同じ並び替えにする）。絞り込みは、語をすべて含む札だけを残し、札の残らない
// 行を見出しの札ごと隠す。

const STORAGE_KEY = 'knot:related-sort';

type Card = { item: HTMLLIElement; keys: RelatedCardKeys; text: string };
type Group = { list: HTMLUListElement; cards: Card[] };

function numberData(item: HTMLElement, name: string): number {
  const value = Number(item.dataset[name]);
  return Number.isFinite(value) ? value : 0;
}

// 行の中の札（見出しの札を除く）と、その並び替えと絞り込みに使う値。index は閲覧表示での順（関連度の順）。
function groupOf(list: HTMLUListElement): Group {
  const items = Array.from(list.children).filter((item): item is HTMLLIElement =>
    item instanceof HTMLLIElement && item.dataset.search !== undefined);
  return {
    list,
    cards: items.map((item, index) => ({
      item,
      keys: {
        index,
        title: item.dataset.title ?? '',
        created: numberData(item, 'created'),
        updated: numberData(item, 'updated'),
        accessed: numberData(item, 'accessed'),
        linked: numberData(item, 'linked'),
      },
      text: item.dataset.search ?? '',
    })),
  };
}

function storedSort(): RelatedSort {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isRelatedSort(value) ? value : 'related';
  } catch {
    return 'related';
  }
}

function storeSort(sort: RelatedSort): void {
  try {
    localStorage.setItem(STORAGE_KEY, sort);
  } catch {
    // 残せなくても、このページの並び替えは効く。
  }
}

function setUp(section: HTMLElement): void {
  const sortRoot = section.querySelector('.related-sort');
  const menu = section.querySelector('.related-sort-menu');
  const summary = menu?.querySelector('summary');
  const current = section.querySelector('.related-sort-current');
  const input = section.querySelector('.related-filter-input');
  if (!(sortRoot instanceof HTMLElement) || !(menu instanceof HTMLDetailsElement) || !(summary instanceof HTMLElement)
    || !(current instanceof HTMLElement) || !(input instanceof HTMLInputElement)) return;
  const groups = Array.from(section.querySelectorAll('ul.related-group'))
    .filter((list): list is HTMLUListElement => list instanceof HTMLUListElement)
    .map(groupOf);
  const buttons = Array.from(sortRoot.querySelectorAll('button[data-sort]'))
    .filter((button): button is HTMLButtonElement => button instanceof HTMLButtonElement);

  const applySort = (sort: RelatedSort): void => {
    const compare = compareRelatedCards(sort);
    for (const { list, cards } of groups) {
      list.append(...cards.toSorted((left, right) => compare(left.keys, right.keys)).map(({ item }) => item));
    }
    sortRoot.dataset.tabSelected = String(relatedSortTabs.includes(sort));
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.sort === sort));
    current.textContent = relatedSorts.find(({ key }) => key === sort)?.label ?? '';
  };

  const applyFilter = (): void => {
    const terms = relatedFilterTerms(input.value);
    for (const { list, cards } of groups) {
      for (const { item, text } of cards) item.hidden = !matchesRelatedFilter(text, terms);
      list.hidden = cards.every(({ item }) => item.hidden);
    }
  };

  for (const button of buttons) {
    button.addEventListener('click', () => {
      const sort = button.dataset.sort;
      if (!isRelatedSort(sort)) return;
      applySort(sort);
      storeSort(sort);
      if (!menu.contains(button)) return;
      menu.open = false;
      summary.focus();
    });
  }
  input.addEventListener('input', applyFilter);
  // Cosense の menu と同じく、Escape と menu の外を押したときに閉じる。
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !menu.open) return;
    menu.open = false;
    summary.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (menu.open && !(event.target instanceof Node && menu.contains(event.target))) menu.open = false;
  });

  const initial = storedSort();
  if (initial !== 'related') applySort(initial);
}

const section = document.querySelector('.related-pages');
if (section instanceof HTMLElement) setUp(section);
