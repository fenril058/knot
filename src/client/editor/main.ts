import { defaultKeymap, history as historyExtension, historyKeymap } from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
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
  parseEditorRecord,
  serializeEditorRecord,
  SyncEngine,
  type EditorRecord,
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
  throw new Error('editor UI element is missing');
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

function pendingKey(value: string, pageId?: string): string {
  return pageId === undefined
    ? `knot:pending:${project}/title:${titleLc(value)}`
    : `knot:pending:${project}/page:${pageId}`;
}

function legacyPendingKey(value: string): string {
  return `knot:pending:${project}/${titleLc(value)}`;
}

function readPending(key: string): EditorRecord | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const record = parseEditorRecord(raw);
    if (record === null) localStorage.removeItem(key);
    return record;
  } catch (error) {
    console.error('failed to read the editor recovery record', error);
    storageWarning = 'ブラウザに未保存内容を保存できません';
    return null;
  }
}

const initialPageId = data.pageId;
let storageKey = pendingKey(title, initialPageId);
let engine: SyncEngine;
let view: EditorView;
let timer: number | undefined;
let statusMessage: string | undefined;
let storageWarning: string | undefined;
let suppressChanges = false;

function readInitialPending(): EditorRecord | null {
  const record = readPending(storageKey);
  if (record !== null) return record;
  const fallbackKeys = [pendingKey(title), legacyPendingKey(title)];
  for (const fallbackKey of fallbackKeys) {
    if (fallbackKey === storageKey) continue;
    const fallbackRecord = readPending(fallbackKey);
    if (fallbackRecord === null) continue;
    const migratedRecord: EditorRecord = fallbackRecord.pageId === undefined && initialPageId !== undefined
      ? { ...fallbackRecord, pageId: initialPageId }
      : fallbackRecord;
    try {
      localStorage.setItem(storageKey, serializeEditorRecord(migratedRecord));
      localStorage.removeItem(fallbackKey);
    } catch (error) {
      console.error('failed to migrate the editor recovery record', error);
      storageKey = fallbackKey;
      storageWarning = 'ブラウザに未保存内容を保存できません';
    }
    return migratedRecord;
  }
  return null;
}

function renderStatus(): void {
  const labels = {
    saved: '保存済み',
    saving: '保存中',
    dirty: '未保存',
    conflict: '競合を解消してください',
    error: 'エラー',
  } as const;
  saveStatus.hidden = false;
  const message = statusMessage ?? labels[engine.status];
  saveStatus.textContent = storageWarning === undefined ? message : `${message}（${storageWarning}）`;
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
      conflictValue('サーバ上の最新版', conflict.latest),
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

function syncEditorLocation(previousTitle: string): void {
  const oldKey = storageKey;
  storageKey = pendingKey(engine.currentTitle, engine.pageId);
  if (storageKey !== oldKey) {
    try {
      const pending = localStorage.getItem(oldKey);
      if (pending !== null) {
        localStorage.setItem(storageKey, pending);
        localStorage.removeItem(oldKey);
      }
      storageWarning = undefined;
    } catch (error) {
      console.error('failed to move the editor recovery record', error);
      storageWarning = 'ブラウザに未保存内容を保存できません';
    }
  }
  if (engine.currentTitle !== previousTitle) {
    window.history.replaceState(null, '', pageHref(project, engine.currentTitle));
  }
}

function syncDocument(lines: readonly string[]): void {
  const next = lines.join('\n');
  if (view.state.doc.toString() === next) return;
  const previousDocument = view.state.doc;
  const previousSelection = view.state.selection;
  const nextLines = lines.length === 0 ? [''] : lines;
  const mapPosition = (position: number): number => {
    const previousLine = previousDocument.lineAt(position);
    const lineIndex = Math.min(previousLine.number - 1, nextLines.length - 1);
    let lineStart = 0;
    for (let index = 0; index < lineIndex; index++) lineStart += nextLines[index]!.length + 1;
    return lineStart + Math.min(position - previousLine.from, nextLines[lineIndex]!.length);
  };
  const selection = EditorSelection.create(
    previousSelection.ranges.map(({ anchor, head }) => EditorSelection.range(mapPosition(anchor), mapPosition(head))),
    previousSelection.mainIndex,
  );
  suppressChanges = true;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection });
  suppressChanges = false;
}

function refreshGutter(): void {
  view.dispatch({ effects: refreshTelomereGutter.of(undefined) });
}

