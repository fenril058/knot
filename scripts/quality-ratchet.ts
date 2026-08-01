// 品質ゲートのラチェット検査。
//
// oxlint の上限値・重複検査の閾値・dead-code 検査の対象などは、超過すれば CI が落ちる。
// しかし「上限値そのものを緩める変更」は素通りしてしまうため、base ref との差分を取って
// 緩和方向の変更を落とす。緩和を意図して行う場合は docs/quality-gates.md に記録する
// （ルール名と新しい値の両方を含む行を追加する）。
//
// 判定は fail closed とする。base ref が解決できない、base の設定が壊れている、
// HEAD の設定が読めない、のいずれも違反として扱う。

import { execFileSync } from 'node:child_process';

// 数値上限つき、または severity だけを持つガード。max が null のルールは severity だけ見る。
export type NumericGuard = { severity: string; max: number | null };

export type Guards = {
  // key -> 上限。key は "<scope>|<rule>" 形式（scope 空文字は root）
  numeric: Map<string, NumericGuard>;
  // key -> 真偽値。false から true へは進めるが、true から false へは戻せない
  flags: Map<string, boolean>;
  // key -> 集合。base の全要素が HEAD にも無ければならない（検査対象の縮小を防ぐ）
  supersets: Map<string, string[]>;
  // key -> 集合。HEAD に base より多い要素があってはならない（除外の追加を防ぐ）
  subsets: Map<string, string[]>;
};

export type Sources = {
  oxlint: string | null;
  tsconfig: string | null;
  jscpd: string | null;
  knip: string | null;
  pkg: string | null;
  ci: string | null;
};

export type Violation = { key: string; reason: string };

const SEVERITY_RANK: Record<string, number> = { off: 0, allow: 0, warn: 1, error: 2, deny: 2 };

// 文字列リテラルの終端（閉じ引用符の次）を返す。エスケープされた引用符では終わらない。
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue; }
    if (text[i] === '"') return i + 1;
  }
  return text.length;
}

function skipTo(text: string, from: number, marker: string): number {
  const at = text.indexOf(marker, from);
  if (at === -1) return text.length;
  // 行コメントの終端の改行は残す（後続のトークン区切りとして必要）
  return marker === '\n' ? at : at + marker.length;
}

// JSONC（// と /* */ を含む JSON）からコメントを落とす。
// 文字列リテラル内の // を誤って落とさないよう、文字列は丸ごと読み飛ばす。
function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const pair = text.slice(i, i + 2);
    if (pair === '//') { i = skipTo(text, i + 2, '\n'); continue; }
    if (pair === '/*') { i = skipTo(text, i + 2, '*/'); continue; }
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

// oxlint のルール設定 "error" / ["error", 20] / ["error", { max: 20 }] / "off" を読む
function readRule(value: unknown): NumericGuard {
  if (typeof value === 'string') return { severity: value, max: null };
  if (!Array.isArray(value)) return { severity: 'off', max: null };
  const severity = typeof value[0] === 'string' ? value[0] : 'off';
  const option = value[1];
  if (typeof option === 'number') return { severity, max: option };
  const max = asRecord(option).max;
  return { severity, max: typeof max === 'number' ? max : null };
}

// scope は override の files 配列を join した文字列ではなく、glob 1 つ 1 つ。
// join で識別すると ["a","b"] と ["a"] が無関係な scope になり、files からファイルを
// 外す（＝ root の厳しい値へ戻す）強化操作を緩和と誤判定する。
function overrideScopes(config: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const overrides = Array.isArray(config.overrides) ? config.overrides.map(asRecord) : [];
  const byScope = new Map<string, Record<string, unknown>>();
  for (const entry of overrides) {
    for (const glob of asStringArray(entry.files)) {
      // 同じ glob を複数の override が指す場合は後勝ち（oxlint の適用順に合わせる）
      byScope.set(glob, { ...byScope.get(glob), ...asRecord(entry.rules) });
    }
  }
  return byScope;
}

