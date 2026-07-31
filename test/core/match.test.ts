import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, normalizeForMatch, rankTitles } from '../../src/core/match.ts';

void test('normalizeForMatch: 大文字小文字とひらがな・カタカナを同一視する', () => {
  assert.equal(normalizeForMatch('ScRaP カタカナ'), 'scrap かたかな');
});

void test('fuzzyScore: 飛ばし部分列に一致する', () => {
  assert.notEqual(fuzzyScore('sbx', 'Scrapbox'), null);
});

void test('fuzzyScore: 部分列に一致しなければ null を返す', () => {
  assert.equal(fuzzyScore('xyz', 'Scrapbox'), null);
});

void test('fuzzyScore: ひらがなとカタカナを同一視する', () => {
  assert.notEqual(fuzzyScore('かたかな', 'カタカナ'), null);
});

void test('fuzzyScore: 空白区切りの全語に語順を問わず一致する', () => {
  assert.notEqual(fuzzyScore('box scrap', 'Scrapbox Box'), null);
  assert.equal(fuzzyScore('box missing', 'Scrapbox Box'), null);
});

void test('fuzzyScore: 大文字小文字を同一視する', () => {
  assert.notEqual(fuzzyScore('SCRAP', 'Scrapbox'), null);
});

void test('rankTitles: 連続一致を飛ばし一致より上位にし、同じ入力の順位は決定的になる', () => {
  const titles = ['s-c-r-a-p', 'Scrapbook', 'Scrapbox'];
  const expected = ['Scrapbox', 'Scrapbook', 's-c-r-a-p'];

  assert.deepEqual(rankTitles('scrap', titles, (title) => title), expected);
  assert.deepEqual(rankTitles('scrap', titles, (title) => title), expected);
});

void test('rankTitles: 同点は候補文字列の辞書順にする', () => {
  assert.deepEqual(
    rankTitles('x', ['x-b', 'x-a'], (title) => title),
    ['x-a', 'x-b'],
  );
});

void test('rankTitles: 空クエリは原本を元の順で全件返す', () => {
  const items = [{ title: 'c' }, { title: 'a' }, { title: 'b' }];
  const ranked = rankTitles('  ', items, (item) => item.title);

  assert.deepEqual(ranked, items);
  assert.equal(ranked[0], items[0]);
});

void test('rankTitles: limit 件で打ち切り、既定値は 20 件にする', () => {
  const titles = Array.from({ length: 25 }, (_, index) => `match ${String(index).padStart(2, '0')}`);

  assert.equal(rankTitles('match', titles, (title) => title).length, 20);
  assert.equal(rankTitles('match', titles, (title) => title, 3).length, 3);
  assert.deepEqual(rankTitles('', titles, (title) => title, 3), titles.slice(0, 3));
});
