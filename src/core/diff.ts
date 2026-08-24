import { type Line, type LineOp } from './ops.ts';

export type AlignStep =
  | { kind: 'keep'; line: Line }
  | { kind: 'del'; line: Line }
  | { kind: 'add'; text: string };

function findSuffixStarts(oldLines: Line[], newTexts: string[], prefixEnd: number): [number, number] {
  let oldEnd = oldLines.length;
  let newEnd = newTexts.length;
  while (oldEnd > prefixEnd && newEnd > prefixEnd && oldLines[oldEnd - 1]!.text === newTexts[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const suffixLength = oldLines.length - oldEnd;
  if (suffixLength === 0) return [oldEnd, newEnd];

  const lastSuffixOffsets = new Map<string, number>();
  for (let offset = 0; offset < suffixLength; offset++) {
    lastSuffixOffsets.set(oldLines[oldEnd + offset]!.text, offset);
  }

  let middleSuffixLength = 0;
  for (let i = prefixEnd; i < oldEnd; i++) {
    const offset = lastSuffixOffsets.get(oldLines[i]!.text);
    if (offset !== undefined) middleSuffixLength = Math.max(middleSuffixLength, offset + 1);
  }
  for (let j = prefixEnd; j < newEnd; j++) {
    const offset = lastSuffixOffsets.get(newTexts[j]!);
    if (offset !== undefined) middleSuffixLength = Math.max(middleSuffixLength, offset + 1);
  }

  // 中央と suffix に同じ本文があると、従来の tie-breaking は中央側の行を keep する場合がある。
  // 境界をまたぐ同文行をすべて中央へ戻し、残りの suffix だけを先に確定する。
  for (let offset = 0; offset < middleSuffixLength; offset++) {
    const lastOffset = lastSuffixOffsets.get(oldLines[oldEnd + offset]!.text)!;
    middleSuffixLength = Math.max(middleSuffixLength, lastOffset + 1);
  }

  return [oldEnd + middleSuffixLength, newEnd + middleSuffixLength];
}

export function alignLines(oldLines: Line[], newTexts: string[]): AlignStep[] {
  let prefixEnd = 0;
  while (prefixEnd < oldLines.length && prefixEnd < newTexts.length
    && oldLines[prefixEnd]!.text === newTexts[prefixEnd]) {
    prefixEnd++;
  }
  const [oldEnd, newEnd] = findSuffixStarts(oldLines, newTexts, prefixEnd);
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
