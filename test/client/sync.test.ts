import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../../src/core/apply.ts';
import { type Line } from '../../src/core/ops.ts';
import {
  lineMeta,
  parseEditorRecord,
  serializeEditorRecord,
  SyncEngine,
  type SyncEffect,
} from '../../src/client/editor/sync.ts';

const line = (id: string, text: string, version = 1, userId = 'other'): Line => ({
  id,
  text,
  created: 10,
  updated: 20,
  updatedVersion: version,
  userId,
});

const idGenerator = () => {
  let next = 0;
  return () => `new-${next++}`;
};

const engine = (lines: Line[], title = lines[0]?.text ?? 'Title') => new SyncEngine({
  snapshot: { version: 1, lines },
  title,
  userId: 'self',
  isNew: false,
  makeId: idGenerator(),
  now: () => 100,
});

const effect = <T extends SyncEffect['type']>(effects: SyncEffect[], type: T) =>
  effects.find((candidate): candidate is Extract<SyncEffect, { type: T }> => candidate.type === type);

void test('基本往復: 編集を送信して成功すると確認済み snapshot と永続化が進む', () => {
  const sync = engine([line('title', 'Title'), line('body', 'old')]);

  assert.deepEqual(sync.bufferChanged(['Title', 'new']), [{ type: 'schedule' }]);
  const sent = sync.flush();
  assert.equal(effect(sent, 'send')?.commit.baseVersion, 1);
  assert.equal(sync.status, 'saving');

  const acknowledged = sync.ackSuccess(2);
  assert.deepEqual(acknowledged, [{ type: 'persist', record: null }]);
  assert.deepEqual(sync.confirmedLines.map(({ text }) => text), ['Title', 'new']);
  assert.equal(sync.status, 'saved');
});

void test('送信中の追加編集は成功応答後に新 snapshot 基準の第2コミットになる', () => {
  const sync = engine([line('title', 'Title'), line('body', 'body')]);
  sync.bufferChanged(['Title', 'first']);
  sync.flush();

  const buffered = sync.bufferChanged(['Title', 'second']);
  assert.deepEqual(buffered, [{ type: 'schedule' }]);
  const bufferedRecord = effect(sync.flush(), 'persist')?.record;
  assert.equal(bufferedRecord?.kind, undefined);
  if (bufferedRecord === null || bufferedRecord === undefined || bufferedRecord.kind !== undefined) {
    throw new Error('pending record missing');
  }
  assert.deepEqual(bufferedRecord.draftTexts, ['Title', 'second']);
  const effects = sync.ackSuccess(2);
  const send = effect(effects, 'send');

  assert.deepEqual(send?.commit.ops, [{ type: 'update', id: 'body', text: 'second' }]);
  assert.equal(send?.commit.baseVersion, 2);
  assert.equal(sync.status, 'saving');
});

void test('送信中の追加編集を pending から復元して第2コミットにできる', () => {
  const base = [line('title', 'Title'), line('body', 'body')];
  const first = engine(base);
  first.bufferChanged(['Title', 'first']);
  first.flush();
  assert.deepEqual(first.bufferChanged(['Title', 'second']), [{ type: 'schedule' }]);
  const record = effect(first.flush(), 'persist')?.record;
  assert.ok(record !== null && record !== undefined && record.kind === undefined);
  if (record === null || record === undefined || record.kind !== undefined) throw new Error('pending record missing');

  const restored = new SyncEngine({
    snapshot: { version: record.baseVersion, lines: record.baseLines },
    title: record.title,
    userId: 'self',
    isNew: false,
    pending: record,
    makeId: idGenerator(),
    now: () => 100,
  });
  const second = effect(restored.ackSuccess(2), 'send');

  assert.equal(second?.commit.baseVersion, 2);
  assert.deepEqual(second?.commit.ops, [{ type: 'update', id: 'body', text: 'second' }]);
});

void test('inflight 中の flush は第2リクエストを送らない', () => {
  const sync = engine([line('title', 'Title'), line('body', 'body')]);
  sync.bufferChanged(['Title', 'changed']);
  sync.flush();

  assert.deepEqual(sync.flush(), []);
});

