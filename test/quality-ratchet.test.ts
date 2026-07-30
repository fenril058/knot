import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareGuards, extractGuards, parseJsonc, type Sources } from '../scripts/quality-ratchet.ts';

const OXLINT = `{
  // 移行用の上限
  "jsPlugins": [{ "name": "sonarjs", "specifier": "./config/sonarjs.cjs" }],
  "categories": { "correctness": "error", "suspicious": "error" },
  "rules": {
    "complexity": ["error", { "max": 20 }],
    "max-depth": ["error", 4],
    "sonarjs/cognitive-complexity": ["error", 20],
    "typescript/no-explicit-any": "error"
  },
  "overrides": [
    {
      "files": ["src/cli/sync/commands.ts"],
      "rules": { "sonarjs/cognitive-complexity": ["error", 84] }
    }
  ]
}`;

const JSCPD = `{
  "threshold": 0,
  "minLines": 8,
  "minTokens": 50,
  "format": ["typescript", "javascript"],
  "pattern": "{src,public}/**/*.{ts,js}",
  "ignore": ["public/build/**"]
}`;

const KNIP = `{
  "includeEntryExports": true,
  "entry": ["public/*.js", "test/**/*.test.ts"],
  "project": ["src/**/*.ts"]
}`;

const PKG = `{
  "scripts": {
    "lint": "oxlint src public test e2e config",
    "quality": "npm run typecheck && npm run lint && npm run lint:duplicates && npm run lint:dead-code"
  }
}`;

const CI = `jobs:
  test:
    steps:
      - run: npm ci
      - run: npm run lint
      - run: npm test
`;

const BASE: Sources = { oxlint: OXLINT, jscpd: JSCPD, knip: KNIP, pkg: PKG, ci: CI };

function run(head: Partial<Sources>, doc: string[] = []): string[] {
  const headSources: Sources = { ...BASE, ...head };
  const keys = compareGuards(
    extractGuards(BASE, headSources.oxlint),
    extractGuards(headSources, BASE.oxlint),
    doc,
  ).map((v) => v.key);
  return [...new Set(keys)].toSorted();
}

test('parseJsonc は行コメント・ブロックコメントを落とし、文字列内の // は残す', () => {
  const parsed = parseJsonc('{ /* a */ "u": "http://x/y", // b\n "n": 1 }') as Record<string, unknown>;
  assert.deepEqual(parsed, { u: 'http://x/y', n: 1 });
});

test('変更なしなら違反なし', () => {
  assert.deepEqual(run({}), []);
});

test('上限を下げるのは許す', () => {
  assert.deepEqual(run({ oxlint: OXLINT.replace('"max": 20', '"max": 15').replace('["error", 84]', '["error", 70]') }), []);
});

test('root の上限引き上げを落とす', () => {
  assert.deepEqual(run({ oxlint: OXLINT.replace('"complexity": ["error", { "max": 20 }]', '"complexity": ["error", { "max": 25 }]') }), ['oxlint:src/cli/sync/commands.ts|complexity', 'oxlint:|complexity']);
});

test('override の上限引き上げを落とす', () => {
  assert.deepEqual(run({ oxlint: OXLINT.replace('["error", 84]', '["error", 100]') }), ['oxlint:src/cli/sync/commands.ts|sonarjs/cognitive-complexity']);
});

test('severity の warn への格下げを落とす', () => {
  const head = OXLINT.replace('"typescript/no-explicit-any": "error"', '"typescript/no-explicit-any": "warn"');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:src/cli/sync/commands.ts|typescript/no-explicit-any', 'oxlint:|typescript/no-explicit-any']);
});

test('ルールごと削除するのを落とす', () => {
  const head = OXLINT.replace('"max-depth": ["error", 4],\n', '');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:src/cli/sync/commands.ts|max-depth', 'oxlint:|max-depth']);
});

test('categories の格下げを落とす', () => {
  const head = OXLINT.replace('"correctness": "error"', '"correctness": "off"');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:categories|correctness']);
});

test('override での無効化（off）を落とす', () => {
  const head = OXLINT.replace('"rules": { "sonarjs/cognitive-complexity": ["error", 84] }', '"rules": { "sonarjs/cognitive-complexity": "off" }');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:src/cli/sync/commands.ts|sonarjs/cognitive-complexity']);
});