// scope（root と各 glob）× rule の実効上限を作る。
// override が該当ルールを持たない scope では root の値が効くため、override の削除は
// 常に強化方向になり、override の追加・緩和だけが違反として残る。
function effectiveOxlintRules(config: Record<string, unknown>, scopes: string[], rules: string[]): Map<string, NumericGuard> {
  const rootRules = asRecord(config.rules);
  const byScope = overrideScopes(config);
  const out = new Map<string, NumericGuard>();
  for (const scope of scopes) {
    const scoped = scope === '' ? undefined : byScope.get(scope);
    for (const rule of rules) {
      const raw = scoped !== undefined && rule in scoped ? scoped[rule] : rootRules[rule];
      out.set(`${scope}|${rule}`, raw === undefined ? { severity: 'off', max: null } : readRule(raw));
    }
  }
  return out;
}

function oxlintScopesAndRules(configs: Record<string, unknown>[]): { scopes: string[]; rules: string[] } {
  const scopes = new Set<string>(['']);
  const rules = new Set<string>();
  for (const config of configs) {
    for (const rule of Object.keys(asRecord(config.rules))) rules.add(rule);
    for (const [glob, scopedRules] of overrideScopes(config)) {
      scopes.add(glob);
      for (const rule of Object.keys(scopedRules)) rules.add(rule);
    }
  }
  return { scopes: [...scopes], rules: [...rules] };
}

function addOxlintGuards(guards: Guards, config: Record<string, unknown>, scopes: string[], rules: string[]): void {
  for (const [key, guard] of effectiveOxlintRules(config, scopes, rules)) {
    guards.numeric.set(`oxlint:${key}`, guard);
  }
  for (const [name, severity] of Object.entries(asRecord(config.categories))) {
    guards.numeric.set(`oxlint:categories|${name}`, { severity: String(severity), max: null });
  }
  const plugins = Array.isArray(config.jsPlugins) ? config.jsPlugins.map((p) => String(asRecord(p).name)) : [];
  guards.supersets.set('oxlint:jsPlugins', plugins);
  // typeAware を落とすと型情報つきルールが一斉に黙る。ルール定義を残したまま無効化できてしまうため個別に見る。
  guards.flags.set('oxlint:typeAware', asRecord(config.options).typeAware === true);
  // これを緩めると、要らなくなった抑制 directive が残り続ける（残った行は以後検査されない）。
  const unused = asRecord(config.options).reportUnusedDisableDirectives;
  guards.numeric.set('oxlint:reportUnusedDisableDirectives', {
    severity: typeof unused === 'string' ? unused : 'off', max: null,
  });
  guards.subsets.set('oxlint:ignorePatterns', asStringArray(config.ignorePatterns));
}

// strict が束ねる個別フラグ。strict: true のまま 1 つだけ false を明示すると、
// strict だけを見るガードは素通りしてしまうため、実効値を個別に見る。
const STRICT_SUBFLAGS = [
  'noImplicitAny',
  'noImplicitThis',
  'alwaysStrict',
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'strictPropertyInitialization',
  'useUnknownInCatchVariables',
];

function addTsconfigGuards(guards: Guards, config: Record<string, unknown>): void {
  const options = asRecord(config.compilerOptions);
  const strict = options.strict === true;
  // strict を落とすと型検査が一斉に緩む。
  guards.flags.set('tsconfig:strict', strict);
  for (const name of STRICT_SUBFLAGS) {
    // 明示があればそれが勝ち、無ければ strict の値を継ぐ（tsc の解決と同じ）。
    const explicit = options[name];
    guards.flags.set(`tsconfig:${name}`, explicit === undefined ? strict : explicit === true);
  }
  // これを落とすと添字アクセスが T になり、lines[i]! の ! が無意味になる
  // （no-unnecessary-type-assertion が一斉に外せと言い出す）。strict には含まれない。
  guards.flags.set('tsconfig:noUncheckedIndexedAccess', options.noUncheckedIndexedAccess === true);
  guards.supersets.set('tsconfig:include', asStringArray(config.include));
  // include を縮めなくても exclude を足せば検査対象を減らせる。
  guards.subsets.set('tsconfig:exclude', asStringArray(config.exclude));
}

function addJscpdGuards(guards: Guards, config: Record<string, unknown>): void {
  for (const key of ['threshold', 'minLines', 'minTokens']) {
    const value = config[key];
    // 3 つとも「小さいほど厳しい」ので上限として扱う（severity の概念が無いので error 固定）
    guards.numeric.set(`jscpd:${key}`, { severity: 'error', max: typeof value === 'number' ? value : null });
  }
  guards.supersets.set('jscpd:pattern', asStringArray(config.pattern));
  guards.supersets.set('jscpd:format', asStringArray(config.format));
  guards.subsets.set('jscpd:ignore', asStringArray(config.ignore));
}