void test('409 の3-way rebase は他者の変更を残して自分の変更だけを再送する', () => {
  const base = [line('title', 'Title'), line('mine', 'mine before'), line('theirs', 'theirs before')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'mine changed', 'theirs before']);
  const firstCommitId = effect(sync.flush(), 'send')?.commit.commitId;
  const latest = [base[0]!, base[1]!, line('theirs', 'theirs changed', 2)];

  const effects = sync.ackConflict({ version: 2, title: 'Title', lines: latest });
  const send = effect(effects, 'send');

  assert.deepEqual(effect(effects, 'replace-document')?.texts, ['Title', 'mine changed', 'theirs changed']);
  assert.notEqual(send?.commit.commitId, firstCommitId);
  assert.equal(send?.commit.baseVersion, 2);
  assert.deepEqual(send?.commit.ops, [{ type: 'update', id: 'mine', text: 'mine changed' }]);
  const merged = applyOps(latest, send?.commit.ops ?? [], { userId: 'self', now: 100, version: 3 });
  assert.deepEqual(merged.map(({ text }) => text), ['Title', 'mine changed', 'theirs changed']);
});

void test('競合草稿は表示直後と解消中の編集後に永続化できる', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local']);
  sync.flush();

  const conflicted = sync.ackConflict({
    version: 2,
    title: 'Title',
    lines: [base[0]!, line('body', 'latest', 2)],
  });
  const firstDraft = effect(conflicted, 'persist')?.record;
  assert.equal(firstDraft?.kind, 'conflict-draft');
  assert.deepEqual(firstDraft?.texts, ['Title', 'local']);

  const edited = sync.bufferChanged(['Title', 'edited during conflict']);
  assert.deepEqual(edited, [{ type: 'schedule' }]);
  const editedDraft = effect(sync.flush(), 'persist')?.record;
  assert.equal(editedDraft?.kind, 'conflict-draft');
  assert.deepEqual(editedDraft?.texts, ['Title', 'edited during conflict']);
});

void test('競合草稿を復元すると自動送信せず解消待ちを再開する', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const latest = [base[0]!, line('body', 'latest', 2)];
  const first = engine(base);
  first.bufferChanged(['Title', 'local']);
  first.flush();
  const record = effect(first.ackConflict({ version: 2, title: 'Title', lines: latest }), 'persist')?.record;
  assert.equal(record?.kind, 'conflict-draft');
  if (record?.kind !== 'conflict-draft') throw new Error('conflict draft missing');

  const restored = new SyncEngine({
    snapshot: record.latest,
    title: record.title,
    userId: 'self',
    isNew: false,
    conflictDraft: { ...record, texts: ['Title', 'edited during conflict'] },
    makeId: idGenerator(),
    now: () => 100,
  });

  assert.equal(restored.status, 'conflict');
  assert.deepEqual(restored.restoredEffects(), [
    { type: 'replace-document', texts: ['Title', 'edited during conflict'] },
    { type: 'present-conflict', conflicts: record.conflicts },
  ]);
  assert.equal(effect(restored.flush(), 'send'), undefined);
});

void test('同一行の異なる更新は自動再送せず、手元の内容を競合解消まで保持する', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local']);
  sync.flush();

  const effects = sync.ackConflict({
    version: 2,
    title: 'Title',
    lines: [base[0]!, line('body', 'latest', 2)],
  });
  const conflict = effect(effects, 'present-conflict');

  assert.equal(effect(effects, 'send'), undefined);
  assert.equal(sync.status, 'conflict');
  assert.deepEqual(effect(effects, 'replace-document')?.texts, ['Title', 'local']);
  assert.deepEqual(conflict?.conflicts, [{
    lineId: 'body',
    base: { kind: 'present', text: 'base' },
    local: { kind: 'present', text: 'local' },
    latest: { kind: 'present', text: 'latest' },
  }]);
  assert.equal(effect(sync.flush(), 'persist')?.record?.kind, 'conflict-draft');
});

