import { defaultKeymap, history as historyExtension, historyKeymap } from '@codemirror/commands';
import { keymap, EditorView } from '@codemirror/view';
import { applyOps } from '../../core/apply.ts';
import type { RebaseConflict, RebaseLineState } from '../../core/rebase.ts';
import { titleLc, pageHref } from '../../core/title.ts';
import type { KnownPage } from '../../render/presentation.ts';
import { fetchPage, postCommit, uploadFile } from './api.ts';
import { titleAutocompletion } from './cm/complete.ts';
import { syntaxHighlighting } from './cm/decorations.ts';
import { editorKeymap } from './cm/keymap.ts';
import { lineWysiwyg } from './cm/lineWysiwyg.ts';
import { pasteHandlers } from './cm/paste.ts';
import { refreshTelomereGutter, telomereGutter } from './cm/telomere.ts';
import {
  parsePendingRecord,
  serializePendingRecord,
  SyncEngine,
  type PendingRecord,
  type Snapshot,
  type SyncEffect,
} from './sync.ts';

const SAVE_DELAY_MS = 500;
const KEEPALIVE_BODY_LIMIT = 64 * 1024;

const root = document.querySelector<HTMLElement>('#editor-root');
const statusElement = document.querySelector<HTMLElement>('#save-status');
const editButtonElement = document.querySelector<HTMLButtonElement>('#edit-page-button');
const conflictPanelElement = document.querySelector<HTMLElement>('#edit-conflict');
const conflictListElement = document.querySelector<HTMLOListElement>('#edit-conflict-list');
const resolveConflictButtonElement = document.querySelector<HTMLButtonElement>('#resolve-edit-conflict');
if (
  root === null
  || statusElement === null
  || editButtonElement === null
  || conflictPanelElement === null
  || conflictListElement === null
  || resolveConflictButtonElement === null
) {
  throw new Error('editor root is missing');
}
const editorRoot = root;
const saveStatus = statusElement;
const editButton = editButtonElement;
const conflictPanel = conflictPanelElement;
const conflictList = conflictListElement;
const resolveConflictButton = resolveConflictButtonElement;

const data = editorRoot.dataset;
if (data.project === undefined || data.title === undefined || data.userName === undefined || data.cspNonce === undefined) {
  throw new Error('editor data attributes are missing');
}
const project = data.project;
const title = data.title;
const userName = data.userName;
const cspNonce = data.cspNonce;
const lastSeenVersion = Number(data.lastSeenVersion ?? 0);

function stringArrayData(value: string | undefined, name: string): string[] {
  if (value === undefined) throw new Error(`${name} is missing`);
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
    throw new Error(`${name} must be a string array`);
  }
  return parsed;
}

function knownPagesData(value: string | undefined): KnownPage[] {
  if (value === undefined) throw new Error('known pages are missing');
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed)
    || !parsed.every((entry: unknown) => {
      if (typeof entry !== 'object' || entry === null) return false;
      if (!('title' in entry) || !('image' in entry)) return false;
      return typeof entry.title === 'string' && (entry.image === null || typeof entry.image === 'string');
    })
  ) {
    throw new Error('known pages must contain a title and optional image');
  }
  return parsed;
}

const allowedImageHosts = stringArrayData(data.allowedImageHosts, 'allowed image hosts');
const allowedMediaHosts = stringArrayData(data.allowedMediaHosts, 'allowed media hosts');
const knownPages = knownPagesData(data.knownPages);

function unixTime(): number {
  return Math.floor(Date.now() / 1000);
}

function pendingKey(value: string): string {
  return `knot:pending:${project}/${titleLc(value)}`;
}

function readPending(key: string): PendingRecord | null {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  const record = parsePendingRecord(raw);
  if (record === null) localStorage.removeItem(key);
  return record;
}

let storageKey = pendingKey(title);
let engine: SyncEngine;
let view: EditorView;
let timer: number | undefined;
let statusMessage: string | undefined;
let suppressChanges = false;

function renderStatus(): void {
  const labels = {
    saved: '保存済み',
    saving: '保存中',
    dirty: '未保存',
    conflict: '競合を解消してください',
    error: 'エラー',
  } as const;
  saveStatus.hidden = false;
  saveStatus.textContent = statusMessage ?? labels[engine.status];
  saveStatus.dataset.status = engine.status;
}

function conflictValue(label: string, value: RebaseLineState): HTMLDivElement {
  const container = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value.kind === 'present' ? value.text : '（削除）';
  container.append(term, description);
  return container;
}

