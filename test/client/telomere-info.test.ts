import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineHref, linkedLineIds, readableLineHref } from '../../src/client/telomereInfo.ts';

const page = { origin: 'https://knot.example', pathname: '/proj/%E3%83%AA%E3%83%B3%E3%82%AF' };

void test('行へのリンクは、Cosense と同じく URL の fragment に行の ID をそのまま置く', () => {
  assert.equal(lineHref('01ABC', page), 'https://knot.example/proj/%E3%83%AA%E3%83%B3%E3%82%AF#01ABC');
});

void test('リーダブルリンクはタイトルを percent-encode しない', () => {
  assert.equal(readableLineHref('01ABC', page), 'https://knot.example/proj/リンク#01ABC');
  // & は Cosense のリーダブルリンクと同じく字のまま出す。
  assert.equal(
    readableLineHref('01ABC', { origin: page.origin, pathname: '/proj/Skill_%26_CLI' }),
    'https://knot.example/proj/Skill_&_CLI#01ABC',
  );
});

void test('リーダブルリンクでも、URL の区切りになる字と空白は encode したまま残す', () => {
  // / ? # % と、全角の空白。どれも字に戻すと URL が途中で切れるか、別の URL になる。
  assert.equal(
    readableLineHref('01ABC', { origin: page.origin, pathname: '/proj/a%2Fb%3Fc%23d%25e%E3%80%80f' }),
    'https://knot.example/proj/a%2Fb%3Fc%23d%25e%E3%80%80f#01ABC',
  );
});

void test('リーダブルリンクは、字に戻せない path をそのまま使う', () => {
  assert.equal(
    readableLineHref('01ABC', { origin: page.origin, pathname: '/proj/%E3%83' }),
    'https://knot.example/proj/%E3%83#01ABC',
  );
});

void test('fragment は Cosense と同じ #<行の ID> を先に、行の要素の id の #L<行の ID> を後に試す', () => {
  assert.deepEqual(linkedLineIds('#01ABC'), ['01ABC']);
  assert.deepEqual(linkedLineIds('#L01ABC'), ['L01ABC', '01ABC']);
  assert.deepEqual(linkedLineIds('#'), []);
  assert.deepEqual(linkedLineIds(''), []);
});