void test('同じ本文が連続していても編集した行 ID の競合を検出する', () => {
  const base = [line('title', 'Title'), line('first', 'same'), line('second', 'same')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local', 'same']);
  sync.flush();

  const effects = sync.ackConflict({
    version: 2,
    title: 'Title',
    lines: [base[0]!, line('first', 'remote', 2), base[2]!],
  });

  assert.equal(effect(effects, 'send'), undefined);
  assert.deepEqual(effect(effects, 'present-conflict')?.conflicts.map(({ lineId }) => lineId), ['first']);
});

void test('同文2行の片方を削除した曖昧な差分もサーバ上の最新版で更新されていれば競合にする', () => {
  const base = [line('first', 'same'), line('second', 'same')];
  const sync = engine(base, 'same');
  sync.bufferChanged(['same']);
  sync.flush();

  const effects = sync.ackConflict({
    version: 2,
    title: 'remote',
    lines: [line('first', 'remote', 2), base[1]!],
  });

  assert.equal(effect(effects, 'send'), undefined);
  assert.deepEqual(effect(effects, 'present-conflict')?.conflicts.map(({ lineId }) => lineId), ['first']);
});

void test('競合中の編集は自動保存せず、明示的な解消後に最新版へ送る', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'Title', lines: [base[0]!, line('body', 'latest', 2)] });

  assert.deepEqual(sync.bufferChanged(['Title', 'resolved']), [{ type: 'schedule' }]);
  assert.equal(effect(sync.flush(), 'persist')?.record?.kind, 'conflict-draft');

  const resolved = sync.resolveConflict();
  const send = effect(resolved, 'send');
  assert.equal(send?.commit.baseVersion, 2);
  assert.deepEqual(send?.commit.ops, [{ type: 'update', id: 'body', text: 'resolved' }]);
  assert.equal(sync.status, 'saving');
});

void test('競合解消コミットが拒否された場合は草稿を残して解消待ちへ戻る', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'Title', lines: [base[0]!, line('body', 'latest', 2)] });
  sync.bufferChanged(['Title', 'resolved']);
  sync.resolveConflict();

  const effects = sync.ackBad();

  assert.equal(sync.status, 'conflict');
  assert.deepEqual(effect(effects, 'replace-document')?.texts, ['Title', 'resolved']);
  assert.equal(effect(effects, 'present-conflict')?.conflicts[0]?.lineId, 'body');
  const record = effect(effects, 'persist')?.record;
  assert.equal(record?.kind, 'conflict-draft');
  if (record?.kind !== 'conflict-draft') throw new Error('conflict draft missing');
  assert.deepEqual(record.texts, ['Title', 'resolved']);
  assert.equal(effect(sync.resolveConflict(), 'send')?.commit.baseVersion, 2);
});

void test('競合解消の送信中 record を復元した後も拒否時に解消待ちへ戻る', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const first = engine(base);
  first.bufferChanged(['Title', 'local']);
  first.flush();
  first.ackConflict({ version: 2, title: 'Title', lines: [base[0]!, line('body', 'latest', 2)] });
  const record = effect(first.resolveConflict(), 'persist')?.record;
  assert.equal(record?.kind, undefined);
  if (record === null || record === undefined || record.kind !== undefined) throw new Error('pending record missing');
  assert.notEqual(record.conflictContext, undefined);

  const restored = new SyncEngine({
    snapshot: { version: record.baseVersion, lines: record.baseLines },
    title: record.title,
    userId: 'self',
    isNew: false,
    pending: record,
    makeId: idGenerator(),
    now: () => 100,
  });

  assert.equal(restored.ackBad().some((candidate) => candidate.type === 'present-conflict'), true);
  assert.equal(restored.status, 'conflict');
});

