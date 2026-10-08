import { defaultKeymap, history as historyExtension, historyKeymap } from '@codemirror/commands';
import { ChangeSet, Transaction } from '@codemirror/state';
import { keymap, EditorView } from '@codemirror/view';
import { applyOps } from '../../core/apply.ts';
import type { RebaseConflict, RebaseLineState } from '../../core/rebase.ts';
import { titleLc, pageHref } from '../../core/title.ts';
import { knownPageMap, presentationLines, type KnownPage, type PresentedLine } from '../../render/presentation.ts';
import { fetchPage, postCommit, uploadFile } from './api.ts';
import {
  clickTarget,
  lineElements,
  selectionPoint,
  sourcePosition,
  type ClickTarget,
  type LineElements,
  type SelectionPoint,
} from './caretPosition.ts';
import { answerSettleEdits, type SettledPage } from '../editSession.ts';
import { mapSelectionByLineId } from './documentChanges.ts';
import { titleAutocompletion } from './cm/complete.ts';
import { doubleClickWordSelection, wordRange } from './cm/wordSelection.ts';
import { syntaxHighlighting } from './cm/decorations.ts';
import { editorKeymap } from './cm/keymap.ts';
import { editStartPosition, imageSizeKey, lineWysiwyg, type ImageSize } from './cm/lineWysiwyg.ts';
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
const STORAGE_WARNING = 'ブラウザに未保存内容を保存できません';
const RECOVERY_WARNING = '再読み込み後に未保存内容を自動復元できません';

const root = document.querySelector<HTMLElement>('#editor-root');
const statusElement = document.querySelector<HTMLElement>('#save-status');
const conflictPanelElement = document.querySelector<HTMLElement>('#edit-conflict');
const conflictListElement = document.querySelector<HTMLOListElement>('#edit-conflict-list');
const resolveConflictButtonElement = document.querySelector<HTMLButtonElement>('#resolve-edit-conflict');
const recoveryDialogElement = document.querySelector<HTMLDialogElement>('#recovery-dialog');
const recoveryRecordsElement = document.querySelector<HTMLUListElement>('#recovery-records');
const startFreshButtonElement = document.querySelector<HTMLButtonElement>('#start-fresh-edit');
if (
  root === null
  || statusElement === null
  || conflictPanelElement === null
  || conflictListElement === null
  || resolveConflictButtonElement === null
  || recoveryDialogElement === null
  || recoveryRecordsElement === null
  || startFreshButtonElement === null
) {
  throw new Error('editor UI element is missing');
}
const editorRoot = root;
const saveStatus = statusElement;
const conflictPanel = conflictPanelElement;
const conflictList = conflictListElement;
const resolveConflictButton = resolveConflictButtonElement;
const recoveryDialog = recoveryDialogElement;
const recoveryRecords = recoveryRecordsElement;
const startFreshButton = startFreshButtonElement;

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

// テロメアの線の太さを、閲覧表示と同じ時刻で決める。閲覧表示はサーバの時刻で描かれているので、
// その時刻に、ページを読み込んでからの経過時間を足す。端末の時計がずれていても編集開始で変わらない。
const renderedAt = Number(data.renderedAt);
const loadedAt = performance.now();

function telomereTime(): number {
  if (!Number.isFinite(renderedAt)) return unixTime();
  return renderedAt + Math.floor((performance.now() - loadedAt) / 1000);
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
    storageWarning = STORAGE_WARNING;
    return null;
  }
}

const initialPageId = data.pageId;
let storageKey = pendingKey(title, initialPageId);
let editorId: string;
let hadEditorReference = false;
let engine: SyncEngine;
let view: EditorView;
let timer: number | undefined;
let statusMessage: string | undefined;
let storageWarning: string | undefined;
let ownershipUnavailable = false;
let suppressChanges = false;

function ownedKey(baseKey: string): string {
  return `${baseKey}/editor:${editorId}`;
}

function newEditorId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rememberEditor(baseKey: string): void {
  try {
    sessionStorage.setItem(baseKey, editorId);
    ownershipUnavailable = false;
    if (storageWarning === RECOVERY_WARNING) storageWarning = undefined;
  } catch (error) {
    console.error('failed to remember the editor recovery record', error);
    ownershipUnavailable = true;
    storageWarning = RECOVERY_WARNING;
  }
}

