import { type Line, type LineOp } from './ops.ts';

export type RebaseLineState =
  | { kind: 'present'; text: string }
  | { kind: 'deleted' };

export type RebaseConflict = {
  lineId: string;
  base: RebaseLineState;
  local: RebaseLineState;
  latest: RebaseLineState;
};

export type RebaseResult =
  | { kind: 'rebased'; ops: LineOp[] }
  | { kind: 'conflict'; conflicts: RebaseConflict[]; candidateOps: LineOp[] };

function toLineState(line: Line | undefined): RebaseLineState {
  return line === undefined ? { kind: 'deleted' } : { kind: 'present', text: line.text };
}

export function rebase(base: Line[], local: Line[], latest: Line[]): RebaseResult {
  const baseById = new Map(base.map((line) => [line.id, line]));
  const localById = new Map(local.map((line) => [line.id, line]));
  const latestById = new Map(latest.map((line) => [line.id, line]));
  const conflicts: RebaseConflict[] = [];
  const deletes: LineOp[] = [];
  const updates: LineOp[] = [];
  const deletedIds = new Set<string>();
  const insertionIds = new Set<string>();

  for (const baseLine of base) {
    const localLine = localById.get(baseLine.id);
    const latestLine = latestById.get(baseLine.id);
    const localChanged = localLine !== undefined && localLine.text !== baseLine.text;
    const latestChanged = latestLine !== undefined && latestLine.text !== baseLine.text;

    if (localLine === undefined && latestLine !== undefined) {
      if (latestChanged) {
        conflicts.push({
          lineId: baseLine.id,
          base: { kind: 'present', text: baseLine.text },
          local: { kind: 'deleted' },
          latest: toLineState(latestLine),
        });
      }
      deletes.push({ type: 'delete', id: baseLine.id });
      deletedIds.add(baseLine.id);
      continue;
    }

    if (localLine !== undefined && latestLine === undefined) {
      if (localChanged) {
        conflicts.push({
          lineId: baseLine.id,
          base: { kind: 'present', text: baseLine.text },
          local: toLineState(localLine),
          latest: { kind: 'deleted' },
        });
        insertionIds.add(baseLine.id);
      }
      continue;
    }

    if (localLine === undefined || latestLine === undefined || !localChanged) continue;
    if (latestChanged && localLine.text !== latestLine.text) {
      conflicts.push({
        lineId: baseLine.id,
        base: { kind: 'present', text: baseLine.text },
        local: toLineState(localLine),
        latest: toLineState(latestLine),
      });
    }
    if (localLine.text !== latestLine.text) {
      updates.push({ type: 'update', id: baseLine.id, text: localLine.text });
    }
  }

  for (const localLine of local) {
    if (baseById.has(localLine.id)) continue;
    const latestLine = latestById.get(localLine.id);
    if (latestLine === undefined) {
      insertionIds.add(localLine.id);
      continue;
    }
    if (latestLine.text !== localLine.text) {
      conflicts.push({
        lineId: localLine.id,
        base: { kind: 'deleted' },
        local: toLineState(localLine),
        latest: toLineState(latestLine),
      });
      updates.push({ type: 'update', id: localLine.id, text: localLine.text });
    }
  }

  const survivingLatest = latest.filter((line) => !deletedIds.has(line.id));
  const survivingLatestIds = new Set(survivingLatest.map((line) => line.id));
  const survivingLatestIndexById = new Map(survivingLatest.map((line, index) => [line.id, index]));
  const nextSurvivingId: Array<string | undefined> = Array.from({ length: local.length });
  let nextId: string | undefined;
  for (let index = local.length - 1; index >= 0; index--) {
    nextSurvivingId[index] = nextId;
    const localLine = local[index]!;
    if (survivingLatestIds.has(localLine.id)) nextId = localLine.id;
  }
  const inserts: LineOp[] = [];
  let previousInsertedId: string | undefined;

  for (let index = 0; index < local.length; index++) {
    const localLine = local[index]!;
    if (!insertionIds.has(localLine.id)) {
      if (survivingLatestIds.has(localLine.id)) previousInsertedId = undefined;
      continue;
    }

    let anchor = previousInsertedId;
    if (anchor === undefined) {
      const followingId = nextSurvivingId[index];
      const nextIndex = followingId === undefined
        ? survivingLatest.length
        : survivingLatestIndexById.get(followingId)!;
      anchor = nextIndex === 0 ? '_head' : survivingLatest[nextIndex - 1]!.id;
    }
    inserts.push({ type: 'insert', id: localLine.id, after: anchor, text: localLine.text });
    previousInsertedId = localLine.id;
  }

  const candidateOps = [...deletes, ...updates, ...inserts];
  return conflicts.length === 0
    ? { kind: 'rebased', ops: candidateOps }
    : { kind: 'conflict', conflicts, candidateOps };
}