void test('競合解消の送信中に加えた編集の第2コミットが拒否されても草稿を残す', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'Title', lines: [base[0]!, line('body', 'latest', 2)] });
  sync.bufferChanged(['Title', 'resolved']);
  sync.resolveConflict();
  sync.bufferChanged(['Title', 'edited while resolving']);

  const second = sync.ackSuccess(3);
  assert.equal(effect(second, 'send')?.commit.baseVersion, 3);
  const rejected = sync.ackBad();

  assert.equal(sync.status, 'error');
  const record = effect(rejected, 'persist')?.record;
  assert.equal(record?.kind, 'unsaved-draft');
  if (record?.kind !== 'unsaved-draft') throw new Error('unsaved draft missing');
  assert.deepEqual(record.texts, ['Title', 'edited while resolving']);
});

void test('競合解消でサーバ上の内容を選んだ場合は再送せず pending を消す', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const latest = [base[0]!, line('body', 'latest', 2)];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'Title', lines: latest });

  sync.bufferChanged(['Title', 'latest']);

  assert.deepEqual(sync.resolveConflict(), [{ type: 'persist', record: null }]);
  assert.equal(sync.status, 'saved');
});

void test('手元の削除とサーバ上の最新版の更新の競合で最新版を選ぶと元の行 ID とメタデータを保つ', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const latestBody = line('body', 'latest', 2, 'other');
  const sync = engine(base);
  sync.bufferChanged(['Title']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'Title', lines: [base[0]!, latestBody] });

  sync.bufferChanged(['Title', 'latest']);

  assert.deepEqual(sync.resolveConflict(), [{ type: 'persist', record: null }]);
  assert.deepEqual(sync.confirmedLines, [base[0]!, latestBody]);
});

void test('同じ本文が並んでいても手元の削除と最新版の更新で最新版を選べば行を落とさない', () => {
  const base = [line('removed', 'old'), line('keep', 'same')];
  const latest = [line('removed', 'same', 2), base[1]!];
  const sync = engine(base, 'old');
  sync.bufferChanged(['same']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'same', lines: latest });

  sync.bufferChanged(['same', 'same']);

  assert.deepEqual(sync.resolveConflict(), [{ type: 'persist', record: null }]);
  assert.deepEqual(sync.confirmedLines, latest);
});

void test('同じ本文が並ぶ update 競合を基準値で解消しても既存 ID を保つ', () => {
  const base = [line('first', 'same'), line('second', 'same')];
  const sync = engine(base, 'same');
  sync.bufferChanged(['local', 'same']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'remote', lines: [line('first', 'remote', 2), base[1]!] });

  sync.bufferChanged(['same', 'same']);
  const send = effect(sync.resolveConflict(), 'send');

  assert.deepEqual(send?.commit.ops, [{ type: 'update', id: 'first', text: 'same' }]);
});

void test('競合解消で削除と追加の行数が同じでも残した行の ID を付け替えない', () => {
  const base = [line('first', 'base'), line('keep', 'keep')];
  const sync = engine(base, 'base');
  sync.bufferChanged(['local', 'keep']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'remote', lines: [line('first', 'remote', 2), base[1]!] });

  sync.bufferChanged(['keep', 'new']);
  const send = effect(sync.resolveConflict(), 'send');

  assert.deepEqual(send?.commit.ops[0], { type: 'delete', id: 'first' });
  const insert = send?.commit.ops[1];
  assert.equal(insert?.type, 'insert');
  if (insert?.type !== 'insert') throw new Error('insert op missing');
  assert.equal(insert.after, 'keep');
  assert.equal(insert.text, 'new');
});

void test('競合解消で行を並べ替えても送信後の本文がエディタ内容と一致する', () => {
  const base = [line('a', 'x'), line('b', 'y')];
  const latest = [base[0]!, line('b', 'z', 2)];
  const sync = engine(base, 'x');
  sync.bufferChanged(['x']);
  sync.flush();
  sync.ackConflict({ version: 2, title: 'x', lines: latest });

  sync.bufferChanged(['z', 'x']);
  const send = effect(sync.resolveConflict(), 'send');
  const resolved = applyOps(latest, send?.commit.ops ?? [], { userId: 'self', now: 100, version: 3 });

  assert.deepEqual(resolved.map(({ text }) => text), ['z', 'x']);
});