function initializeStorage(): void {
  const baseKey = storageKey;
  const navigation = performance.getEntriesByType('navigation')[0];
  editorId = newEditorId();
  try {
    const previous = navigation !== undefined && 'type' in navigation
      && (navigation.type === 'reload' || navigation.type === 'back_forward')
      ? sessionStorage.getItem(baseKey)
      : null;
    hadEditorReference = previous !== null;
    if (previous !== null) editorId = previous;
  } catch (error) {
    console.error('failed to read the editor recovery ownership', error);
    ownershipUnavailable = true;
    storageWarning = RECOVERY_WARNING;
  }
  storageKey = ownedKey(baseKey);
  rememberEditor(baseKey);
}

function readInitialPending(): EditorRecord | null {
  const record = readPending(storageKey);
  if (record !== null) return record;
  const fallbackKeys = initialPageId === undefined
    ? [pendingKey(title), legacyPendingKey(title)]
    : [pendingKey(title, initialPageId), pendingKey(title), legacyPendingKey(title)];
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
      storageWarning = STORAGE_WARNING;
    }
    return migratedRecord;
  }
  return null;
}

async function chooseAvailableRecord(): Promise<EditorRecord | null> {
  const baseKey = pendingKey(title, initialPageId);
  const available: Array<{ record: EditorRecord; texts: string[] }> = [];
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key === null || !key.startsWith(`${baseKey}/editor:`) || key === storageKey) continue;
      const raw = localStorage.getItem(key);
      const record = raw === null ? null : parseEditorRecord(raw);
      if (record === null) continue;
      try {
        const texts = record.kind === 'conflict-draft' || record.kind === 'unsaved-draft'
          ? record.texts
          : expectedTexts(record);
        available.push({ record, texts });
      } catch {
        // A malformed record owned by another editor must not prevent editing.
      }
    }
  } catch (error) {
    console.error('failed to list editor recovery records', error);
    storageWarning = STORAGE_WARNING;
    return null;
  }
  if (available.length === 0) return null;

  let selected: EditorRecord | null = null;
  const items = available.map(({ record, texts }) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `復元する: ${texts.slice(0, 3).join(' / ').slice(0, 120)}`;
    button.addEventListener('click', () => {
      selected = record;
      recoveryDialog.close();
    });
    item.append(button);
    return item;
  });
  recoveryRecords.replaceChildren(...items);
  const chosen = await new Promise<EditorRecord | null>((resolve) => {
    recoveryDialog.addEventListener('close', () => resolve(selected), { once: true });
    startFreshButton.addEventListener('click', () => recoveryDialog.close(), { once: true });
    recoveryDialog.showModal();
  });
  if (chosen !== null) {
    try {
      localStorage.setItem(storageKey, serializeEditorRecord(chosen));
    } catch (error) {
      console.error('failed to copy the editor recovery record', error);
      storageWarning = STORAGE_WARNING;
    }
  }
  return chosen;
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
  const baseKey = pendingKey(engine.currentTitle, engine.pageId);
  storageKey = ownedKey(baseKey);
  rememberEditor(baseKey);
  if (storageKey !== oldKey) {
    try {
      const pending = localStorage.getItem(oldKey);
      if (pending !== null) {
        localStorage.setItem(storageKey, pending);
        localStorage.removeItem(oldKey);
      }
      if (!ownershipUnavailable) storageWarning = undefined;
    } catch (error) {
      console.error('failed to move the editor recovery record', error);
      storageWarning = STORAGE_WARNING;
    }
  }
  if (engine.currentTitle !== previousTitle) {
    window.history.replaceState(null, '', pageHref(project, engine.currentTitle));
  }
}