test('緩める override の新設を落とす', () => {
  const head = OXLINT.replace('"overrides": [', '"overrides": [\n    { "files": ["src/render/render.ts"], "rules": { "complexity": ["error", { "max": 99 }] } },');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:src/render/render.ts|complexity']);
});

test('override の削除は root へ戻るので許す', () => {
  const head = OXLINT.replace(/"overrides": \[[\s\S]*\]/, '"overrides": []');
  assert.deepEqual(run({ oxlint: head }), []);
});

test('ignorePatterns による除外の追加を落とす', () => {
  const head = OXLINT.replace('"rules": {', '"ignorePatterns": ["src/cli/**"],\n  "rules": {');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:ignorePatterns']);
});

test('sonarjs プラグインの取り外しを落とす', () => {
  const head = OXLINT.replace('[{ "name": "sonarjs", "specifier": "./config/sonarjs.cjs" }]', '[]');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:jsPlugins']);
});

test('jscpd の閾値引き上げを落とす', () => {
  assert.deepEqual(run({ jscpd: JSCPD.replace('"threshold": 0', '"threshold": 3') }), ['jscpd:threshold']);
});

test('jscpd の検出粒度を粗くするのを落とす', () => {
  assert.deepEqual(run({ jscpd: JSCPD.replace('"minTokens": 50', '"minTokens": 120') }), ['jscpd:minTokens']);
});

test('jscpd の検査対象の縮小と除外追加を落とす', () => {
  const head = JSCPD.replace('"{src,public}/**/*.{ts,js}"', '"src/**/*.ts"').replace('["public/build/**"]', '["public/build/**", "src/cli/**"]');
  assert.deepEqual(run({ jscpd: head }), ['jscpd:ignore', 'jscpd:pattern']);
});

test('knip の entry export 検査の無効化を落とす', () => {
  assert.deepEqual(run({ knip: KNIP.replace('"includeEntryExports": true', '"includeEntryExports": false') }), ['knip:includeEntryExports']);
});

test('knip の検査対象の縮小を落とす', () => {
  assert.deepEqual(run({ knip: KNIP.replace('"public/*.js", ', '') }), ['knip:entry']);
});

test('lint の検査対象ディレクトリの削減を落とす', () => {
  assert.deepEqual(run({ pkg: PKG.replace('oxlint src public test e2e config', 'oxlint src public config') }), ['package:lintTargets']);
});

test('quality スクリプトからの検査削除を落とす', () => {
  assert.deepEqual(run({ pkg: PKG.replace(' && npm run lint:duplicates', '') }), ['package:qualitySteps']);
});

test('CI から検査ステップを外すのを落とす', () => {
  assert.deepEqual(run({ ci: CI.replace('      - run: npm run lint\n', '') }), ['ci:runSteps']);
});

test('設定ファイルが消えた場合も落とす', () => {
  assert.ok(run({ jscpd: null }).includes('jscpd:threshold'));
});

test('base の設定が壊れていれば例外にする（fail closed）', () => {
  assert.throws(() => extractGuards({ ...BASE, jscpd: '{ broken' }, OXLINT));
});

test('記録行があれば緩和を通す', () => {
  const head = OXLINT.replace('["error", 84]', '["error", 100]');
  assert.deepEqual(run({ oxlint: head }, ['- sonarjs/cognitive-complexity を 100 へ引き上げる: import 実装の追加のため']), []);
});

test('対象名だけ・新しい値だけの記録行では通さない', () => {
  const head = OXLINT.replace('["error", 84]', '["error", 100]');
  const key = 'oxlint:src/cli/sync/commands.ts|sonarjs/cognitive-complexity';
  assert.deepEqual(run({ oxlint: head }, ['- sonarjs/cognitive-complexity を見直す']), [key]);
  assert.deepEqual(run({ oxlint: head }, ['- 上限を 100 にする']), [key]);
});

test('無関係な文書編集では通さない', () => {
  const head = JSCPD.replace('"threshold": 0', '"threshold": 3');
  assert.deepEqual(run({ jscpd: head }, ['- 誤字を直した']), ['jscpd:threshold']);
});