function renderConflicts(conflicts: readonly RebaseConflict[]): void {
  const items = conflicts.map((conflict, index) => {
    const item = document.createElement('li');
    item.className = 'edit-conflict-list-item';
    const label = document.createElement('strong');
    label.textContent = `競合した行 ${index + 1}`;
    const values = document.createElement('dl');
    values.className = 'edit-conflict-values';
    values.append(
      conflictValue('基準', conflict.base),
      conflictValue('手元', conflict.local),
      conflictValue('サーバ', conflict.latest),
    );
    item.append(label, values);
    return item;
  });
  conflictList.replaceChildren(...items);
  resolveConflictButton.disabled = false;
  conflictPanel.hidden = false;
  statusMessage = `${conflicts.length} 行の競合があるため、自動保存を停止しました`;
  renderStatus();
  conflictPanel.focus();
}

function clearConflictPanel(): void {
  conflictPanel.hidden = true;
  conflictList.replaceChildren();
  resolveConflictButton.disabled = false;
}

function moveTitleIfNeeded(previousTitle: string): void {
  if (engine.currentTitle === previousTitle) return;
  const oldKey = storageKey;
  storageKey = pendingKey(engine.currentTitle);
  const pending = localStorage.getItem(oldKey);
  if (pending !== null) {
    localStorage.setItem(storageKey, pending);
    localStorage.removeItem(oldKey);
  }
  window.history.replaceState(null, '', pageHref(project, engine.currentTitle));
}

function syncDocument(lines: readonly string[]): void {
  const next = lines.join('\n');
  if (view.state.doc.toString() === next) return;
  suppressChanges = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
  suppressChanges = false;
}

function refreshGutter(): void {
  view.dispatch({ effects: refreshTelomereGutter.of(undefined) });
}

function textsAfterConflict(
  page: { version: number; lines: Snapshot['lines'] },
  effects: readonly SyncEffect[],
): string[] {
  const conflict = effects.find((effect) => effect.type === 'conflict');
  if (conflict !== undefined) return conflict.texts;
  const send = effects.find((effect) => effect.type === 'send');
  if (send === undefined) return page.lines.map(({ text }) => text);
  return applyOps(page.lines, send.commit.ops, {
    userId: userName,
    now: unixTime(),
    version: page.version + 1,
  }).map(({ text }) => text);
}

async function executeEffects(effects: readonly SyncEffect[], keepalive = false): Promise<void> {
  // Persist before awaiting the network so pagehide can always recover the inflight commit.
  for (const effect of effects) {
    if (effect.type !== 'persist') continue;
    if (effect.record === null) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, serializePendingRecord(effect.record));
  }
  for (const effect of effects) {
    if (effect.type === 'schedule') {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = undefined;
        void executeEffects(engine.flush());
        renderStatus();
      }, SAVE_DELAY_MS);
      continue;
    }
    if (effect.type === 'persist') {
      continue;
    }
    if (effect.type === 'conflict') {
      syncDocument(effect.texts);
      renderConflicts(effect.conflicts);
      continue;
    }

    const bodySize = new TextEncoder().encode(JSON.stringify(effect.commit)).byteLength;
    if (keepalive && bodySize > KEEPALIVE_BODY_LIMIT) {
      await executeEffects(engine.ackFailure());
      continue;
    }

    const result = await postCommit(project, effect.title, effect.commit, { keepalive });
    const previousTitle = engine.currentTitle;
    if (result.kind === 'ok') {
      await executeEffects(engine.ackSuccess(result.version), keepalive);
      clearConflictPanel();
      refreshGutter();
      moveTitleIfNeeded(previousTitle);
      statusMessage = undefined;
    } else if (result.kind === 'conflict') {
      const nextEffects = engine.ackConflict(result.page);
      await executeEffects(nextEffects, keepalive);
      refreshGutter();
      moveTitleIfNeeded(previousTitle);
      if (engine.status !== 'conflict') statusMessage = undefined;
    } else if (result.kind === 'network') {
      await executeEffects(engine.ackFailure(), keepalive);
    } else {
      await executeEffects(engine.ackBad(), keepalive);
      statusMessage = result.message === 'first line must match the URL title'
        ? 'タイトル行が URL と一致しません'
        : `エラー: ${result.message}`;
      renderStatus();
      return;
    }
    renderStatus();
  }
}

type Recovery = { engine: SyncEngine; effects: SyncEffect[]; texts: string[] };

// 起動時再送がサーバに拒否されたとき、失われる内容をエディタに見せるための持ち越し。
let rejectedPendingTexts: string[] | null = null;

