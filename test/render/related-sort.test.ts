import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareRelatedCards,
  isRelatedSort,
  matchesRelatedFilter,
  relatedFilterTerms,
  type RelatedCardKeys,
  type RelatedSort,
} from '../../src/render/relatedSort.ts';

function card(index: number, title: string, values: Partial<RelatedCardKeys> = {}): RelatedCardKeys {
  return { index, title, created: 0, updated: 0, accessed: 0, linked: 0, ...values };
}

function titles(cards: RelatedCardKeys[], sort: RelatedSort): string[] {
  return cards.toSorted(compareRelatedCards(sort)).map(({ title }) => title);
}

void test('関連度は閲覧表示の順のまま並べる', () => {
  const cards = [card(2, 'c', { updated: 3 }), card(0, 'a', { updated: 1 }), card(1, 'b', { updated: 2 })];
  assert.deepEqual(titles(cards, 'related'), ['a', 'b', 'c']);
});

void test('日時と被リンク数は大きい順に並べ、同じ値の札は関連度の順に置く', () => {
  const cards = [
    card(0, 'first', { updated: 10, created: 1, accessed: 5, linked: 2 }),
    card(1, 'second', { updated: 30, created: 3, accessed: 5, linked: 0 }),
    card(2, 'third', { updated: 20, created: 2, accessed: 9, linked: 2 }),
  ];
  assert.deepEqual(titles(cards, 'updated'), ['second', 'third', 'first']);
  assert.deepEqual(titles(cards, 'created'), ['second', 'third', 'first']);
  assert.deepEqual(titles(cards, 'accessed'), ['third', 'first', 'second']);
  assert.deepEqual(titles(cards, 'linked'), ['first', 'third', 'second']);
});

void test('タイトルは小文字にしたタイトルの文字コードの昇順に並べる', () => {
  // Cosense の並び（scrapboxlab「UserScript」）と同じく、記号・数字・英字（大文字と小文字を区別しない）・仮名の順。
  const cards = [
    card(0, 'いい感じ'),
    card(1, 'tosho'),
    card(2, 'Texの行列'),
    card(3, 'TeXで書いた'),
    card(4, '1操作'),
    card(5, '#マーク'),
    card(6, 'Scrapbox で下書き'),
    card(7, 'ScrapboxSaver'),
  ];
  assert.deepEqual(titles(cards, 'title'), [
    '#マーク',
    '1操作',
    'Scrapbox で下書き',
    'ScrapboxSaver',
    'TeXで書いた',
    'Texの行列',
    'tosho',
    'いい感じ',
  ]);
  // 小文字にして同じタイトルは、関連度の順。
  assert.deepEqual(titles([card(1, 'abc'), card(0, 'ABC')], 'title'), ['ABC', 'abc']);
});

void test('並び替えの名前だけを並び替えとして受け付ける', () => {
  assert.equal(isRelatedSort('title'), true);
  assert.equal(isRelatedSort('pageRank'), false);
  assert.equal(isRelatedSort(null), false);
});

void test('絞り込みは空白で区切った語を、大文字と小文字を区別せずにすべて探す', () => {
  assert.deepEqual(relatedFilterTerms('  API　Script\tページ '), ['api', 'script', 'ページ']);
  assert.deepEqual(relatedFilterTerms('　'), []);
  const text = 'UserScriptから使えるscrapboxのobject\n[API] の説明\nscrapbox.page.title';
  assert.equal(matchesRelatedFilter(text, relatedFilterTerms('script user')), true);
  assert.equal(matchesRelatedFilter(text, relatedFilterTerms('api')), true);
  assert.equal(matchesRelatedFilter(text, relatedFilterTerms('user missing')), false);
  assert.equal(matchesRelatedFilter(text, []), true);
});
