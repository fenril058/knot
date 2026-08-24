import { type Line, type LineOp } from './ops.ts';

export type AlignStep =
  | { kind: 'keep'; line: Line }
  | { kind: 'del'; line: Line }
  | { kind: 'add'; text: string };

function findMiddleEnds(
  oldLines: Line[],
  newTexts: string[],
  prefixEnd: number,
): { oldEnd: number; newEnd: number } {
  let oldEnd = oldLines.length;
  let newEnd = newTexts.length;
  while (oldEnd > prefixEnd && newEnd > prefixEnd && oldLines[oldEnd - 1]!.text === newTexts[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const suffixLength = oldLines.length - oldEnd;
  if (suffixLength === 0) return { oldEnd, newEnd };

  const middleTexts = new Set<string>();
  for (let i = prefixEnd; i < oldEnd; i++) {
    middleTexts.add(oldLines[i]!.text);
  }
  for (let j = prefixEnd; j < newEnd; j++) {
    middleTexts.add(newTexts[j]!);
  }

  // 保持する suffix の先頭行と同じ本文が中央にあると、従来の走査は中央側を keep する場合がある。
  // 先頭行と同じ本文が中央から無くなるところまで suffix を中央へ戻す。
  let pullBackLength = 0;
  while (pullBackLength < suffixLength
    && middleTexts.has(oldLines[oldEnd + pullBackLength]!.text)) {
    pullBackLength++;
  }

  return { oldEnd: oldEnd + pullBackLength, newEnd: newEnd + pullBackLength };
}

export function alignLines(oldLines: Line[], newTexts: string[]): AlignStep[] {
  let prefixEnd = 0;
  while (prefixEnd < oldLines.length && prefixEnd < newTexts.length
    && oldLines[prefixEnd]!.text === newTexts[prefixEnd]) {
    prefixEnd++;
  }
  const { oldEnd, newEnd } = findMiddleEnds(oldLines, newTexts, prefixEnd);
  const n = oldEnd - prefixEnd;
  const m = newEnd - prefixEnd;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  // lcs は n+1 行 m+1 列で確保済み、i/j はその範囲内を動くので添字は必ず存在する。
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i]!;
    const nextRow = lcs[i + 1]!;
    const oldText = oldLines[prefixEnd + i]!.text;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = oldText === newTexts[prefixEnd + j]
        ? nextRow[j + 1]! + 1
        : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }
  const steps: AlignStep[] = oldLines.slice(0, prefixEnd).map((line) => ({ kind: 'keep', line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[prefixEnd + i]!.text === newTexts[prefixEnd + j]) {
      steps.push({ kind: 'keep', line: oldLines[prefixEnd + i]! });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      steps.push({ kind: 'add', text: newTexts[prefixEnd + j]! });
      j++;
    } else {
      steps.push({ kind: 'del', line: oldLines[prefixEnd + i]! });
      i++;
    }
  }
  for (let oldIndex = oldEnd; oldIndex < oldLines.length; oldIndex++) {
    steps.push({ kind: 'keep', line: oldLines[oldIndex]! });
  }
  return steps;
}

export function diffLines(oldLines: Line[], newTexts: string[], makeId: () => string): LineOp[] {
  const steps = alignLines(oldLines, newTexts);
  const ops: LineOp[] = [];
  let anchor = '_head';
  let k = 0;
  while (k < steps.length) {
    const s = steps[k]!;
    if (s.kind === 'keep') {
      anchor = s.line.id;
      k++;
      continue;
    }
    const dels: Line[] = [];
    const adds: string[] = [];
    while (k < steps.length && steps[k]!.kind !== 'keep') {
      const g = steps[k++]!;
      if (g.kind === 'del') dels.push(g.line);
      else if (g.kind === 'add') adds.push(g.text);
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) ops.push({ type: 'update', id: dels[p]!.id, text: adds[p]! });
    for (let p = pairs; p < dels.length; p++) ops.push({ type: 'delete', id: dels[p]!.id });
    let a = pairs > 0 ? dels[pairs - 1]!.id : anchor;
    for (let p = pairs; p < adds.length; p++) {
      const id = makeId();
      ops.push({ type: 'insert', id, after: a, text: adds[p]! });
      a = id;
    }
  }
  return ops;
}
