import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareGuards, extractGuards, parseJsonc, type Sources } from '../scripts/quality-ratchet.ts';

const OXLINT = `{
  // 移行用の上限
  "options": { "typeAware": true, "reportUnusedDisableDirectives": "deny" },
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
    "typecheck": "tsc --noEmit",
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

const TSCONFIG = `{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "erasableSyntaxOnly": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
`;

const BASE: Sources = { oxlint: OXLINT, tsconfig: TSCONFIG, jscpd: JSCPD, knip: KNIP, pkg: PKG, ci: CI };

function run(head: Partial<Sources>, doc: string[] = []): string[] {
  const headSources: Sources = { ...BASE, ...head };
  const keys = compareGuards(
    extractGuards(BASE, headSources.oxlint),
    extractGuards(headSources, BASE.oxlint),
    doc,
  ).map((v) => v.key);
  return [...new Set(keys)].toSorted();
}

void test('検査スクリプトの本文の書き換えを落とす', () => {
  // tsconfig を凍結しても、それを使うコマンドが自由なら意味がない。
  // --noCheck を足すだけで型検査は全部消えるが、ステップ名も lint の対象語も変わらない。
  const cases: [string, string][] = [
    ['tsc --noEmit', 'tsc --noEmit --noCheck'],
    ['tsc --noEmit', 'tsc -p tsconfig.loose.json --noEmit'],
    ['oxlint src public test e2e config', 'oxlint src public test e2e config --config .oxlintrc-loose.json'],
  ];
  for (const [from, to] of cases) {
    assert.deepEqual(run({ pkg: PKG.replace(from, to) }), ['package:scripts'], to);
  }
});

void test('承認記録がオプション名の部分文字列で別項目まで通さない', () => {
  // 「strictNullChecks を false にする」の 1 行で strict まで承認されてはいけない。
  const head = TSCONFIG
    .replace('"strict": true', '"strict": false')
    .replace('"noUncheckedIndexedAccess": true,', '"noUncheckedIndexedAccess": true,\n    "strictNullChecks": false,');
  const doc = ['- compilerOptions の strictNullChecks を false にする'];
  const reasons = compareGuards(
    extractGuards(BASE, null),
    extractGuards({ ...BASE, tsconfig: head }, null),
    doc,
  ).map((v) => v.reason);
  assert.ok(
    reasons.some((r) => r.includes('strict=true')),
    `strict の書き換えが誤って承認されている: ${JSON.stringify(reasons)}`,
  );
});

void test('既存オプションの値変更は「新しい値」を書けば承認される', () => {
  // 承認記録には新しい値を書く、と docs に書いてある。旧値の内部表現を要求してはいけない。
  const base = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "target": "es2023",');
  const head = base.replace('"target": "es2023"', '"target": "es5"');
  const keys = compareGuards(
    extractGuards({ ...BASE, tsconfig: base }, null),
    extractGuards({ ...BASE, tsconfig: head }, null),
    ['- compilerOptions の target を es5 にする'],
  ).map((v) => v.key);
  assert.deepEqual(keys, []);
});

void test('ネストしたオブジェクトのキー順の入れ替えでは落とさない', () => {
  // paths のキー順に意味は無い。並べ替えただけで違反にすると誤検出になる。
  const base = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "paths": { "a": ["1"], "b": ["2"] },');
  const head = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "paths": { "b": ["2"], "a": ["1"] },');
  const keys = compareGuards(
    extractGuards({ ...BASE, tsconfig: base }, null),
    extractGuards({ ...BASE, tsconfig: head }, null),
    [],
  ).map((v) => v.key);
  assert.deepEqual(keys, []);
});

void test('parseJsonc は行コメント・ブロックコメントを落とし、文字列内の // は残す', () => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const parsed = parseJsonc('{ /* a */ "u": "http://x/y", // b\n "n": 1 }') as Record<string, unknown>;
  assert.deepEqual(parsed, { u: 'http://x/y', n: 1 });
});

void test('変更なしなら違反なし', () => {
  assert.deepEqual(run({}), []);
});

void test('上限を下げるのは許す', () => {
  assert.deepEqual(run({ oxlint: OXLINT.replace('"max": 20', '"max": 15').replace('["error", 84]', '["error", 70]') }), []);
});

void test('root の上限引き上げを落とす', () => {
  assert.deepEqual(run({ oxlint: OXLINT.replace('"complexity": ["error", { "max": 20 }]', '"complexity": ["error", { "max": 25 }]') }), ['oxlint:src/cli/sync/commands.ts|complexity', 'oxlint:|complexity']);
});

void test('override の上限引き上げを落とす', () => {
  assert.deepEqual(run({ oxlint: OXLINT.replace('["error", 84]', '["error", 100]') }), ['oxlint:src/cli/sync/commands.ts|sonarjs/cognitive-complexity']);
});

void test('severity の warn への格下げを落とす', () => {
  const head = OXLINT.replace('"typescript/no-explicit-any": "error"', '"typescript/no-explicit-any": "warn"');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:src/cli/sync/commands.ts|typescript/no-explicit-any', 'oxlint:|typescript/no-explicit-any']);
});

void test('ルールごと削除するのを落とす', () => {
  const head = OXLINT.replace('"max-depth": ["error", 4],\n', '');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:src/cli/sync/commands.ts|max-depth', 'oxlint:|max-depth']);
});

void test('categories の格下げを落とす', () => {
  const head = OXLINT.replace('"correctness": "error"', '"correctness": "off"');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:categories|correctness']);
});

void test('override での無効化（off）を落とす', () => {
  const head = OXLINT.replace('"rules": { "sonarjs/cognitive-complexity": ["error", 84] }', '"rules": { "sonarjs/cognitive-complexity": "off" }');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:src/cli/sync/commands.ts|sonarjs/cognitive-complexity']);
});

void test('緩める override の新設を落とす', () => {
  const head = OXLINT.replace('"overrides": [', '"overrides": [\n    { "files": ["src/render/render.ts"], "rules": { "complexity": ["error", { "max": 99 }] } },');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:src/render/render.ts|complexity']);
});

void test('override の削除は root へ戻るので許す', () => {
  const head = OXLINT.replace(/"overrides": \[[\s\S]*\]/, '"overrides": []');
  assert.deepEqual(run({ oxlint: head }), []);
});

void test('ignorePatterns による除外の追加を落とす', () => {
  const head = OXLINT.replace('"rules": {', '"ignorePatterns": ["src/cli/**"],\n  "rules": {');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:ignorePatterns']);
});

void test('typeAware の無効化を落とす（型情報つきルールが一斉に黙る）', () => {
  assert.deepEqual(run({ oxlint: OXLINT.replace('"typeAware": true', '"typeAware": false') }), ['oxlint:typeAware']);
});

void test('exclude の追加による検査対象の縮小を落とす', () => {
  // include を縮めなくても exclude を足せば同じことができる。
  const head = TSCONFIG.replace('"compilerOptions": {', '"exclude": ["src/cli/**"],\n  "compilerOptions": {');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:exclude']);
});

void test('extends の新設を落とす（継承元の設定は解決しないため）', () => {
  // 継承元に noCheck を置けばルート側は無変更に見える。解決しない以上 extends 自体を止める。
  const head = TSCONFIG.replace('{\n  "compilerOptions"', '{\n  "extends": "./base.json",\n  "compilerOptions"');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:noExtends']);
});

void test('一覧に無いオプションの新設を落とす（compilerOptions の凍結）', () => {
  // 危険なオプションの列挙は漏れる。noUncheckedSideEffectImports と allowUmdGlobalAccess は
  // どちらも既定値に頼っていたものを明示して倒す形で、一覧には無い。
  for (const added of ['"noUncheckedSideEffectImports": false', '"allowUmdGlobalAccess": true']) {
    const head = TSCONFIG.replace('"strict": true,', `"strict": true,\n    ${added},`);
    assert.deepEqual(run({ tsconfig: head }), ['tsconfig:compilerOptions'], added);
  }
});

void test('既存オプションの値の書き換えを落とす（凍結）', () => {
  // 一覧に無く boolean でもない値でも、書き換われば落ちる。
  const base = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "target": "es2023",');
  const head = base.replace('"target": "es2023"', '"target": "es5"');
  const keys = compareGuards(
    extractGuards({ ...BASE, tsconfig: base }, null),
    extractGuards({ ...BASE, tsconfig: head }, null),
    [],
  ).map((v) => v.key);
  assert.deepEqual([...new Set(keys)].toSorted(), ['tsconfig:compilerOptions']);
});

void test('記録行があれば compilerOptions の変更を通す', () => {
  const head = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "allowUmdGlobalAccess": true,');
  const doc = ['- compilerOptions に allowUmdGlobalAccess を足す'];
  assert.deepEqual(run({ tsconfig: head }, doc), []);
});

void test('型情報つきルールの移行用の例外リストにファイルを足すのを落とす', () => {
  // 足したファイル（src/b.ts）の実効値が base の root（error）から off へ緩むので違反になる。
  const base = OXLINT.replace('"overrides": [', '"overrides": [\n    { "files": ["src/a.ts"], "rules": { "typescript/no-explicit-any": "off" } },');
  const head = base.replace('"files": ["src/a.ts"]', '"files": ["src/a.ts", "src/b.ts"]');
  const keys = compareGuards(extractGuards({ ...BASE, oxlint: base }, head), extractGuards({ ...BASE, oxlint: head }, base), []).map((v) => v.key);
  assert.ok(keys.includes('oxlint:src/b.ts|typescript/no-explicit-any'), keys.join(','));
});

void test('型情報つきルールの例外リストからファイルを外すのは許す', () => {
  const base = OXLINT.replace('"overrides": [', '"overrides": [\n    { "files": ["src/a.ts", "src/b.ts"], "rules": { "typescript/no-explicit-any": "off" } },');
  const head = base.replace('"files": ["src/a.ts", "src/b.ts"]', '"files": ["src/a.ts"]');
  const keys = compareGuards(extractGuards({ ...BASE, oxlint: base }, head), extractGuards({ ...BASE, oxlint: head }, base), []).map((v) => v.key);
  assert.deepEqual(keys, []);
});

void test('reportUnusedDisableDirectives の格下げを落とす', () => {
  const head = OXLINT.replace('"reportUnusedDisableDirectives": "deny"', '"reportUnusedDisableDirectives": "warn"');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:reportUnusedDisableDirectives']);
});

void test('sonarjs プラグインの取り外しを落とす', () => {
  const head = OXLINT.replace('[{ "name": "sonarjs", "specifier": "./config/sonarjs.cjs" }]', '[]');
  assert.deepEqual(run({ oxlint: head }), ['oxlint:jsPlugins']);
});

void test('jscpd の閾値引き上げを落とす', () => {
  assert.deepEqual(run({ jscpd: JSCPD.replace('"threshold": 0', '"threshold": 3') }), ['jscpd:threshold']);
});

void test('jscpd の検出粒度を粗くするのを落とす', () => {
  assert.deepEqual(run({ jscpd: JSCPD.replace('"minTokens": 50', '"minTokens": 120') }), ['jscpd:minTokens']);
});

void test('jscpd の検査対象の縮小と除外追加を落とす', () => {
  const head = JSCPD.replace('"{src,public}/**/*.{ts,js}"', '"src/**/*.ts"').replace('["public/build/**"]', '["public/build/**", "src/cli/**"]');
  assert.deepEqual(run({ jscpd: head }), ['jscpd:ignore', 'jscpd:pattern']);
});

void test('knip の entry export 検査の無効化を落とす', () => {
  assert.deepEqual(run({ knip: KNIP.replace('"includeEntryExports": true', '"includeEntryExports": false') }), ['knip:includeEntryExports']);
});

void test('knip の検査対象の縮小を落とす', () => {
  assert.deepEqual(run({ knip: KNIP.replace('"public/*.js", ', '') }), ['knip:entry']);
});

void test('lint の検査対象ディレクトリの削減を落とす', () => {
  assert.deepEqual(run({ pkg: PKG.replace('oxlint src public test e2e config', 'oxlint src public config') }), ['package:scripts']);
});

void test('quality スクリプトからの検査削除を落とす', () => {
  assert.deepEqual(run({ pkg: PKG.replace(' && npm run lint:duplicates', '') }), ['package:scripts']);
});

void test('CI から検査ステップを外すのを落とす', () => {
  assert.deepEqual(run({ ci: CI.replace('      - run: npm run lint\n', '') }), ['ci:runSteps']);
});

void test('設定ファイルが消えた場合も落とす', () => {
  assert.ok(run({ jscpd: null }).includes('jscpd:threshold'));
});

void test('base の設定が壊れていれば例外にする（fail closed）', () => {
  assert.throws(() => extractGuards({ ...BASE, jscpd: '{ broken' }, OXLINT));
});

void test('記録行があれば緩和を通す', () => {
  const head = OXLINT.replace('["error", 84]', '["error", 100]');
  assert.deepEqual(run({ oxlint: head }, ['- sonarjs/cognitive-complexity を 100 へ引き上げる: import 実装の追加のため']), []);
});

void test('対象名だけ・新しい値だけの記録行では通さない', () => {
  const head = OXLINT.replace('["error", 84]', '["error", 100]');
  const key = 'oxlint:src/cli/sync/commands.ts|sonarjs/cognitive-complexity';
  assert.deepEqual(run({ oxlint: head }, ['- sonarjs/cognitive-complexity を見直す']), [key]);
  assert.deepEqual(run({ oxlint: head }, ['- 上限を 100 にする']), [key]);
});

void test('無関係な文書編集では通さない', () => {
  const head = JSCPD.replace('"threshold": 0', '"threshold": 3');
  assert.deepEqual(run({ jscpd: head }, ['- 誤字を直した']), ['jscpd:threshold']);
});