function textsAfterEffects(
  page: { version: number; lines: Snapshot['lines'] },
  effects: readonly SyncEffect[],
): string[] {
  const replacement = effects.find((effect) => effect.type === 'replace-document');
  if (replacement !== undefined) return replacement.texts;
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
  let persistenceAttempted = false;
  let persistenceFailed = false;
  for (const effect of effects) {
    if (effect.type !== 'persist') continue;
    persistenceAttempted = true;
    try {
      if (effect.record === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, serializeEditorRecord(effect.record));
    } catch (error) {
      console.error('failed to persist the editor recovery record', error);
      persistenceFailed = true;
    }
  }
  if (persistenceAttempted) {
    storageWarning = persistenceFailed ? 'ブラウザに未保存内容を保存できません' : undefined;
    renderStatus();
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
    if (effect.type === 'replace-document') {
      syncDocument(effect.texts);
      continue;
    }
    if (effect.type === 'present-conflict') {
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
      const nextEffects = engine.ackSuccess(result.version, result.pageId);
      clearConflictPanel();
      refreshGutter();
      syncEditorLocation(previousTitle);
      statusMessage = undefined;
      await executeEffects(nextEffects, keepalive);
    } else if (result.kind === 'conflict') {
      const nextEffects = engine.ackConflict(result.page);
      clearConflictPanel();
      refreshGutter();
      syncEditorLocation(previousTitle);
      statusMessage = undefined;
      await executeEffects(nextEffects, keepalive);
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

function expectedTexts(record: PendingRecord): string[] {
  const committed = applyOps(record.baseLines, record.ops, {
    userId: userName,
    now: unixTime(),
    version: record.baseVersion + 1,
  }).map(({ text }) => text);
  return record.draftTexts === undefined ? committed : record.draftTexts;
}

async function restorePending(record: EditorRecord): Promise<Recovery | null> {
  const currentTitle = record.pageId !== undefined && record.pageId === initialPageId ? title : record.title;
  if (record.kind === 'conflict-draft') {
    const locatedRecord = { ...record, title: currentTitle };
    const restored = new SyncEngine({
      snapshot: record.latest,
      title: currentTitle,
      userId: userName,
      isNew: false,
      conflictDraft: locatedRecord,
      now: unixTime,
    });
    return { engine: restored, effects: restored.restoredEffects(), texts: record.texts };
  }
  if (record.kind === 'unsaved-draft') {
    const locatedRecord = { ...record, title: currentTitle };
    const restored = new SyncEngine({
      snapshot: record.confirmed,
      title: currentTitle,
      userId: userName,
      isNew: false,
      unsavedDraft: locatedRecord,
      now: unixTime,
    });
    return { engine: restored, effects: restored.restoredEffects(), texts: record.texts };
  }
  const restored = new SyncEngine({
    snapshot: { version: record.baseVersion, lines: record.baseLines },
    title: currentTitle,
    userId: userName,
    isNew: record.baseVersion === 0,
    pending: record,
    now: unixTime,
  });
  const result = await postCommit(project, record.title, {
    ...(record.pageId === undefined ? {} : { pageId: record.pageId }),
    commitId: record.commitId,
    baseVersion: record.baseVersion,
    ops: record.ops,
  });
  if (result.kind === 'ok') {
    let latest: Awaited<ReturnType<typeof fetchPage>> = null;
    if (record.pageId !== undefined) {
      try {
        latest = await fetchPage(project, title, record.pageId);
      } catch (error) {
        console.error('failed to check the latest page after recovering a commit', error);
      }
    }
    const acknowledged = restored.ackSuccess(result.version, result.pageId);
    if (latest !== null && latest.snapshot.version > result.version) {
      if (acknowledged.some((effect) => effect.type === 'send')) {
        const effects = restored.ackConflict({
          id: latest.id,
          version: latest.snapshot.version,
          title: latest.title,
          lines: latest.snapshot.lines,
        });
        return { engine: restored, effects, texts: textsAfterEffects(latest.snapshot, effects) };
      }
      const current = new SyncEngine({
        snapshot: latest.snapshot,
        title: latest.title,
        pageId: latest.id,
        userId: userName,
        isNew: false,
        now: unixTime,
      });
      const texts = latest.snapshot.lines.map(({ text }) => text);
      return {
        engine: current,
        effects: [{ type: 'replace-document', texts }, { type: 'persist', record: null }],
        texts,
      };
    }
    return {
      engine: restored,
      effects: acknowledged,
      texts: expectedTexts(record),
    };
  }
  if (result.kind === 'bad') {
    statusMessage = `前回の未保存の編集を自動反映できませんでした: ${result.message}`;
    return { engine: restored, effects: restored.ackBad(), texts: expectedTexts(record) };
  }
  // 元の PendingRecord を inflight のまま復元する。network 時の再送が同じ commitId・同じ ops
  // になり（冪等）、元のコミットが実は届いていた場合も重複適用にならない。
  const expected = expectedTexts(record);
  if (result.kind === 'network') {
    return { engine: restored, effects: restored.ackFailure(), texts: expected };
  }
  const effects = restored.ackConflict(result.page);
  return { engine: restored, effects, texts: textsAfterEffects(result.page, effects) };
}

async function start(): Promise<void> {
  const pending = readInitialPending();
  const recovery = pending === null ? null : await restorePending(pending);
  const page = recovery === null
    ? await fetchPage(project, title, initialPageId)
    : null;

  engine = recovery?.engine ?? new SyncEngine({
    snapshot: page?.snapshot ?? { version: 0, lines: [] },
    title: page?.title ?? title,
    pageId: page?.id ?? initialPageId,
    userId: userName,
    isNew: page === null,
    now: unixTime,
  });
  syncEditorLocation(title);
  const initialLines = recovery?.texts
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