function syncDocument(effect: Extract<SyncEffect, { type: 'replace-document' }>): void {
  const next = effect.texts.join('\n');
  const current = view.state.doc.toString();
  const beforeText = effect.selectionLines?.before.map(({ text }) => text).join('\n');
  if (current === next && beforeText !== current) return;
  const changes = effect.changes === undefined
    ? ChangeSet.of({ from: 0, to: view.state.doc.length, insert: next }, view.state.doc.length)
    : ChangeSet.of(effect.changes, view.state.doc.length);
  if (changes.apply(view.state.doc).toString() !== next) {
    throw new Error('replacement changes do not produce the expected document');
  }
  const selection = effect.selectionLines === undefined
    ? undefined
    : mapSelectionByLineId(
        effect.selectionLines.before,
        effect.selectionLines.after,
        view.state.selection,
        changes,
      );
  suppressChanges = true;
  try {
    view.dispatch({
      changes,
      ...(selection === undefined ? {} : { selection }),
      ...(effect.excludeFromUndoHistory === true
        ? { annotations: Transaction.addToHistory.of(false) }
        : {}),
    });
  } finally {
    suppressChanges = false;
  }
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
    storageWarning = persistenceFailed ? STORAGE_WARNING : ownershipUnavailable ? RECOVERY_WARNING : undefined;
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
      try {
        syncDocument(effect);
      } catch (error) {
        console.error('failed to apply the replacement document', error);
        statusMessage = 'エラー: 文書の更新に失敗しました。再読み込みしてください';
        renderStatus();
        return;
      }
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

// SSR 行の画面上の位置。画面に掛かっている行は、上端がはみ出していてもその位置へ戻す。
// 完全に画面の外にある行は、そこへ戻しても編集対象が見えないので対象にしない。
function visibleRowTop(lineId: string): number | undefined {
  const row = document.getElementById(`L${lineId}`);
  if (row === null) return undefined;
  const box = row.getBoundingClientRect();
  return box.bottom > 0 && box.top < window.innerHeight ? box.top : undefined;
}

// 閲覧表示で読み込み済みの画像が、描かれている大きさ。
function loadedImageSizes(): Map<string, ImageSize> {
  const sizes = new Map<string, ImageSize>();
  for (const image of editorRoot.querySelectorAll('img')) {
    const src = image.getAttribute('src');
    if (src === null || !image.complete || image.naturalWidth === 0) continue;
    const box = image.getBoundingClientRect();
    sizes.set(imageSizeKey(src, image.className), { width: box.width, height: box.height });
  }
  return sizes;
}

// click は閲覧表示の行を押した位置。編集を始める前（本文を差し替える前）に、取得した本文の
// 原文の位置へ直す。
type InitialEditTarget = { lineId: string; lineNumber: number; click?: { elements: LineElements; target: ClickTarget } };

// 押した位置や選んでいた範囲を原文の位置へ直せないときは、その位置を使わずに編集を始める。
// 直す途中で例外が出ても、編集の開始は止めない。
function unlessThrows<T>(compute: () => T | undefined): T | undefined {
  try {
    return compute();
  } catch {
    return undefined;
  }
}

function presentedLines(doc: string): PresentedLine[] {
  return presentationLines(doc, knownPageMap(knownPages), project, { allowedImageHosts, allowedMediaHosts });
}

function clickedSourcePosition(
  lines: readonly PresentedLine[],
  lineNumber: number,
  click: NonNullable<InitialEditTarget['click']>,
): number | undefined {
  const line = lines.find((candidate) => candidate.number === lineNumber);
  return line === undefined ? undefined : sourcePosition(line, click.elements, click.target);
}

type SourceRange = { anchor: number; head: number };
type RowPosition = { row: HTMLElement; node: Node; offset: number };

// selection の端がある行。最後の行を triple click で選ぶと、終わりの端は本文より後ろ（関連ページ
// など）に来るので、最後の行の終わりとして扱う。
function selectionRow(rows: readonly HTMLElement[], node: Node, offset: number): RowPosition | undefined {
  const row = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.line-row');
  if (row !== null && row !== undefined && row.parentElement === editorRoot) return { row, node, offset };
  const last = rows.at(-1);
  if (last === undefined) return undefined;
  const range = document.createRange();
  range.setStart(node, offset);
  const end = last.childNodes.length;
  return range.comparePoint(last, end) < 0 ? { row: last, node: last, offset: end } : undefined;
}

// 閲覧表示で選んでいた範囲（double click の単語、triple click の行など）。本文を差し替えると消えるので、
// その前に原文の位置へ直し、編集表示でも同じ範囲を選んだまま始める（#194）。端が行の本文の外に
// あるのは triple click で次の行の頭まで選んだときで、CodeMirror の triple click と同じく、
// 前の端を行頭に寄せて行ごと選ぶ。
function selectedSourceRange(lines: readonly PresentedLine[]): SourceRange | undefined {
  const selection = window.getSelection();
  if (selection === null || selection.isCollapsed || selection.anchorNode === null || selection.focusNode === null) {
    return undefined;
  }
  const rows = Array.from(editorRoot.querySelectorAll<HTMLElement>(':scope > .line-row'));
  const pointOf = (node: Node, offset: number): (SelectionPoint & { lineFrom: number }) | undefined => {
    const end = selectionRow(rows, node, offset);
    if (end === undefined) return undefined;
    // 行番号は、編集開始の行と同じく行 ID から引く。
    const confirmedIndex = engine.confirmedLines.findIndex(({ id }) => `L${id}` === end.row.id);
    const lineNumber = confirmedIndex === -1 ? rows.indexOf(end.row) + 1 : confirmedIndex + 1;
    const line = lines.find((candidate) => candidate.number === lineNumber);
    const elements = lineElements(end.row);
    if (line === undefined || elements === undefined) return undefined;
    const point = selectionPoint(line, elements, end.node, end.offset);
    return point === undefined ? undefined : { ...point, lineFrom: line.from };
  };
  const anchor = pointOf(selection.anchorNode, selection.anchorOffset);
  const head = pointOf(selection.focusNode, selection.focusOffset);
  if (anchor === undefined || head === undefined || anchor.position === head.position) return undefined;
  if (anchor.inLine && head.inLine) return { anchor: anchor.position, head: head.position };
  return anchor.position < head.position
    ? { anchor: anchor.lineFrom, head: head.position }
    : { anchor: anchor.position, head: head.lineFrom };
}

async function start(initialTarget?: InitialEditTarget): Promise<void> {
  initializeStorage();
  const pending = readInitialPending() ?? (hadEditorReference ? null : await chooseAvailableRecord());
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
  // 未保存の変更があると doc は recovery.texts になる一方、行 ID はサーバ確定行から引くため、
  // 未保存の行挿入がある場合は click した行とずれる。契約が「可能な限り対応行」なので許容する。
  const initialLineNumber = initialTarget === undefined
    ? undefined
    : (() => {
        const confirmedIndex = engine.confirmedLines.findIndex(({ id }) => id === initialTarget.lineId);
        return confirmedIndex === -1 ? initialTarget.lineNumber : confirmedIndex + 1;
      })();

  // 差し替えの前に、編集対象の行が画面のどこにあったかを覚える。本文を CodeMirror へ
  // 差し替えると文書の高さが一度縮み、ブラウザが scroll 位置を切り詰めてしまう。
  const anchorTop = initialTarget === undefined ? undefined : visibleRowTop(initialTarget.lineId);
  // 閲覧表示で読み込み済みの画像の大きさも、差し替えで img が消える前に覚える。
  const imageSizes = loadedImageSizes();
  // 押した位置と選んでいた範囲も、閲覧表示の行が消える前に原文の位置へ直す。
  const initialPresentation = initialLineNumber === undefined
    ? undefined
    : unlessThrows(() => presentedLines(initialLines.join('\n')));
  const click = initialTarget?.click;
  const clickedPosition = click === undefined || initialLineNumber === undefined || initialPresentation === undefined
    ? undefined
    : unlessThrows(() => clickedSourcePosition(initialPresentation, initialLineNumber, click));
  const selectedRange = initialPresentation === undefined
    ? undefined
    : unlessThrows(() => selectedSourceRange(initialPresentation));

  editorRoot.replaceChildren();
  // ページメニューは編集中も出したままにする（#192）。ページ操作の前には、メニューが
  // answerSettleEdits の約束事で手元の編集を保存し終えるのを待つ。
  view = new EditorView({
    doc: initialLines.join('\n'),
    parent: editorRoot,
    extensions: [
      EditorView.cspNonce.of(cspNonce),
      // 閲覧表示は通常の block として折り返る。これを入れないと CodeMirror の既定の
      // white-space: pre のままで、編集を開始した瞬間に長い行が横スクロールへ変わる。
      EditorView.lineWrapping,
      historyExtension(),
      lineWysiwyg({ project, allowedImageHosts, allowedMediaHosts, knownPages, imageSizes, cspNonce }),
      doubleClickWordSelection,
      // blur は defaultKeymap より後ろに置く。補完の Escape は Prec.highest で先に処理され、
      // 選択の simplifySelection も先に試されて、どちらも該当しないときだけ抜ける。
      keymap.of([
        ...editorKeymap(userName),
        ...defaultKeymap,
        ...historyKeymap,
        { key: 'Escape', run: (target) => { target.contentDOM.blur(); return true; } },
      ]),
      pasteHandlers({
        uploadFile: (file) => uploadFile(project, file),
        onUploadError: (message) => {
          statusMessage = `エラー: ${message}`;
          renderStatus();
        },
      }),
      titleAutocompletion(project),
      syntaxHighlighting(knownPages),
      telomereGutter({
        confirmedLines: () => engine.confirmedLines,
        userId: userName,
        lastSeenVersion,
        title: () => engine.currentTitle,
        now: telomereTime,
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || suppressChanges) return;
        statusMessage = undefined;
        void executeEffects(engine.bufferChanged(update.state.doc.toString().split('\n')));
        renderStatus();
      }),
    ],
  });
  // editor-active は view を代入した後に付ける。keydown handler はこの class だけを見て
  // view.focus() を呼ぶので、先に付けると view 未代入の窓ができる。
  editorRoot.classList.add('editor-active');
  if (initialLineNumber !== undefined) {
    const selectedLine = view.state.doc.line(Math.min(initialLineNumber, view.state.doc.lines));
    // 画面に見えていた行から始めたなら同じ位置へ戻す。見えていない行（ショートカットの
    // 最終行など）から始めたときは、caret のほうを画面へ入れる。
    // caret は押した字の位置に置く。押した位置が分からないとき（ショートカットで始めたとき、
    // 閲覧表示を描いた後で本文が変わったとき）は本文の先頭に置く。
    const clickedAnchor = clickedPosition !== undefined && clickedPosition >= selectedLine.from && clickedPosition <= selectedLine.to
      ? clickedPosition
      : undefined;
    view.dispatch({
      selection: selectedRange ?? { anchor: clickedAnchor ?? editStartPosition(view.state, selectedLine.number) },
      scrollIntoView: anchorTop === undefined,
    });
    // coordsAtPos は保留中の計測を済ませてから位置を返すので、そのあとの lineBlockAt は
    // 計測済みの行の箱になる。比べるのは caret の矩形（字の高さ）ではなく、SSR 行と同じ
    // 行の箱の上端にする。行送りが字より高いと、caret の矩形との差だけ画面が動く。
    if (anchorTop !== undefined && view.coordsAtPos(selectedLine.from) !== null) {
      window.scrollBy(0, view.documentTop + view.lineBlockAt(selectedLine.from).top - anchorTop);
    }
  }
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

// ページ操作（複製・リネーム・削除）の前に、手元の編集を保存し終えるのを待つ（#192）。
// 自動保存の待ち時間を飛ばして送り、送信中のコミットが返るまで待つ。保存できない状態
// （競合中・送信の失敗）では待たずに断り、ページ操作を止めてもらう。
const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_POLL_MS = 100;

async function settleEdits(): Promise<SettledPage> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (engine.status === 'conflict' || engine.status === 'error') {
      throw new Error('手元に保存できていない編集があります。保存し終えてから、もう一度操作してください');
    }
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    await executeEffects(engine.flush());
    renderStatus();
    if (engine.status === 'saved') return { version: engine.confirmedVersion, title: engine.currentTitle };
    await new Promise((resolve) => {
      window.setTimeout(resolve, SETTLE_POLL_MS);
    });
  }
  throw new Error('編集の保存が終わりません。保存し終えてから、もう一度操作してください');
}

