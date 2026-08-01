import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { compareGuards, extractGuards, parseJsonc, STRICT_SUBFLAGS, type Sources } from '../scripts/quality-ratchet.ts';

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

void test('noUncheckedIndexedAccess の無効化を落とす（添字アクセスの検査が消える）', () => {
  const head = TSCONFIG.replace('"noUncheckedIndexedAccess": true', '"noUncheckedIndexedAccess": false');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:noUncheckedIndexedAccess']);
});

void test('strict の無効化と include の縮小を落とす', () => {
  const head = TSCONFIG
    .replace('"strict": true', '"strict": false')
    .replace('"src/**/*.ts", "test/**/*.ts"', '"src/**/*.ts"');
  // strict を落とすと、そこから値を継いでいる sub-flag もまとめて違反になる。
  assert.deepEqual(run({ tsconfig: head }), [
    'tsconfig:alwaysStrict',
    'tsconfig:include',
    'tsconfig:noImplicitAny',
    'tsconfig:noImplicitThis',
    'tsconfig:strict',
    'tsconfig:strictBindCallApply',
    'tsconfig:strictBuiltinIteratorReturn',
    'tsconfig:strictFunctionTypes',
    'tsconfig:strictNullChecks',
    'tsconfig:strictPropertyInitialization',
    'tsconfig:useUnknownInCatchVariables',
  ]);
});

void test('strict を立てたまま sub-flag だけ落とすのを落とす', () => {
  // strict: true でも strictNullChecks: false を明示すると null 検査が消える。
  const head = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "strictNullChecks": false,');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:strictNullChecks']);
});

void test('exclude の追加による検査対象の縮小を落とす', () => {
  // include を縮めなくても exclude を足せば同じことができる。
  const head = TSCONFIG.replace('"compilerOptions": {', '"exclude": ["src/cli/**"],\n  "compilerOptions": {');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:exclude']);
});

void test('noCheck による型検査の丸ごと無効化を落とす', () => {
  // noCheck: true は tsc を exit 0 にする。strict 系を残したままでも検査は消える。
  const head = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "noCheck": true,');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:noCheck']);
});

void test('strictBuiltinIteratorReturn の個別無効化を落とす', () => {
  const head = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "strictBuiltinIteratorReturn": false,');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:strictBuiltinIteratorReturn']);
});

void test('extends の新設を落とす（継承元の設定は解決しないため）', () => {
  // 継承元に noCheck を置けばルート側は無変更に見える。解決しない以上 extends 自体を止める。
  const head = TSCONFIG.replace('{\n  "compilerOptions"', '{\n  "extends": "./base.json",\n  "compilerOptions"');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:noExtends']);
});

void test('outDir による検査対象の暗黙の縮小を落とす', () => {
  // TypeScript は outDir 配下を暗黙に exclude する。include を書き換えずに
  // "outDir": "test" と足すだけで test 配下が型検査から外れる。
  const head = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "outDir": "test",');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:noOutDir']);
});

void test('declarationDir による検査対象の暗黙の縮小を落とす', () => {
  const head = TSCONFIG.replace('"strict": true,', '"strict": true,\n    "declarationDir": "test",');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:noDeclarationDir']);
});

void test('STRICT_SUBFLAGS が strict 系フラグを取りこぼしていない', () => {
  // TypeScript の更新で strict 系が増えると、増えた分は無監視になる。
  // tsc の help から「strict が false でない限り true」のオプションを取り、実装と突き合わせる。
  const help = execFileSync('tsc', ['--help', '--all', '--pretty', 'false'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${new URL('../node_modules/.bin', import.meta.url).pathname}:${process.env.PATH ?? ''}` },
  });
  const fromHelp = new Set<string>();
  let current = '';
  for (const raw of help.split('\n')) {
    const name = /^--([a-zA-Z]+)\s*$/.exec(raw.trim());
    if (name) current = name[1]!;
    else if (/unless .?strict.? is/.test(raw) && current !== '') {
      fromHelp.add(current);
      current = '';
    }
  }
  // 書式が変わってパースが空振りしたら、突き合わせが素通りするので先に落とす。
  assert.ok(fromHelp.size > 0, 'tsc --help から strict 系フラグを 1 つも取れなかった');
  const guarded = new Set(STRICT_SUBFLAGS);
  const missing = [...fromHelp].filter((name) => !guarded.has(name)).toSorted();
  assert.deepEqual(missing, [], `STRICT_SUBFLAGS に足りないフラグ: ${missing.join(', ')}`);
});

void test('erasableSyntaxOnly の無効化を落とす', () => {
  const head = TSCONFIG.replace('"erasableSyntaxOnly": true', '"erasableSyntaxOnly": false');
  assert.deepEqual(run({ tsconfig: head }), ['tsconfig:erasableSyntaxOnly']);
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
  assert.deepEqual(run({ pkg: PKG.replace('oxlint src public test e2e config', 'oxlint src public config') }), ['package:lintTargets']);
});

void test('quality スクリプトからの検査削除を落とす', () => {
  assert.deepEqual(run({ pkg: PKG.replace(' && npm run lint:duplicates', '') }), ['package:qualitySteps']);
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
