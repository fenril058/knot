import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rebase } from '../../src/core/rebase.ts';
import { applyOps } from '../../src/core/apply.ts';
import { type Line } from '../../src/core/ops.ts';
import { lcg } from '../helpers/rand.ts';

const mk = (...pairs: [string, string][]): Line[] =>
  pairs.map(([id, text]) => ({ id, text, created: 1, updated: 1, updatedVersion: 1, userId: 'u' }));
const ctx = { userId: 'me', now: 9, version: 10 };
const texts = (lines: Line[]) => lines.map((l) => l.text);
const apply = (lines: Line[], ops: ReturnType<typeof rebase>) =>
  ops.length === 0 ? lines : applyOps(lines, ops, ctx);

test('ローカル変更なしなら空', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const latest = mk(['a', 't'], ['b', 'y']);
  assert.deepEqual(rebase(base, base, latest), []);
});

test('他者だけが変えた行を上書きしない', () => {
  const base = mk(['a', 't'], ['b', 'x'], ['c', 'z']);
  const local = mk(['a', 't'], ['b', 'x'], ['c', 'z-edited']);
  const latest = mk(['a', 't'], ['b', 'x-other'], ['c', 'z']);
  const out = apply(latest, rebase(base, local, latest));
  assert.deepEqual(texts(out), ['t', 'x-other', 'z-edited']);
});

test('同一行の競合は再送側（ローカル）が勝つ', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const local = mk(['a', 't'], ['b', 'mine']);
  const latest = mk(['a', 't'], ['b', 'theirs']);
  const out = apply(latest, rebase(base, local, latest));
  assert.deepEqual(texts(out), ['t', 'mine']);
});

test('編集した行が削除されていたら同じ ID で復活する', () => {
  const base = mk(['a', 't'], ['b', 'x'], ['c', 'z']);
  const local = mk(['a', 't'], ['b', 'x-mine'], ['c', 'z']);
  const latest = mk(['a', 't'], ['c', 'z']);
  const out = apply(latest, rebase(base, local, latest));
  assert.deepEqual(texts(out), ['t', 'x-mine', 'z']);
  assert.equal(out[1].id, 'b');
});

test('触っていない行の削除は受け入れる', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const local = mk(['a', 't'], ['b', 'x']);
  const latest = mk(['a', 't']);
  assert.deepEqual(rebase(base, local, latest), []);
});

test('自分の削除は他者の編集より勝つ', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const local = mk(['a', 't']);
  const latest = mk(['a', 't'], ['b', 'x-other']);
  const out = apply(latest, rebase(base, local, latest));
  assert.deepEqual(texts(out), ['t']);
});

test('挿入アンカーの行が消えていても挿入内容を失わない', () => {
  const base = mk(['a', 't'], ['b', 'x']);
  const local = mk(['a', 't'], ['b', 'x'], ['n1', 'new line']);
  const latest = mk(['a', 't']);
  const out = apply(latest, rebase(base, local, latest));
  assert.deepEqual(texts(out), ['t', 'new line']);
});

test('プロパティ: ローカルの全編集が生き残り、他者だけの編集を消さない', () => {
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
      if (action < 0.4 && out.length > 0) out[at] = { ...out[at], text: `${out[at].text}-${tag}` };
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
  }
});
