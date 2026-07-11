import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleLc, encodeTitleForUrl, decodeTitleSegment } from '../../src/core/title.ts';

test('小文字化と空白のアンダースコア化', () => {
  assert.equal(titleLc('Foo Bar'), 'foo_bar');
  assert.equal(titleLc('foo_bar'), 'foo_bar');
});

test('Unicode NFC 正規化（結合文字と合成済み文字を同一視）', () => {
  // 分解形 (カ U+30AB + 結合濁点 U+3099) と合成済み形 (ガ U+30AC)。
  // エディタ等の正規化で潰れないよう Unicode エスケープで記述する。
  assert.equal(titleLc('\u30AB\u3099'), titleLc('\u30AC'));
});

test('特殊文字を含むタイトルの URL 往復', () => {
  for (const t of ['a/b', 'a?b', 'a#b', 'a%b', 'a b', 'a_b', '日本語 タイトル']) {
    const seg = encodeTitleForUrl(t);
    assert.ok(!seg.includes('/') && !seg.includes('?') && !seg.includes('#'));
    assert.equal(titleLc(decodeTitleSegment(seg)), titleLc(t));
  }
});

test('URL 上は空白がアンダースコアで見える', () => {
  assert.equal(encodeTitleForUrl('Foo Bar'), 'Foo_Bar');
});