answerSettleEdits(() => (editorRoot.classList.contains('editor-active') ? settleEdits() : undefined));

resolveConflictButton.addEventListener('click', () => {
  resolveConflictButton.disabled = true;
  statusMessage = undefined;
  const effects = engine.resolveConflict();
  if (engine.status === 'saved') clearConflictPanel();
  void executeEffects(effects);
  renderStatus();
});

let starting = false;

const editorActivationBlockSelector = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'details',
  'video',
  'audio',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '.telomere',
].join(', ');

function blocksEditorActivation(target: Element): boolean {
  return target.closest(editorActivationBlockSelector) !== null;
}

function beginEditing(initialTarget?: InitialEditTarget): void {
  if (starting) return;
  starting = true;
  void start(initialTarget).catch((error: unknown) => {
    console.error(error);
    starting = false;
    saveStatus.hidden = false;
    saveStatus.textContent = 'エラー';
    saveStatus.dataset.status = 'error';
  });
}

const typingTargetSelector = 'input, select, textarea, [contenteditable="true"]';

// Cosense の ctrl(cmd) + e「エディタにフォーカス」に合わせる。本文を tab order に載せないのは、
// エディタに Tab でフォーカスすると次の Tab がタブ文字の入力になり、以降の UI へ到達できなくなるため。
document.addEventListener('keydown', (event) => {
  if (event.key !== 'e' || event.altKey || event.shiftKey) return;
  if (!event.ctrlKey && !event.metaKey) return;
  // 入力欄と CodeMirror 本体の中では素通りさせる（macOS の ctrl+e は行末移動）。
  if (event.target instanceof Element && event.target.closest(typingTargetSelector) !== null) return;
  // ページ操作などの modal なダイアログを開いている間は、エディタを起動も focus もしない。
  // focus が modal の後ろへ移り、ダイアログの入力が届かなくなる。
  if (document.querySelector('dialog[open]') !== null) return;
  event.preventDefault();
  if (editorRoot.classList.contains('editor-active')) {
    view.focus();
    return;
  }
  // 行を指していないので最終行から始める。先頭行はタイトル行で、そこに caret を置くと
  // そのまま入力した利用者がページをリネームしてしまう。
  const rows = Array.from(editorRoot.querySelectorAll<HTMLElement>('.line-row'));
  const lastRow = rows.at(-1);
  beginEditing(lastRow === undefined || !lastRow.id.startsWith('L')
    ? undefined
    : { lineId: lastRow.id.slice(1), lineNumber: rows.length });
});

