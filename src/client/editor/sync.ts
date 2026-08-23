import { applyOps } from '../../core/apply.ts';
import { alignLines, diffLines } from '../../core/diff.ts';
import { ulid } from '../../core/id.ts';
import { type Line, type LineOp } from '../../core/ops.ts';
import { rebase, type RebaseConflict } from '../../core/rebase.ts';

export type Snapshot = { version: number; lines: Line[] };

export type PendingRecord = {
  // Existing recovery records predate the discriminant and must remain readable.
  kind?: undefined;
  commitId: string;
  baseVersion: number;
  ops: LineOp[];
  baseLines: Line[];
  title: string;
  pageId?: string;
  draftTexts?: string[];
  conflictContext?: {
    candidateLines: Line[];
    conflicts: RebaseConflict[];
  };
};

export type ConflictDraftRecord = {
  kind: 'conflict-draft';
  latest: Snapshot;
  title: string;
  candidateLines: Line[];
  conflicts: RebaseConflict[];
  texts: string[];
  pageId?: string;
};

export type UnsavedDraftRecord = {
  kind: 'unsaved-draft';
  confirmed: Snapshot;
  title: string;
  texts: string[];
  pageId?: string;
};

export type EditorRecord = PendingRecord | ConflictDraftRecord | UnsavedDraftRecord;

export type SyncEffect =
  | { type: 'send'; commit: { pageId?: string; commitId: string; baseVersion: number; ops: LineOp[] }; title: string }
  | { type: 'persist'; record: EditorRecord | null }
  | { type: 'replace-document'; texts: string[] }
  | { type: 'present-conflict'; conflicts: RebaseConflict[] }
  | { type: 'schedule' };

type Inflight = PendingRecord & { expectedLines: Line[] };
type SyncStatus = 'saved' | 'saving' | 'dirty' | 'conflict' | 'error';

export class SyncEngine {
  readonly #userId: string;
  readonly #makeId: () => string;
  readonly #now: () => number;
  readonly #isNew: boolean;
  #confirmed: Snapshot;
  #buffer: string[];
  #inflight: Inflight | null = null;
  #conflictCandidate: Line[] | null = null;
  #conflicts: RebaseConflict[] = [];
  #hasBufferChanged = false;
  #retryPending = false;
  #blockedDraft = false;
  #recordDirty = false;
  #status: SyncStatus = 'saved';
  #currentTitle: string;
  #pageId: string | undefined;