function addKnipGuards(guards: Guards, config: Record<string, unknown>): void {
  guards.flags.set('knip:includeEntryExports', config.includeEntryExports === true);
  guards.supersets.set('knip:entry', asStringArray(config.entry));
  guards.supersets.set('knip:project', asStringArray(config.project));
}

function addPackageGuards(guards: Guards, pkg: Record<string, unknown>): void {
  const scripts = asRecord(pkg.scripts);
  const lint = typeof scripts.lint === 'string' ? scripts.lint : '';
  // "oxlint src public test e2e config" の検査対象ディレクトリが減っていないことを見る
  guards.supersets.set('package:lintTargets', lint.split(/\s+/).filter((t) => t !== '' && t !== 'oxlint'));
  const quality = typeof scripts.quality === 'string' ? scripts.quality : '';
  guards.supersets.set('package:qualitySteps', quality.split('&&').map((s) => s.trim()).filter((s) => s !== ''));
}

function addCiGuards(guards: Guards, ci: string): void {
  const steps = [...ci.matchAll(/^\s*-\s*run:\s*(.+?)\s*$/gm)].map((m) => m[1]!);
  guards.supersets.set('ci:runSteps', steps);
}

export function extractGuards(sources: Sources, otherOxlint: string | null): Guards {
  const guards: Guards = { numeric: new Map(), flags: new Map(), supersets: new Map(), subsets: new Map() };
  if (sources.oxlint !== null) {
    // scope と rule の一覧は base / HEAD の和集合で取る。
    // そうしないと HEAD で新設された override（＝緩和）が比較対象から漏れる。
    const self = asRecord(parseJsonc(sources.oxlint));
    const other = otherOxlint === null ? {} : asRecord(parseJsonc(otherOxlint));
    const { scopes, rules } = oxlintScopesAndRules([self, other]);
    addOxlintGuards(guards, self, scopes, rules);
  }
  if (sources.tsconfig !== null) addTsconfigGuards(guards, asRecord(parseJsonc(sources.tsconfig)));
  if (sources.jscpd !== null) addJscpdGuards(guards, asRecord(parseJsonc(sources.jscpd)));
  if (sources.knip !== null) addKnipGuards(guards, asRecord(parseJsonc(sources.knip)));
  if (sources.pkg !== null) addPackageGuards(guards, asRecord(parseJsonc(sources.pkg)));
  if (sources.ci !== null) addCiGuards(guards, sources.ci);
  return guards;
}

// 緩和を承認する記録行かどうか。key の末尾（ルール名や設定名）と新しい値の両方を含む行を要求する。
// 無関係な編集や、ルール名だけの言及では通さない。
function isApprovedBy(addedDocLines: string[], key: string, newValue: string): boolean {
  const name = key.includes('|') ? key.slice(key.lastIndexOf('|') + 1) : key.slice(key.indexOf(':') + 1);
  return addedDocLines.some((line) => line.includes(name) && line.includes(newValue));
}

function compareNumeric(base: Guards, head: Guards, doc: string[], out: Violation[]): void {
  for (const [key, baseGuard] of base.numeric) {
    const headGuard = head.numeric.get(key) ?? { severity: 'off', max: null };
    const baseRank = SEVERITY_RANK[baseGuard.severity] ?? 0;
    const headRank = SEVERITY_RANK[headGuard.severity] ?? 0;
    if (headRank < baseRank && !isApprovedBy(doc, key, headGuard.severity)) {
      out.push({ key, reason: `severity が ${baseGuard.severity} から ${headGuard.severity} へ緩められている` });
      continue;
    }
    if (baseGuard.max === null) continue;
    if (headGuard.max === null) {
      out.push({ key, reason: `上限 ${baseGuard.max} が指定されなくなっている` });
      continue;
    }
    if (headGuard.max > baseGuard.max && !isApprovedBy(doc, key, String(headGuard.max))) {
      out.push({ key, reason: `上限が ${baseGuard.max} から ${headGuard.max} へ引き上げられている` });
    }
  }
}

function compareFlags(base: Guards, head: Guards, doc: string[], out: Violation[]): void {
  for (const [key, baseValue] of base.flags) {
    if (baseValue && head.flags.get(key) !== true && !isApprovedBy(doc, key, 'false')) {
      out.push({ key, reason: '有効だった検査が無効化されている' });
    }
  }
}

