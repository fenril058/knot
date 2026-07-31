import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainLineText } from '../../src/render/plain.ts';

void test('ブラケットリンクはタイトルだけにする', () => {
  assert.equal(plainLineText('[Foo Bar] と #tag'), 'Foo Bar と #tag');
});

void test('ラベル付き外部リンクはラベルにする', () => {
  assert.equal(plainLineText('[https://example.com タイトル]'), 'タイトル');
});

void test('ラベルなし外部リンクは URL のまま', () => {
  assert.equal(plainLineText('[https://example.com]'), 'https://example.com');
});

void test('装飾記法は本文だけにする', () => {
  assert.equal(plainLineText('[* 強調] と [/ 斜体]'), '強調 と 斜体');
});

void test('インラインコードは中身だけにする', () => {
  assert.equal(plainLineText('前 `code` 後'), '前 code 後');
});

void test('アイコン記法は名前にする', () => {
  assert.equal(plainLineText('[name.icon]'), 'name');
});

void test('平文とインデントは変えない', () => {
  assert.equal(plainLineText('plain text'), 'plain text');
  assert.equal(plainLineText('  indented [Link]'), '  indented Link');
});

void test('解析できない行は原文を返す', () => {
  assert.equal(plainLineText('code:example.js'), 'code:example.js');
});
