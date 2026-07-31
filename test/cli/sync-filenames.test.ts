import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filenameToTitle, titleToFilename } from '../../src/cli/sync/filenames.ts';

void test('通常のタイトルはそのまま + .txt', () => {
  assert.equal(titleToFilename('カレーの作り方'), 'カレーの作り方.txt');
  assert.equal(titleToFilename('Meeting Notes 2026'), 'Meeting Notes 2026.txt');
});

void test('OS で使えない文字を percent-encode する', () => {
  assert.equal(titleToFilename('a/b'), 'a%2Fb.txt');
  assert.equal(titleToFilename('c: d'), 'c%3A d.txt');
  assert.equal(titleToFilename('50%off'), '50%25off.txt');
  assert.equal(titleToFilename('q?<>|"*\\'), 'q%3F%3C%3E%7C%22%2A%5C.txt');
});

void test('先頭ピリオド・末尾の空白とピリオドをエスケープする', () => {
  assert.equal(titleToFilename('.hidden'), '%2Ehidden.txt');
  assert.equal(titleToFilename('end '), 'end%20.txt');
  assert.equal(titleToFilename('end.'), 'end%2E.txt');
});

void test('Windows 予約名は先頭文字をエスケープする', () => {
  assert.equal(titleToFilename('CON'), '%43ON.txt');
  assert.equal(titleToFilename('com1'), '%63om1.txt');
  assert.equal(titleToFilename('console'), 'console.txt'); // 予約名の前方一致はそのまま
  assert.equal(titleToFilename('CON.md'), '%43ON.md.txt'); // 予約名+拡張子も予約
  assert.equal(titleToFilename('nul.txt'), '%6Eul.txt.txt');
});

void test('制御文字をエスケープする', () => {
  assert.equal(titleToFilename('a\tb'), 'a%09b.txt');
});

void test('round-trip: filenameToTitle(titleToFilename(t)) === t', () => {
  const titles = [
    'カレーの作り方', 'a/b', '50%off', '.hidden', 'end ', 'end.', 'CON',
    'A B_C', 'σ と ς', '%2F literal', 'a\tb', 'nested/path/like',
    'CON.md', 'nul.txt',
  ];
  for (const t of titles) assert.equal(filenameToTitle(titleToFilename(t)), t);
});
