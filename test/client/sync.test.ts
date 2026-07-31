import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOps } from '../../src/core/apply.ts';
import { type Line } from '../../src/core/ops.ts';
import {
  lineMeta,
  parsePendingRecord,
  serializePendingRecord,
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

  assert.deepEqual(sync.bufferChanged(['Title', 'second']), []);
  const effects = sync.ackSuccess(2);
  const send = effect(effects, 'send');

  assert.deepEqual(send?.commit.ops, [{ type: 'update', id: 'body', text: 'second' }]);
  assert.equal(send?.commit.baseVersion, 2);
  assert.equal(sync.status, 'saving');
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

  assert.notEqual(send?.commit.commitId, firstCommitId);
  assert.equal(send?.commit.baseVersion, 2);
  assert.deepEqual(send?.commit.ops, [{ type: 'update', id: 'mine', text: 'mine changed' }]);
  const merged = applyOps(latest, send?.commit.ops ?? [], { userId: 'self', now: 100, version: 3 });
  assert.deepEqual(merged.map(({ text }) => text), ['Title', 'mine changed', 'theirs changed']);
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
  assert.notEqual(insert?.id, firstInsertId);
  const merged = applyOps(latest, send?.commit.ops ?? [], { userId: 'self', now: 100, version: 3 });
  assert.ok(merged.some(({ text }) => text === 'inserted'));
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
  assert.deepEqual(parsePendingRecord(serializePendingRecord(record!)), record);
  assert.equal(parsePendingRecord('{broken'), null);
  assert.equal(parsePendingRecord(JSON.stringify({ ...record, ops: [{ type: 'wat' }] })), null);
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

void test('タイトル確定後は currentTitle と次の送信先 title が更新される', () => {
  const sync = engine([line('title', 'Old title'), line('body', 'body')], 'Old title');
  sync.bufferChanged(['New title', 'body']);
  sync.flush();
  sync.bufferChanged(['New title', 'changed after rename']);

  const effects = sync.ackSuccess(2);
  assert.equal(sync.currentTitle, 'New title');
  assert.equal(effect(effects, 'send')?.title, 'New title');
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
  const applied = applyOps(latest, send!.commit.ops, { userId: 'self', now: 100, version: 3 });
  assert.deepEqual(applied.map(({ text }) => text), ['Title', 'mine', 'theirs']);
});