function compareSets(base: Guards, head: Guards, doc: string[], out: Violation[]): void {
  for (const [key, baseItems] of base.supersets) {
    const headItems = new Set(head.supersets.get(key) ?? []);
    const missing = baseItems.filter((item) => !headItems.has(item));
    for (const item of missing) {
      if (!isApprovedBy(doc, key, item)) out.push({ key, reason: `検査対象から外れている: ${item}` });
    }
  }
  for (const [key, headItems] of head.subsets) {
    const baseItems = new Set(base.subsets.get(key) ?? []);
    const added = headItems.filter((item) => !baseItems.has(item));
    for (const item of added) {
      if (!isApprovedBy(doc, key, item)) out.push({ key, reason: `除外が追加されている: ${item}` });
    }
  }
}

export function compareGuards(base: Guards, head: Guards, addedDocLines: string[]): Violation[] {
  const out: Violation[] = [];
  compareNumeric(base, head, addedDocLines, out);
  compareFlags(base, head, addedDocLines, out);
  compareSets(base, head, addedDocLines, out);
  return out;
}

const GUARD_FILES = {
  oxlint: '.oxlintrc.json',
  tsconfig: 'tsconfig.json',
  jscpd: '.jscpd.json',
  knip: 'knip.json',
  pkg: 'package.json',
  ci: '.github/workflows/ci.yml',
} as const;

const DOC_PATH = 'docs/quality-gates.md';

function showAt(ref: string, path: string): string | null {
  try {
    // ファイルが ref に無い場合は null。git のエラー出力は握る（消失は呼び出し側が違反として扱う）
    return execFileSync('git', ['show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function readSources(ref: string): Sources {
  return {
    oxlint: showAt(ref, GUARD_FILES.oxlint),
    tsconfig: showAt(ref, GUARD_FILES.tsconfig),
    jscpd: showAt(ref, GUARD_FILES.jscpd),
    knip: showAt(ref, GUARD_FILES.knip),
    pkg: showAt(ref, GUARD_FILES.pkg),
    ci: showAt(ref, GUARD_FILES.ci),
  };
}

// base に無く HEAD にある行だけを承認記録として扱う（既存行の再利用を防ぐ）
function approvalLines(baseRef: string, headRef: string): string[] {
  const before = new Set((showAt(baseRef, DOC_PATH) ?? '').split('\n'));
  return (showAt(headRef, DOC_PATH) ?? '').split('\n').filter((l) => l.trim() !== '' && !before.has(l));
}

function resolve(ref: string): string {
  return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
}

export function main(argv: string[]): number {
  const [baseRef, headRef = 'HEAD'] = argv;
  if (baseRef === undefined) {
    process.stderr.write('usage: node scripts/quality-ratchet.ts <base-ref> [head-ref]\n');
    return 2;
  }
  let base;
  let head;
  try {
    base = resolve(baseRef);
    head = resolve(headRef);
  } catch (e) {
    process.stderr.write(`base/head ref を解決できない（検査を飛ばさず失敗させる）: ${String(e)}\n`);
    return 2;
  }
  if (base === head) {
    process.stdout.write('base と HEAD が同一 commit のため差分なし\n');
    return 0;
  }
  const baseSources = readSources(base);
  const headSources = readSources(head);
  let violations;
  try {
    violations = compareGuards(
      extractGuards(baseSources, headSources.oxlint),
      extractGuards(headSources, baseSources.oxlint),
      approvalLines(base, head),
    );
  } catch (e) {
    process.stderr.write(`設定を解釈できない（壊れた設定で検査を素通りさせない）: ${String(e)}\n`);
    return 2;
  }
  if (violations.length === 0) {
    process.stdout.write(`品質ゲートの緩和なし（base: ${base.slice(0, 8)}）\n`);
    return 0;
  }
  process.stderr.write('品質ゲートが緩められている:\n');
  for (const v of violations) process.stderr.write(`  - ${v.key}: ${v.reason}\n`);
  process.stderr.write(`\n意図した緩和なら ${DOC_PATH} に「対象名と新しい値の両方を含む行」を追加すること。\n`);
  return 1;
}

if (process.argv[1]?.endsWith('quality-ratchet.ts') ?? false) {
  process.exit(main(process.argv.slice(2)));
}