void test('競合解消コミットの自動リベース再送が拒否されたら未保存草稿として残す', () => {
  const base = [line('title', 'Title'), line('body', 'base'), line('other', 'before')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local', 'before']);
  sync.flush();
  sync.ackConflict({
    version: 2,
    title: 'Title',
    lines: [base[0]!, line('body', 'remote', 2), base[2]!],
  });
  sync.resolveConflict();

  const rebased = sync.ackConflict({
    version: 3,
    title: 'Title',
    lines: [base[0]!, line('body', 'remote', 2), line('other', 'changed', 3)],
  });
  assert.notEqual(effect(rebased, 'send'), undefined);

  const rejected = sync.ackBad();
  assert.equal(rejected.some((candidate) => candidate.type === 'present-conflict'), false);
  const record = effect(rejected, 'persist')?.record;
  assert.equal(record?.kind, 'unsaved-draft');
  if (record?.kind !== 'unsaved-draft') throw new Error('unsaved draft missing');
  assert.deepEqual(record.texts, ['Title', 'local', 'changed']);
  assert.equal(sync.status, 'error');
});

void test('サーバ上の最新版の削除と手元の更新の競合を手元側で解消すると元の行 ID で再送する', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local']);
  sync.flush();

  const conflicts = sync.ackConflict({ version: 2, title: 'Title', lines: [base[0]!] });
  assert.deepEqual(effect(conflicts, 'replace-document')?.texts, ['Title', 'local']);

  const send = effect(sync.resolveConflict(), 'send');
  assert.deepEqual(send?.commit.ops, [{ type: 'insert', id: 'body', after: 'title', text: 'local' }]);
});

void test('409 で挿入アンカーが消えてもローカルの挿入内容を再送する', () => {
  const base = [line('title', 'Title'), line('anchor', 'anchor'), line('tail', 'tail')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'anchor', 'inserted', 'tail']);
  const first = effect(sync.flush(), 'send');
  const firstInsertId = first?.commit.ops.find((op) => op.type === 'insert')?.id;
  const latest = [base[0]!, base[2]!];

  const send = effect(sync.ackConflict({ version: 2, title: 'Title', lines: latest }), 'send');
  const insert = send?.commit.ops.find((op) => op.type === 'insert');

  assert.equal(insert?.text, 'inserted');
  assert.equal(insert?.id, firstInsertId);
  const merged = applyOps(latest, send?.commit.ops ?? [], { userId: 'self', now: 100, version: 3 });
  assert.ok(merged.some(({ text }) => text === 'inserted'));
});

void test('競合画面で手元の挿入行を編集しても初回送信時の行 ID を保つ', () => {
  const base = [line('title', 'Title'), line('body', 'base')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'local', 'inserted']);
  const first = effect(sync.flush(), 'send');
  const firstInsertId = first?.commit.ops.find((op) => op.type === 'insert')?.id;
  sync.ackConflict({ version: 2, title: 'Title', lines: [base[0]!, line('body', 'remote', 2)] });

  sync.bufferChanged(['Title', 'local', 'edited insert']);
  const resolved = effect(sync.resolveConflict(), 'send');
  const resolvedInsert = resolved?.commit.ops.find((op) => op.type === 'insert');

  assert.equal(resolvedInsert?.id, firstInsertId);
  assert.equal(resolvedInsert?.text, 'edited insert');
});

void test('競合解消 ops の適用結果は並べ替えや増減を含むエディタ本文と一致する', () => {
  const base = [line('title', 'Title'), line('body', 'base'), line('tail', 'tail')];
  const latest = [base[0]!, line('body', 'remote', 2), base[2]!];
  const cases = [
    ['Title', 'resolved', 'edited insert', 'tail'],
    ['tail', 'Title', 'resolved'],
    ['Title', 'remote', 'tail'],
  ];
  for (const resolvedTexts of cases) {
    const sync = engine(base);
    sync.bufferChanged(['Title', 'local', 'inserted', 'tail']);
    sync.flush();
    sync.ackConflict({ version: 2, title: 'Title', lines: latest });
    sync.bufferChanged(resolvedTexts);

    const effects = sync.resolveConflict();
    const send = effect(effects, 'send');
    const actual = send === undefined
      ? sync.confirmedLines
      : applyOps(latest, send.commit.ops, { userId: 'self', now: 100, version: 3 });
    assert.deepEqual(actual.map(({ text }) => text), resolvedTexts);
  }
});

