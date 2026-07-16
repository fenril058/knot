import { applyOps } from '../../core/apply.ts';
import { alignLines, diffLines } from '../../core/diff.ts';
import { ulid } from '../../core/id.ts';
import { type Line, type LineOp } from '../../core/ops.ts';
import { rebase } from '../../core/rebase.ts';

export type Snapshot = { version: number; lines: Line[] };

export type PendingRecord = {
  commitId: string;
  baseVersion: number;
  ops: LineOp[];
  baseLines: Line[];
  title: string;
};

export type SyncEffect =
  | { type: 'send'; commit: { commitId: string; baseVersion: number; ops: LineOp[] }; title: string }
  | { type: 'persist'; record: PendingRecord | null }
  | { type: 'schedule' };

type Inflight = PendingRecord & { expectedLines: Line[] };
type SyncStatus = 'saved' | 'saving' | 'dirty' | 'error';

export class SyncEngine {
  readonly #userId: string;
  readonly #makeId: () => string;
  readonly #now: () => number;
  readonly #isNew: boolean;
  #confirmed: Snapshot;
  #buffer: string[];
  #inflight: Inflight | null = null;
  #hasBufferChanged = false;
  #retryPending = false;
  #status: SyncStatus = 'saved';
  #currentTitle: string;

  constructor(init: {
    snapshot: Snapshot;
    title: string;
    userId: string;
    isNew: boolean;
    pending?: PendingRecord;
    makeId?: () => string;
    now?: () => number;
  }) {
    this.#confirmed = { version: init.snapshot.version, lines: [...init.snapshot.lines] };
    this.#currentTitle = init.title;
    this.#userId = init.userId;
    this.#isNew = init.isNew;
    this.#makeId = init.makeId ?? (() => ulid());
    this.#now = init.now ?? Date.now;
    this.#buffer = init.isNew ? [init.title] : init.snapshot.lines.map(({ text }) => text);
    // 永続化済みの送信中コミットを inflight として復元する（同じ commitId・同じ ops で再送するため）。
    if (init.pending !== undefined) {
      const expectedLines = applyOps(
        init.pending.baseLines,
        init.pending.ops,
        this.#context(init.pending.baseVersion + 1),
      );
      this.#inflight = { ...init.pending, expectedLines };
      this.#buffer = expectedLines.map(({ text }) => text);
      this.#hasBufferChanged = true;
      this.#status = 'saving';
    }
  }

  get status(): SyncStatus {
    return this.#status;
  }

  get currentTitle(): string {
    return this.#currentTitle;
  }

  get confirmedLines(): readonly Line[] {
    return this.#confirmed.lines;
  }

  bufferChanged(texts: string[]): SyncEffect[] {
    this.#buffer = [...texts];
    this.#hasBufferChanged = true;
    this.#status = 'dirty';
    return this.#inflight === null ? [{ type: 'schedule' }] : [];
  }

  flush(): SyncEffect[] {
    if (this.#inflight !== null) {
      if (!this.#retryPending) return [];
      this.#retryPending = false;
      this.#status = 'saving';
      return [this.#sendEffect(this.#inflight)];
    }
    if (this.#isNew && !this.#hasBufferChanged) return [];

    const ops = diffLines(this.#confirmed.lines, this.#buffer, this.#makeId);
    if (ops.length === 0) {
      this.#status = 'saved';
      return [];
    }
    return this.#startCommit(ops);
  }

  ackSuccess(version: number): SyncEffect[] {
    if (this.#inflight === null) return [];

    this.#confirmed = { version, lines: this.#inflight.expectedLines };
    this.#inflight = null;
    this.#retryPending = false;
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

  ackConflict(latest: { version: number; title: string; lines: Line[] }): SyncEffect[] {
    if (this.#inflight === null) return [];

    const localOps = diffLines(this.#confirmed.lines, this.#buffer, this.#makeId);
    const local = localOps.length === 0
      ? this.#confirmed.lines
      : applyOps(this.#confirmed.lines, localOps, this.#context(this.#confirmed.version + 1));
    const rebasedOps = rebase(this.#confirmed.lines, local, latest.lines);

    this.#confirmed = { version: latest.version, lines: [...latest.lines] };
    this.#currentTitle = latest.title;
    this.#inflight = null;
    this.#retryPending = false;

    if (rebasedOps.length === 0) {
      this.#buffer = latest.lines.map(({ text }) => text);
      this.#status = 'saved';
      return [{ type: 'persist', record: null }];
    }

    const effects = this.#startCommit(rebasedOps);
    this.#buffer = this.#inflightTexts();
    return effects;
  }

  ackFailure(): SyncEffect[] {
    if (this.#inflight === null) return [];
    this.#retryPending = true;
    this.#status = 'error';
    return [{ type: 'schedule' }];
  }

  #startCommit(ops: LineOp[]): SyncEffect[] {
    const record: PendingRecord = {
      commitId: this.#makeId(),
      baseVersion: this.#confirmed.version,
      ops,
      baseLines: [...this.#confirmed.lines],
      title: this.#currentTitle,
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
        commitId: record.commitId,
        baseVersion: record.baseVersion,
        ops: record.ops,
      },
      title: record.title,
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

export function serializePendingRecord(record: PendingRecord): string {
  return JSON.stringify(record);
}

export function parsePendingRecord(raw: string): PendingRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isPendingRecord(value) ? value : null;
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
    && typeof value.commitId === 'string'
    && typeof value.baseVersion === 'number'
    && Array.isArray(value.ops)
    && value.ops.every(isLineOp)
    && Array.isArray(value.baseLines)
    && value.baseLines.every(isLine)
    && typeof value.title === 'string';
}