  constructor(init: {
    snapshot: Snapshot;
    title: string;
    userId: string;
    isNew: boolean;
    pending?: PendingRecord;
    conflictDraft?: ConflictDraftRecord;
    unsavedDraft?: UnsavedDraftRecord;
    pageId?: string;
    makeId?: () => string;
    now?: () => number;
  }) {
    this.#confirmed = { version: init.snapshot.version, lines: [...init.snapshot.lines] };
    this.#currentTitle = init.title;
    this.#pageId = init.pageId;
    this.#userId = init.userId;
    this.#isNew = init.isNew;
    this.#makeId = init.makeId ?? (() => ulid());
    this.#now = init.now ?? Date.now;
    this.#buffer = init.isNew ? [init.title] : init.snapshot.lines.map(({ text }) => text);
    // 永続化済みの送信中コミットを inflight として復元する（同じ commitId・同じ ops で再送するため）。
    if (init.pending !== undefined) {
      this.#pageId = init.pending.pageId ?? this.#pageId;
      const expectedLines = applyOps(
        init.pending.baseLines,
        init.pending.ops,
        this.#context(init.pending.baseVersion + 1),
      );
      this.#inflight = { ...init.pending, expectedLines };
      this.#conflictCandidate = init.pending.conflictContext === undefined
        ? null
        : [...init.pending.conflictContext.candidateLines];
      this.#conflicts = init.pending.conflictContext === undefined
        ? []
        : [...init.pending.conflictContext.conflicts];
      this.#buffer = init.pending.draftTexts === undefined
        ? expectedLines.map(({ text }) => text)
        : [...init.pending.draftTexts];
      this.#hasBufferChanged = true;
      this.#status = 'saving';
    }
    if (init.conflictDraft !== undefined) {
      this.#confirmed = {
        version: init.conflictDraft.latest.version,
        lines: [...init.conflictDraft.latest.lines],
      };
      this.#currentTitle = init.conflictDraft.title;
      this.#pageId = init.conflictDraft.pageId;
      this.#conflictCandidate = [...init.conflictDraft.candidateLines];
      this.#conflicts = [...init.conflictDraft.conflicts];
      this.#buffer = [...init.conflictDraft.texts];
      this.#hasBufferChanged = true;
      this.#status = 'conflict';
    }
    if (init.unsavedDraft !== undefined) {
      this.#confirmed = {
        version: init.unsavedDraft.confirmed.version,
        lines: [...init.unsavedDraft.confirmed.lines],
      };
      this.#currentTitle = init.unsavedDraft.title;
      this.#pageId = init.unsavedDraft.pageId;
      this.#buffer = [...init.unsavedDraft.texts];
      this.#hasBufferChanged = true;
      this.#blockedDraft = true;
      this.#status = 'error';
    }
  }

  get status(): SyncStatus {
    return this.#status;
  }

  get currentTitle(): string {
    return this.#currentTitle;
  }

  get pageId(): string | undefined {
    return this.#pageId;
  }

  get confirmedLines(): readonly Line[] {
    return this.#confirmed.lines;
  }

  bufferChanged(texts: string[]): SyncEffect[] {
    this.#buffer = [...texts];
    this.#hasBufferChanged = true;
    this.#blockedDraft = false;
    if (this.#status === 'conflict') {
      this.#recordDirty = true;
      return [{ type: 'schedule' }];
    }
    this.#status = 'dirty';
    if (this.#inflight === null) return [{ type: 'schedule' }];
    this.#inflight.draftTexts = [...texts];
    this.#recordDirty = true;
    return [{ type: 'schedule' }];
  }

  flush(): SyncEffect[] {
    if (this.#status === 'conflict') {
      this.#recordDirty = false;
      return [{ type: 'persist', record: this.#conflictDraft() }];
    }
    if (this.#blockedDraft) return [];
    if (this.#inflight !== null) {
      const effects: SyncEffect[] = [];
      if (this.#retryPending) {
        this.#retryPending = false;
        this.#status = 'saving';
        effects.push(this.#sendEffect(this.#inflight));
      }
      if (this.#recordDirty) {
        this.#recordDirty = false;
        effects.push({ type: 'persist', record: this.#pendingRecord() });
      }
      return effects;
    }
    if (this.#isNew && !this.#hasBufferChanged) return [];

    const ops = diffLines(this.#confirmed.lines, this.#buffer, this.#makeId);
    if (ops.length === 0) {
      this.#status = 'saved';
      return [];
    }
    return this.#startCommit(ops);
  }

  ackSuccess(version: number, pageId?: string): SyncEffect[] {
    if (this.#inflight === null) return [];

    this.#confirmed = { version, lines: this.#inflight.expectedLines };
    this.#pageId = pageId ?? this.#pageId;
    this.#inflight = null;
    this.#conflictCandidate = null;
    this.#conflicts = [];
    this.#retryPending = false;
    this.#recordDirty = false;
    this.#updateCurrentTitle();

    const effects: SyncEffect[] = [{ type: 'persist', record: null }];
    const ops = diffLines(this.#confirmed.lines, this.#buffer, this.#makeId);
    if (ops.length === 0) {
      this.#status = 'saved';
      return effects;
    }
    effects.push(...this.#startCommit(ops));
    return effects;
  }

  ackConflict(latest: { id?: string; version: number; title: string; lines: Line[] }): SyncEffect[] {
    if (this.#inflight === null) return [];

    const sentLines = this.#inflight.expectedLines;
    const localOps = diffLines(sentLines, this.#buffer, this.#makeId);
    const unadjustedLocal = localOps.length === 0
      ? sentLines
      : applyOps(sentLines, localOps, this.#context(this.#confirmed.version + 1));
    const local = alignAmbiguousDuplicateDeletionWithLatestChange(
      this.#confirmed.lines,
      unadjustedLocal,
      latest.lines,
    );
    const result = rebase(this.#confirmed.lines, local, latest.lines);

    this.#confirmed = { version: latest.version, lines: [...latest.lines] };
    this.#currentTitle = latest.title;
    this.#pageId = latest.id ?? this.#pageId;
    this.#inflight = null;
    this.#retryPending = false;
    this.#recordDirty = false;

    if (result.kind === 'conflict') {
      const candidate = applyOps(latest.lines, result.candidateOps, this.#context(latest.version + 1));
      this.#conflictCandidate = candidate;
      this.#conflicts = [...result.conflicts];
      this.#buffer = candidate.map(({ text }) => text);
      this.#status = 'conflict';
      return [
        { type: 'replace-document', texts: [...this.#buffer] },
        { type: 'present-conflict', conflicts: result.conflicts },
        { type: 'persist', record: this.#conflictDraft() },
      ];
    }

    if (result.ops.length === 0) {
      this.#conflictCandidate = null;
      this.#conflicts = [];
      this.#buffer = latest.lines.map(({ text }) => text);
      this.#hasBufferChanged = false;
      this.#status = 'saved';
      return [
        { type: 'replace-document', texts: [...this.#buffer] },
        { type: 'persist', record: null },
      ];
    }

    this.#conflictCandidate = null;
    this.#conflicts = [];
    const effects = this.#startCommit(result.ops);
    this.#buffer = this.#inflightTexts();
    return [{ type: 'replace-document', texts: [...this.#buffer] }, ...effects];
  }

  restoredEffects(): SyncEffect[] {
    if (this.#status === 'conflict') {
      return [
        { type: 'replace-document', texts: [...this.#buffer] },
        { type: 'present-conflict', conflicts: [...this.#conflicts] },
      ];
    }
    return this.#blockedDraft ? [{ type: 'replace-document', texts: [...this.#buffer] }] : [];
  }

  resolveConflict(): SyncEffect[] {
    if (this.#status !== 'conflict' || this.#conflictCandidate === null) return [];
    const resolvedLines = sameTexts(this.#confirmed.lines, this.#buffer)
      ? this.#confirmed.lines
      : sameTexts(this.#conflictCandidate, this.#buffer)
        ? this.#conflictCandidate
        : this.#resolveEditedLines();
    const result = rebase(this.#confirmed.lines, resolvedLines, this.#confirmed.lines);
    if (result.kind === 'conflict') throw new Error('resolved lines unexpectedly conflict with latest lines');
    const ops = result.ops;
    if (ops.length === 0) {
      this.#conflictCandidate = null;
      this.#conflicts = [];
      this.#hasBufferChanged = false;
      this.#status = 'saved';
      return [{ type: 'persist', record: null }];
    }
    return this.#startCommit(ops);
  }

  ackFailure(): SyncEffect[] {
    if (this.#inflight === null) return [];
    this.#retryPending = true;
    this.#status = 'error';
    return [{ type: 'schedule' }];
  }

  ackBad(): SyncEffect[] {
    if (this.#inflight === null) return [];
    this.#inflight = null;
    this.#retryPending = false;
    this.#recordDirty = false;
    if (this.#conflictCandidate !== null) {
      this.#status = 'conflict';
      return [
        { type: 'replace-document', texts: [...this.#buffer] },
        { type: 'present-conflict', conflicts: [...this.#conflicts] },
        { type: 'persist', record: this.#conflictDraft() },
      ];
    }
    this.#blockedDraft = true;
    this.#status = 'error';
    return [
      { type: 'replace-document', texts: [...this.#buffer] },
      { type: 'persist', record: this.#unsavedDraft() },
    ];
  }

  #startCommit(ops: LineOp[]): SyncEffect[] {
    const record: PendingRecord = {
      commitId: this.#makeId(),
      baseVersion: this.#confirmed.version,
      ops,
      baseLines: [...this.#confirmed.lines],
      title: this.#currentTitle,
      ...(this.#pageId === undefined ? {} : { pageId: this.#pageId }),
      ...(this.#conflictCandidate === null
        ? {}
        : {
            conflictContext: {
              candidateLines: [...this.#conflictCandidate],
              conflicts: [...this.#conflicts],
            },
          }),
    };
    this.#inflight = {
      ...record,
      expectedLines: applyOps(
        this.#confirmed.lines,
        ops,
        this.#context(this.#confirmed.version + 1),
      ),
    };
    this.#status = 'saving';
    return [this.#sendEffect(record), { type: 'persist', record }];
  }

  #sendEffect(record: PendingRecord): Extract<SyncEffect, { type: 'send' }> {
    return {
      type: 'send',
      commit: {
        ...(record.pageId === undefined ? {} : { pageId: record.pageId }),
        commitId: record.commitId,
        baseVersion: record.baseVersion,
        ops: record.ops,
      },
      title: record.title,
    };
  }

  #pendingRecord(): PendingRecord {
    if (this.#inflight === null) throw new Error('inflight commit is missing');
    return {
      commitId: this.#inflight.commitId,
      baseVersion: this.#inflight.baseVersion,
      ops: this.#inflight.ops,
      baseLines: this.#inflight.baseLines,
      title: this.#inflight.title,
      ...(this.#inflight.pageId === undefined ? {} : { pageId: this.#inflight.pageId }),
      ...(this.#inflight.draftTexts === undefined ? {} : { draftTexts: [...this.#inflight.draftTexts] }),
      ...(this.#inflight.conflictContext === undefined
        ? {}
        : {
            conflictContext: {
              candidateLines: [...this.#inflight.conflictContext.candidateLines],
              conflicts: [...this.#inflight.conflictContext.conflicts],
            },
          }),
    };
  }

  #context(version: number) {
    return { userId: this.#userId, now: this.#now(), version };
  }

  #inflightTexts(): string[] {
    return this.#inflight?.expectedLines.map(({ text }) => text) ?? [];
  }

  #updateCurrentTitle(): void {
    const title = this.#confirmed.lines[0]?.text;
    if (title !== undefined) this.#currentTitle = title;
  }

  #conflictDraft(): ConflictDraftRecord {
    if (this.#conflictCandidate === null) throw new Error('conflict candidate is missing');
    return {
      kind: 'conflict-draft',
      latest: { version: this.#confirmed.version, lines: [...this.#confirmed.lines] },
      title: this.#currentTitle,
      candidateLines: [...this.#conflictCandidate],
      conflicts: [...this.#conflicts],
      texts: [...this.#buffer],
      ...(this.#pageId === undefined ? {} : { pageId: this.#pageId }),
    };
  }

  #unsavedDraft(): UnsavedDraftRecord {
    return {
      kind: 'unsaved-draft',
      confirmed: { version: this.#confirmed.version, lines: [...this.#confirmed.lines] },
      title: this.#currentTitle,
      texts: [...this.#buffer],
      ...(this.#pageId === undefined ? {} : { pageId: this.#pageId }),
    };
  }

  #resolveEditedLines(): Line[] {
    if (this.#conflictCandidate === null) throw new Error('conflict candidate is missing');
    const edits = diffLines(this.#confirmed.lines, this.#buffer, this.#makeId);
    const generatedLines = applyOps(this.#confirmed.lines, edits, this.#context(this.#confirmed.version + 1));
    const candidateIdentities = alignedIdentities(this.#conflictCandidate, this.#buffer);
    const latestIds = new Set(this.#confirmed.lines.map((line) => line.id));
    const usedIds = new Set<string>();
    return generatedLines.map((generated, index) => {
      const candidate = candidateIdentities[index];
      const reusableCandidate = candidate !== undefined && !latestIds.has(candidate.id) && !usedIds.has(candidate.id)
        ? candidate
        : undefined;
      const chosen = latestIds.has(generated.id) || reusableCandidate === undefined
        ? generated
        : { ...generated, id: reusableCandidate.id, created: reusableCandidate.created };
      usedIds.add(chosen.id);
      return chosen;
    });
  }
}

function sameTexts(lines: readonly Line[], texts: readonly string[]): boolean {
  return lines.length === texts.length && lines.every((line, index) => line.text === texts[index]);
}

// The text editor cannot identify which one of several equal lines was deleted.
// Align an ambiguous deletion with a duplicate changed in the latest snapshot so rebase reports
// a conservative delete/update conflict instead of silently accepting both edits.
function alignAmbiguousDuplicateDeletionWithLatestChange(base: Line[], local: Line[], latest: Line[]): Line[] {
  const localById = new Map(local.map((line) => [line.id, line]));
  const latestById = new Map(latest.map((line) => [line.id, line]));
  const byText = new Map<string, Line[]>();
  for (const line of base) {
    const group = byText.get(line.text) ?? [];
    group.push(line);
    byText.set(line.text, group);
  }
  const replacements = new Map<string, Line>();
  for (const duplicateLines of byText.values()) {
    if (duplicateLines.length < 2) continue;
    const removed = duplicateLines.filter((line) => !localById.has(line.id));
    const latestChangedButLocallyUnchanged = duplicateLines.filter((line) => {
      const localLine = localById.get(line.id);
      const latestLine = latestById.get(line.id);
      return localLine?.text === line.text && latestLine !== undefined && latestLine.text !== line.text;
    });
    const pairs = Math.min(removed.length, latestChangedButLocallyUnchanged.length);
    for (let index = 0; index < pairs; index++) {
      replacements.set(latestChangedButLocallyUnchanged[index]!.id, removed[index]!);
    }
  }
  return replacements.size === 0
    ? local
    : local.map((line) => replacements.get(line.id) ?? line);
}

function alignedIdentities(lines: Line[], texts: string[]): Array<Line | undefined> {
  const identities: Array<Line | undefined> = [];
  const steps = alignLines(lines, texts);
  let index = 0;
  while (index < steps.length) {
    const step = steps[index]!;
    if (step.kind === 'keep') {
      identities.push(step.line);
      index++;
      continue;
    }
    const deleted: Line[] = [];
    let added = 0;
    while (index < steps.length && steps[index]!.kind !== 'keep') {
      const changed = steps[index++]!;
      if (changed.kind === 'del') deleted.push(changed.line);
      else if (changed.kind === 'add') added++;
    }
    for (let offset = 0; offset < added; offset++) identities.push(deleted[offset]);
  }
  return identities;
}

export function lineMeta(
  confirmed: readonly Line[],
  bufferTexts: readonly string[],
  self: { userId: string; now: number },
): { updated: number; userId: string; updatedVersion: number }[] {
  return alignLines([...confirmed], [...bufferTexts]).flatMap((step) => {
    if (step.kind === 'del') return [];
    if (step.kind === 'keep') {
      return [{
        updated: step.line.updated,
        userId: step.line.userId,
        updatedVersion: step.line.updatedVersion,
      }];
    }
    return [{
      updated: self.now,
      userId: self.userId,
      updatedVersion: Number.MAX_SAFE_INTEGER,
    }];
  });
}

export function serializeEditorRecord(record: EditorRecord): string {
  return JSON.stringify(record);
}

export function parseEditorRecord(raw: string): EditorRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isPendingRecord(value) || isConflictDraftRecord(value) || isUnsavedDraftRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLine(value: unknown): value is Line {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.text === 'string'
    && typeof value.created === 'number'
    && typeof value.updated === 'number'
    && typeof value.updatedVersion === 'number'
    && typeof value.userId === 'string';
}

function isLineOp(value: unknown): value is LineOp {
  if (!isRecord(value) || typeof value.type !== 'string' || typeof value.id !== 'string') return false;
  if (value.type === 'delete') return true;
  if (value.type === 'update') return typeof value.text === 'string';
  return value.type === 'insert' && typeof value.after === 'string' && typeof value.text === 'string';
}

function isPendingRecord(value: unknown): value is PendingRecord {
  return isRecord(value)
    && value.kind === undefined
    && typeof value.commitId === 'string'
    && typeof value.baseVersion === 'number'
    && Array.isArray(value.ops)
    && value.ops.every(isLineOp)
    && Array.isArray(value.baseLines)
    && value.baseLines.every(isLine)
    && typeof value.title === 'string'
    && (value.pageId === undefined || typeof value.pageId === 'string')
    && (value.draftTexts === undefined || (
      Array.isArray(value.draftTexts) && value.draftTexts.every((text) => typeof text === 'string')
    ))
    && (value.conflictContext === undefined || isConflictContext(value.conflictContext));
}

function isSnapshot(value: unknown): value is Snapshot {
  return isRecord(value)
    && typeof value.version === 'number'
    && Array.isArray(value.lines)
    && value.lines.every(isLine);
}

function isLineState(value: unknown): boolean {
  return isRecord(value)
    && (value.kind === 'deleted' || (value.kind === 'present' && typeof value.text === 'string'));
}

function isConflict(value: unknown): value is RebaseConflict {
  return isRecord(value)
    && typeof value.lineId === 'string'
    && isLineState(value.base)
    && isLineState(value.local)
    && isLineState(value.latest);
}

function isConflictContext(value: unknown): boolean {
  return isRecord(value)
    && Array.isArray(value.candidateLines)
    && value.candidateLines.every(isLine)
    && Array.isArray(value.conflicts)
    && value.conflicts.every(isConflict);
}

function isConflictDraftRecord(value: unknown): value is ConflictDraftRecord {
  return isRecord(value)
    && value.kind === 'conflict-draft'
    && isSnapshot(value.latest)
    && typeof value.title === 'string'
    && Array.isArray(value.candidateLines)
    && value.candidateLines.every(isLine)
    && Array.isArray(value.conflicts)
    && value.conflicts.every(isConflict)
    && Array.isArray(value.texts)
    && value.texts.every((text) => typeof text === 'string')
    && (value.pageId === undefined || typeof value.pageId === 'string');
}

function isUnsavedDraftRecord(value: unknown): value is UnsavedDraftRecord {
  return isRecord(value)
    && value.kind === 'unsaved-draft'
    && isSnapshot(value.confirmed)
    && typeof value.title === 'string'
    && Array.isArray(value.texts)
    && value.texts.every((text) => typeof text === 'string')
    && (value.pageId === undefined || typeof value.pageId === 'string');
}