void test('ackFailure 後の flush は同じ commitId と内容で再送する', () => {
  const sync = engine([line('title', 'Title'), line('body', 'body')]);
  sync.bufferChanged(['Title', 'changed']);
  const first = effect(sync.flush(), 'send');

  assert.deepEqual(sync.ackFailure(), [{ type: 'schedule' }]);
  assert.equal(sync.status, 'error');
  const retry = effect(sync.flush(), 'send');
  assert.deepEqual(retry, first);
  assert.equal(sync.status, 'saving');
});

void test('ackBad は拒否されたコミットを再送せず、次の編集を新しいコミットにする', () => {
  const sync = engine([line('title', 'Title'), line('body', 'body')]);
  sync.bufferChanged(['Title', 'rejected']);
  const rejected = effect(sync.flush(), 'send');

  const failed = sync.ackBad();
  assert.equal(effect(failed, 'persist')?.record?.kind, 'unsaved-draft');
  assert.deepEqual(effect(failed, 'replace-document')?.texts, ['Title', 'rejected']);
  assert.equal(sync.status, 'error');
  assert.deepEqual(sync.flush(), []);

  assert.deepEqual(sync.bufferChanged(['Title', 'corrected']), [{ type: 'schedule' }]);
  const retried = effect(sync.flush(), 'send');
  assert.notEqual(retried?.commit.commitId, rejected?.commit.commitId);
  assert.deepEqual(retried?.commit.ops, [{ type: 'update', id: 'body', text: 'corrected' }]);
  assert.equal(sync.status, 'saving');
});

void test('flush は PendingRecord を永続化し、JSON 往復と不正入力を扱う', () => {
  const base = [line('title', 'Title'), line('body', 'body')];
  const sync = engine(base);
  sync.bufferChanged(['Title', 'changed']);
  const effects = sync.flush();
  const send = effect(effects, 'send');
  const record = effect(effects, 'persist')?.record;

  assert.deepEqual(record, {
    commitId: send?.commit.commitId,
    baseVersion: 1,
    ops: [{ type: 'update', id: 'body', text: 'changed' }],
    baseLines: base,
    title: 'Title',
  });
  assert.deepEqual(parseEditorRecord(serializeEditorRecord(record)), record);
  assert.equal(parseEditorRecord('{broken'), null);
  assert.equal(parseEditorRecord(JSON.stringify({ ...record, ops: [{ type: 'wat' }] })), null);
});

void test('新規ページは編集イベント前に送らず、初回は version 0 のタイトル insert', () => {
  const sync = new SyncEngine({
    snapshot: { version: 0, lines: [] },
    title: 'New page',
    userId: 'self',
    isNew: true,
    makeId: idGenerator(),
    now: () => 100,
  });

  assert.deepEqual(sync.flush(), []);
  sync.bufferChanged(['New page']);
  const send = effect(sync.flush(), 'send');
  assert.equal(send?.commit.baseVersion, 0);
  assert.deepEqual(send?.commit.ops[0], {
    type: 'insert',
    id: 'new-0',
    after: '_head',
    text: 'New page',
  });
});

void test('新規ページの作成応答で得た pageId を次の送信に使う', () => {
  const sync = new SyncEngine({
    snapshot: { version: 0, lines: [] },
    title: 'New page',
    userId: 'self',
    isNew: true,
    makeId: idGenerator(),
    now: () => 100,
  });
  sync.bufferChanged(['New page']);
  sync.flush();
  sync.bufferChanged(['New page', 'body']);

  const next = effect(sync.ackSuccess(1, 'page-1'), 'send');

  assert.equal(next?.commit.pageId, 'page-1');
});

