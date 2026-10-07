// 関連ページの並び替えと絞り込み（#281）。閲覧表示の toolbar（SSR）と、それに動きを付ける
// related-pages.js が同じ定義を使う。並び替えの名前と順は Cosense の関連ページの並び替えと同じ。
// Cosense にある「ページランク」は、knot がページランクを計算しないので置かない。

export const relatedSorts = [
  { key: 'related', label: '関連度' },
  { key: 'updated', label: '更新日時' },
  { key: 'created', label: '作成日時' },
  { key: 'accessed', label: '最終アクセス' },
  { key: 'linked', label: '被リンク数' },
  { key: 'title', label: 'タイトル' },
] as const;

export type RelatedSort = (typeof relatedSorts)[number]['key'];

// 広い画面（992px 以上）で、menu ではなくタブに置く並び替え。
export const relatedSortTabs: readonly RelatedSort[] = ['related', 'updated'];

export function isRelatedSort(value: unknown): value is RelatedSort {
  return relatedSorts.some(({ key }) => key === value);
}

// 札を並べ替えるための値。index は閲覧表示での順（関連度の順）。
export type RelatedCardKeys = {
  index: number;
  title: string;
  created: number;
  updated: number;
  accessed: number;
  linked: number;
};

function byIndex(left: RelatedCardKeys, right: RelatedCardKeys): number {
  return left.index - right.index;
}

function byTitle(left: RelatedCardKeys, right: RelatedCardKeys): number {
  const leftTitle = left.title.toLowerCase();
  const rightTitle = right.title.toLowerCase();
  if (leftTitle === rightTitle) return byIndex(left, right);
  return leftTitle < rightTitle ? -1 : 1;
}

// 関連度は閲覧表示の順のまま。日時と被リンク数は大きい順、タイトルは小文字にしたタイトルの文字コードの昇順。
// 同じ値の札は関連度の順に置く（Cosense で同じ値の札がどの順になるかは確かめきれていない）。
export function compareRelatedCards(sort: RelatedSort): (left: RelatedCardKeys, right: RelatedCardKeys) => number {
  if (sort === 'related') return byIndex;
  if (sort === 'title') return byTitle;
  return (left, right) => right[sort] - left[sort] || byIndex(left, right);
}

// 絞り込みの語。Cosense と同じく、空白（全角の空白も）で区切った語を、大文字と小文字を区別せずに探す。
export function relatedFilterTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter((term) => term !== '');
}

// 札の字（タイトル・説明文・リンク先）が、語をすべて含むか。
export function matchesRelatedFilter(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return terms.every((term) => lower.includes(term));
}