function expectedTexts(record: PendingRecord): string[] {
  return applyOps(record.baseLines, record.ops, {
    userId: userName,
    now: unixTime(),
    version: record.baseVersion + 1,
  }).map(({ text }) => text);
}

async function restorePending(record: PendingRecord): Promise<Recovery | null> {
  const result = await postCommit(project, record.title, {
    commitId: record.commitId,
    baseVersion: record.baseVersion,
    ops: record.ops,
  });
  if (result.kind === 'ok') {
    localStorage.removeItem(storageKey);
    return null;
  }
  if (result.kind === 'bad') {
    // 拒否されたコミットは再送しない。ただし黙って捨てず、内容をバッファに残して警告を出す。
    // record の削除はエディタが起動して内容が画面に載った後まで遅延する
    // （この後の fetchPage が失敗した場合、リロードで再びこの経路に入れるように）。
    rejectedPendingTexts = expectedTexts(record);
    statusMessage = `前回の未保存の編集を自動反映できませんでした: ${result.message}`;
    return null;
  }
  // 元の PendingRecord を inflight のまま復元する。network 時の再送が同じ commitId・同じ ops
  // になり（冪等）、元のコミットが実は届いていた場合も重複適用にならない。
  const restored = new SyncEngine({
    snapshot: { version: record.baseVersion, lines: record.baseLines },
    title: record.title,
    userId: userName,
    isNew: record.baseVersion === 0,
    pending: record,
    now: unixTime,
  });
  const expected = expectedTexts(record);
  if (result.kind === 'network') {
    return { engine: restored, effects: restored.ackFailure(), texts: expected };
  }
  const effects = restored.ackConflict(result.page);
  return { engine: restored, effects, texts: textsAfterConflict(result.page, effects) };
}

async function start(): Promise<void> {
  const pending = readPending(storageKey);
  const recovery = pending === null ? null : await restorePending(pending);
  const page = await fetchPage(project, title);

  engine = recovery?.engine ?? new SyncEngine({
    snapshot: page?.snapshot ?? { version: 0, lines: [] },
    title: page?.title ?? title,
    userId: userName,
    isNew: page === null,
    now: unixTime,
  });
  const initialLines = recovery?.texts
    ?? rejectedPendingTexts
    ?? (page === null ? [title] : page.snapshot.lines.map(({ text }) => text));

  editorRoot.replaceChildren();
  editorRoot.classList.add('editor-active');
  editButton.hidden = true;
  document.querySelector<HTMLElement>('#page-menu-root')?.setAttribute('hidden', '');
  view = new EditorView({
    doc: initialLines.join('\n'),
    parent: editorRoot,
    extensions: [
      EditorView.cspNonce.of(cspNonce),
      historyExtension(),
      lineWysiwyg({ project, allowedImageHosts, allowedMediaHosts, knownPages }),
      keymap.of([...editorKeymap(userName), ...defaultKeymap, ...historyKeymap]),
      pasteHandlers({
        uploadFile: (file) => uploadFile(project, file),
        onUploadError: (message) => {
          statusMessage = `エラー: ${message}`;
          renderStatus();
        },
      }),
      titleAutocompletion(project),
      syntaxHighlighting,
      telomereGutter({
        confirmedLines: () => engine.confirmedLines,
        userId: userName,
        lastSeenVersion,
        now: unixTime,
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || suppressChanges) return;
        statusMessage = undefined;
        void executeEffects(engine.bufferChanged(update.state.doc.toString().split('\n')));
        renderStatus();
      }),
    ],
  });
  renderStatus();
  view.focus();
  // 拒否された pending の内容が画面に載ったので、ここで初めて record を消してよい。
  if (rejectedPendingTexts !== null) localStorage.removeItem(storageKey);
  if (recovery !== null) await executeEffects(recovery.effects);
  window.addEventListener('pagehide', flushOnExit);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function flushOnExit(): void {
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
  void executeEffects(engine.flush(), true);
  renderStatus();
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') flushOnExit();
}

resolveConflictButton.addEventListener('click', () => {
  resolveConflictButton.disabled = true;
  statusMessage = undefined;
  const effects = engine.resolveConflict();
  if (engine.status === 'saved') clearConflictPanel();
  void executeEffects(effects);
  renderStatus();
});

let starting = false;
editButton.addEventListener('click', () => {
  if (starting) return;
  starting = true;
  editButton.disabled = true;
  void start().catch((error: unknown) => {
    console.error(error);
    starting = false;
    editButton.disabled = false;
    saveStatus.hidden = false;
    saveStatus.textContent = 'エラー';
    saveStatus.dataset.status = 'error';
  });
});