void test('タイトル確定後は currentTitle と次の送信先 title が更新される', () => {
  const sync = engine([line('title', 'Old title'), line('body', 'body')], 'Old title');
  sync.bufferChanged(['New title', 'body']);
  sync.flush();
  sync.bufferChanged(['New title', 'changed after rename']);

  const effects = sync.ackSuccess(2);
  assert.equal(sync.currentTitle, 'New title');
  assert.equal(effect(effects, 'send')?.title, 'New title');
});

void test('既存ページの送信にはタイトル変更後も同じ pageId を含める', () => {
  const base = [line('title', 'Old title'), line('body', 'body')];
  const sync = new SyncEngine({
    snapshot: { version: 1, lines: base },
    title: 'Old title',
    pageId: 'page-1',
    userId: 'self',
    isNew: false,
    makeId: idGenerator(),
    now: () => 100,
  });
  sync.bufferChanged(['Local title', 'body']);
  const first = effect(sync.flush(), 'send');
  assert.equal(first?.commit.pageId, 'page-1');

  const rebased = sync.ackConflict({
    id: 'page-1',
    version: 2,
    title: 'Remote title',
    lines: [line('title', 'Remote title', 2), base[1]!],
  });
  assert.equal(effect(rebased, 'persist')?.record?.pageId, 'page-1');
});

void test('lineMeta は keep の元メタを保ち、追加行には自己メタと最大 version を使う', () => {
  const confirmed = [line('a', 'keep', 3, 'other'), line('b', 'remove', 4, 'other-2')];

  assert.deepEqual(lineMeta(confirmed, ['keep', 'added'], { userId: 'self', now: 999 }), [
    { updated: 20, userId: 'other', updatedVersion: 3 },
    { updated: 999, userId: 'self', updatedVersion: Number.MAX_SAFE_INTEGER },
  ]);
});

void test('pending 復元: ackFailure 後の flush が元の commitId と ops をそのまま再送する', () => {
  const base = [line('title', 'Title'), line('body', 'old')];
  const record = {
    commitId: 'pending-commit',
    baseVersion: 1,
    ops: [{ type: 'update' as const, id: 'body', text: 'new' }],
    baseLines: base,
    title: 'Title',
  };
  const sync = new SyncEngine({
    snapshot: { version: 1, lines: base },
    title: 'Title',
    userId: 'self',
    isNew: false,
    pending: record,
    makeId: idGenerator(),
    now: () => 100,
  });

  assert.equal(sync.status, 'saving');
  assert.deepEqual(sync.flush(), []); // inflight 中は新規送信しない
  sync.ackFailure();
  const send = effect(sync.flush(), 'send');
  assert.equal(send?.commit.commitId, 'pending-commit');
  assert.deepEqual(send?.commit.ops, record.ops);

  const persistAfter = sync.ackSuccess(2);
  assert.equal(effect(persistAfter, 'persist')?.record, null);
  assert.deepEqual(sync.confirmedLines.map(({ text }) => text), ['Title', 'new']);
});

void test('pending 復元: ackConflict は元 inflight を破棄して新しい commitId でリベース再送する', () => {
  const base = [line('title', 'Title'), line('body', 'old')];
  const record = {
    commitId: 'pending-commit',
    baseVersion: 1,
    ops: [{ type: 'update' as const, id: 'body', text: 'mine' }],
    baseLines: base,
    title: 'Title',
  };
  const sync = new SyncEngine({
    snapshot: { version: 1, lines: base },
    title: 'Title',
    userId: 'self',
    isNew: false,
    pending: record,
    makeId: idGenerator(),
    now: () => 100,
  });

  const latest = [line('title', 'Title', 2), line('body', 'old', 1), line('extra', 'theirs', 2)];
  const send = effect(sync.ackConflict({ version: 2, title: 'Title', lines: latest }), 'send');
  assert.notEqual(send?.commit.commitId, 'pending-commit');
  assert.equal(send?.commit.baseVersion, 2);
  const applied = applyOps(latest, send.commit.ops, { userId: 'self', now: 100, version: 3 });
  assert.deepEqual(applied.map(({ text }) => text), ['Title', 'mine', 'theirs']);
});
