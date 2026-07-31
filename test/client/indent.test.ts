import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dedentLine, indentLine } from '../../src/client/editor/indent.ts';

void test('indentLine は行頭に半角スペースを 1 個付与する', () => {
  assert.equal(indentLine('line'), ' line');
});

void test('dedentLine は行頭の半角スペースを 1 個除去する', () => {
  assert.equal(dedentLine('  line'), ' line');
});

void test('dedentLine は行頭のタブを 1 個除去する', () => {
  assert.equal(dedentLine('\tline'), 'line');
});

void test('dedentLine は行頭に空白もタブもなければ変更しない', () => {
  assert.equal(dedentLine('line'), 'line');
});
