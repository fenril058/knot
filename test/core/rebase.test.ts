import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebase, type RebaseResult } from '../../src/core/rebase.ts';
import { applyOps } from '../../src/core/apply.ts';
import { type Line } from '../../src/core/ops.ts';
import { lcg } from '../helpers/rand.ts';

const mk = (...pairs: [string, string][]): Line[] =>
  pairs.map(([id, text]) => ({ id, text, created: 1, updated: 1, updatedVersion: 1, userId: 'u' }));
const ctx = { userId: 'me', now: 9, version: 10 };
const texts = (lines: Line[]) => lines.map((l) => l.text);
const candidateOps = (result: RebaseResult) => result.kind === 'rebased' ? result.ops : result.candidateOps;
const apply = (lines: Line[], result: RebaseResult) => {
  const ops = candidateOps(result);
  return ops.length === 0 ? lines : applyOps(lines, ops, ctx);
};

void test('ローカル変更なしなら空', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const latest = mk(['a', 't'], ['b', 'y']);
  assert.deepEqual(rebase(base, base, latest), { kind: 'rebased', ops: [] });
});

void test('他者だけが変えた行を上書きしない', () => {
  const base = mk(['a', 't'], ['b', 'x'], ['c', 'z']);
  const local = mk(['a', 't'], ['b', 'x'], ['c', 'z-edited']);
  const latest = mk(['a', 't'], ['b', 'x-other'], ['c', 'z']);
  const out = apply(latest, rebase(base, local, latest));
  assert.deepEqual(texts(out), ['t', 'x-other', 'z-edited']);
});

void test('同一行を異なる内容へ更新した場合は競合にし、手元の内容を候補へ保持する', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const local = mk(['a', 't'], ['b', 'mine']);
  const latest = mk(['a', 't'], ['b', 'theirs']);
  const result = rebase(base, local, latest);
  assert.equal(result.kind, 'conflict');
  const out = apply(latest, result);
  assert.deepEqual(texts(out), ['t', 'mine']);
});

void test('編集した行が削除されていたら競合にし、同じ ID で復元する候補を保持する', () => {
  const base = mk(['a', 't'], ['b', 'x'], ['c', 'z']);
  const local = mk(['a', 't'], ['b', 'x-mine'], ['c', 'z']);
  const latest = mk(['a', 't'], ['c', 'z']);
  const result = rebase(base, local, latest);
  assert.equal(result.kind, 'conflict');
  const out = apply(latest, result);
  assert.deepEqual(texts(out), ['t', 'x-mine', 'z']);
  assert.equal(out[1]!.id, 'b');
});

void test('触っていない行の削除は受け入れる', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const local = mk(['a', 't'], ['b', 'x']);
  const latest = mk(['a', 't']);
  assert.deepEqual(rebase(base, local, latest), { kind: 'rebased', ops: [] });
});

void test('手元の削除とサーバ上の更新は競合にし、削除した候補を保持する', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const local = mk(['a', 't']);
  const latest = mk(['a', 't'], ['b', 'x-other']);
  const result = rebase(base, local, latest);
  assert.equal(result.kind, 'conflict');
  const out = apply(latest, result);
  assert.deepEqual(texts(out), ['t']);
});

void test('挿入アンカーの行が消えていても挿入内容を失わない', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const local = mk(['a', 't'], ['b', 'x'], ['n1', 'new line']);
  const latest = mk(['a', 't']);
  const out = apply(latest, rebase(base, local, latest));
  assert.deepEqual(texts(out), ['t', 'new line']);
});

void test('プロパティ: 候補は手元の全編集を保持し、他者だけの編集を消さない', () => {
  const rnd = lcg(20260711);
  for (let round = 0; round < 30; round++) {
    const size = 3 + Math.floor(rnd() * 5);
    const base: Line[] = [];
    for (let i = 0; i < size; i++) {
      base.push({ id: `B${i}`, text: `line${i}`, created: 1, updated: 1, updatedVersion: 1, userId: 'u' });
    }
    const mutate = (src: Line[], tag: string): Line[] => {
      const out = src.map((l) => ({ ...l }));
      const action = rnd();
      const at = Math.floor(rnd() * out.length);
      if (action < 0.4 && out.length > 0) out[at] = { ...out[at]!, text: `${out[at]!.text}-${tag}` };
      else if (action < 0.7 && out.length > 1) out.splice(at, 1);
      else out.splice(at, 0, { id: `${tag}${round}`, text: `added-${tag}${round}`, created: 1, updated: 1, updatedVersion: 1, userId: 'u' });
      return out;
    };
    const local = mutate(base, 'L');
    const latest = mutate(base, 'R');
    const merged = apply(latest, rebase(base, local, latest));

    for (const l of local) {
      const b = base.find((x) => x.id === l.id);
      if (!b || b.text !== l.text) {
        assert.ok(merged.some((m) => m.id === l.id && m.text === l.text),
          `local change ${l.id} lost in round ${round}`);
      }
    }
    for (const r of latest) {
      if (!base.some((b) => b.id === r.id) && !local.some((l) => l.id === r.id)) {
        assert.ok(merged.some((m) => m.id === r.id && m.text === r.text),
          `latest-only line ${r.id} lost in round ${round}`);
      }
    }
    for (const r of latest) {
      const b = base.find((x) => x.id === r.id);
      const l = local.find((x) => x.id === r.id);
      if (b && b.text !== r.text && l && l.text === b.text) {
        assert.ok(merged.some((m) => m.id === r.id && m.text === r.text),
          `latest edit ${r.id} lost in round ${round}`);
      }
    }
    for (const b of base) {
      if (!local.some((l) => l.id === b.id)) {
        assert.ok(!merged.some((m) => m.id === b.id),
          `locally deleted ${b.id} still present in round ${round}`);
      }
    }
  }
});

void test('プロパティ: 同一行を両者が触る場合は競合にし、候補に手元の変更を保持する', () => {
  const rnd = lcg(7113);
  for (let round = 0; round < 30; round++) {
    const base: Line[] = [];
    for (let i = 0; i < 4; i++) {
      base.push({ id: `B${i}`, text: `line${i}`, created: 1, updated: 1, updatedVersion: 1, userId: 'u' });
    }
    const target = Math.floor(rnd() * base.length);
    const localKind = rnd() < 0.5 ? 'update' : 'delete';
    const latestKind = rnd() < 0.5 ? 'update' : 'delete';
    const local = base.map((l) => ({ ...l }));
    if (localKind === 'update') local[target] = { ...local[target]!, text: 'mine' };
    else local.splice(target, 1);
    const latest = base.map((l) => ({ ...l }));
    if (latestKind === 'update') latest[target] = { ...latest[target]!, text: 'theirs' };
    else latest.splice(target, 1);
    const result = rebase(base, local, latest);
    const merged = apply(latest, result);
    const found = merged.find((m) => m.id === `B${target}`);
    assert.equal(result.kind, localKind === latestKind && localKind === 'delete' ? 'rebased' : 'conflict');
    if (localKind === 'delete') {
      assert.equal(found, undefined, `round ${round}: 候補に手元の削除が反映される`);
    } else {
      assert.ok(found !== undefined && found.text === 'mine',
        `round ${round}: 候補に手元の更新が反映される（相手が${latestKind === 'delete' ? '削除' : '更新'}でも）`);
    }
    for (const b of base) {
      if (b.id !== `B${target}`) {
        assert.ok(merged.some((m) => m.id === b.id && m.text === b.text),
          `round ${round}: 触っていない行 ${b.id} が変化した`);
      }
    }
  }
});
