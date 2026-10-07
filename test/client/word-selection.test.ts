import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordRange } from '../../src/client/editor/cm/wordSelection.ts';

// text の中の needle の at 字目を double click したときに選ぶ語。左半分を押すと caret の位置は字の前、
// 右半分を押すと字の後ろになる。
function wordAt(text: string, needle: string, at: number, half: 'left' | 'right' = 'left'): string {
  const index = text.indexOf(needle);
  assert.notEqual(index, -1, `${needle} is missing`);
  const { from, to } = wordRange(text, half === 'left' ? index + at : index + at + 1);
  return text.slice(from, to);
}

// 期待値は、Cosense（help-jp）の同じ字を double click して選ばれた範囲。
void test('漢字・ひらがな・カタカナは、同じ種類の字が続く範囲を語にする', () => {
  const release = ' shokai/agent-skillsからsubagent-consultationを追加、sanity-reviewの更新を取り込み (#8313)';
  assert.equal(wordAt(release, 'を追加', 2), '追加');
  assert.equal(wordAt(release, 'の更新', 0), 'の');
  assert.equal(wordAt(release, 'の更新', 2), '更新');
  assert.equal(wordAt(release, '取り込み', 2), '込');
  assert.equal(wordAt('クリックすると別のページに飛ぶ文字列のこと', 'ページ', 0), 'ページ');
  assert.equal(wordAt('「問合せログ 対応数」に戻す', '問合せ', 1), '問合');
  assert.equal(wordAt('ルール」を色々整理した', '色々', 0), '色');
  assert.equal(wordAt('ルール」を色々整理した', '色々', 1), '々');
  assert.equal(wordAt('際の重要なルール', '重要な', 2), 'な');
});

void test('Cosense と同じく、字の右半分を押すと caret の後ろの字の語を選ぶ', () => {
  const release = 'subagent-consultationを追加、sanity-review';
  assert.equal(wordAt(release, 'を追加', 2, 'right'), '、');
  assert.equal(wordAt(release, 'consultation', 11, 'right'), 'を');
  assert.equal(wordAt(release, 'consultation', 11), 'consultation');
});

void test('英数字と _ は続けて 1 語にし、- . : / % # などで区切る', () => {
  const release = ' shokai/agent-skillsからsubagent-consultationを追加、sanity-reviewの更新を取り込み (#8313)';
  assert.equal(wordAt(release, 'subagent-consultation', 12), 'consultation');
  assert.equal(wordAt(release, 'agent-skills', 2), 'agent');
  assert.equal(wordAt(release, 'shokai/agent', 2), 'shokai');
  assert.equal(wordAt(release, '#8313', 2), '8313');
  assert.equal(wordAt('package-lock.jsonのengines', 'package-lock.json', 9), 'lock');
  assert.equal(wordAt('package-lock.jsonのengines', 'package-lock.json', 15), 'json');
  const docs = 'docs/testing_and_linting_in_docker.mdに書かれている事をCLAUDE.mdで説明';
  assert.equal(wordAt(docs, 'testing_and_linting', 3), 'testing_and_linting_in_docker');
  assert.equal(wordAt(docs, 'CLAUDE.md', 2), 'CLAUDE');
  const bump = 'Bump redis from 4.7.1 to 5.11.0 (#8331)';
  assert.equal(wordAt(bump, '4.7.1', 2), '7');
  assert.equal(wordAt(bump, '5.11.0', 2), '11');
  assert.equal(wordAt('lint:tsc:clientとlint:tsc:serverを46%高速化', 'lint:tsc', 1), 'lint');
  assert.equal(wordAt('lint:tsc:clientとlint:tsc:serverを46%高速化', '46%', 0), '46');
  assert.equal(wordAt('サイズを1600x1000にする', '1600x1000', 5), '1600x1000');
  assert.equal(wordAt('pages API v2を実装', 'v2', 1), 'v2');
  assert.equal(wordAt('Bump ttf2woff2 from', 'ttf2woff2', 3), 'ttf2woff2');
  assert.equal(wordAt('PageEdit APIのnoInfoboxUpdateオプション', 'noInfoboxUpdate', 3), 'noInfoboxUpdate');
  assert.equal(wordAt('重要なルール」を「AIが作業', 'AIが', 1), 'AI');
});

void test('記号は続く記号をまとめ、句読点と括弧は 1 字でも語にする', () => {
  assert.equal(wordAt('Bump redis from 4.7.1 to 5.11.0 (#8331)', '(#8331)', 0), '(#');
  assert.equal(wordAt('subagent-consultationを追加、sanity-review', '、', 0), '、');
  assert.equal(wordAt('CLAUDE.mdの「AIが作業', '「AI', 0), '「');
  assert.equal(wordAt('2 hop search', ' hop', 0), ' ');
});

void test('行末では前の字の語を選ぶ。空行は caret のまま', () => {
  assert.deepEqual(wordRange('abc def', 0), { from: 0, to: 3 });
  assert.deepEqual(wordRange('abc def', 7), { from: 4, to: 7 });
  assert.deepEqual(wordRange('', 0), { from: 0, to: 0 });
});