// 本文の行を押すと、その位置から編集を始める。ページの無いタイトル（#289）でも、タイトルの行を押して始める。
editorRoot.addEventListener('click', (event) => {
  if (starting || !(event.target instanceof Element)) return;
  const selection = window.getSelection();
  if (selection !== null && !selection.isCollapsed) return;
  if (blocksEditorActivation(event.target)) return;
  const row = event.target.closest<HTMLElement>('.line-row');
  if (row === null || row.parentElement !== editorRoot || !row.id.startsWith('L')) return;
  const rows = Array.from(editorRoot.querySelectorAll<HTMLElement>('.line-row'));
  const index = rows.indexOf(row);
  if (index < 0) return;
  const elements = lineElements(row);
  const target = elements === undefined ? undefined : clickTarget(elements, event.clientX, event.clientY);
  beginEditing({
    lineId: row.id.slice(1),
    lineNumber: index + 1,
    ...(elements === undefined || target === undefined ? {} : { click: { elements, target } }),
  });
});

// 閲覧表示の double click も、編集表示と同じ区切りの語を選ぶ（#261）。ブラウザの区切りは Cosense と
// 違う（ICU は漢字とかなの続く語や、. や : でつながる英数字をまとめる）。選んだ範囲は、編集を始める
// ときに編集表示へ持ち越す（#194）。編集表示に替わった後は CodeMirror が扱う。
editorRoot.addEventListener('dblclick', (event) => {
  if (editorRoot.classList.contains('editor-active') || !(event.target instanceof Element)) return;
  if (blocksEditorActivation(event.target)) return;
  const row = event.target.closest<HTMLElement>('.line-row');
  const elements = row === null || row.parentElement !== editorRoot ? undefined : lineElements(row);
  const target = elements === undefined ? undefined : clickTarget(elements, event.clientX, event.clientY);
  if (!(target?.node instanceof Text)) return;
  const { from, to } = wordRange(target.node.data, target.offset);
  window.getSelection()?.setBaseAndExtent(target.node, from, target.node, to);
});
