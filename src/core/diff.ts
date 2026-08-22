import { type Line, type LineOp } from './ops.ts';

export type AlignStep =
  | { kind: 'keep'; line: Line }
  | { kind: 'del'; line: Line }
  | { kind: 'add'; text: string };

export function alignLines(oldLines: Line[], newTexts: string[]): AlignStep[] {
  const steps: AlignStep[] = [];
  let start = 0;
  const commonLength = Math.min(oldLines.length, newTexts.length);
  while (start < commonLength && oldLines[start]!.text === newTexts[start]) {
    steps.push({ kind: 'keep', line: oldLines[start]! });
    start++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newTexts.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1]!.text === newTexts[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  steps.push(...alignChangedRange(oldLines, newTexts, start, oldEnd, newEnd));
  for (let index = oldEnd; index < oldLines.length; index++) {
    steps.push({ kind: 'keep', line: oldLines[index]! });
  }
  return steps;
}

const KEEP = 1;
const SUBSTITUTE = 2;
const DELETE = 3;
const ADD = 4;

function alignChangedRange(
  oldLines: Line[],
  newTexts: string[],
  start: number,
  oldEnd: number,
  newEnd: number,
): AlignStep[] {
  const n = oldEnd - start;
  const m = newEnd - start;
  const width = m + 1;
  const choices = new Uint8Array((n + 1) * width);
  let nextCosts = new Uint32Array(width);
  let nextKeeps = new Uint32Array(width);
  for (let j = m - 1; j >= 0; j--) {
    nextCosts[j] = nextCosts[j + 1]! + 1;
    choices[n * width + j] = ADD;
  }
  for (let i = n - 1; i >= 0; i--) {
    const costs = new Uint32Array(width);
    const keeps = new Uint32Array(width);
    costs[m] = nextCosts[m]! + 1;
    choices[i * width + m] = DELETE;
    for (let j = m - 1; j >= 0; j--) {
      const choiceIndex = i * width + j;
      if (oldLines[start + i]!.text === newTexts[start + j]) {
        costs[j] = nextCosts[j + 1]!;
        keeps[j] = nextKeeps[j + 1]! + 1;
        choices[choiceIndex] = KEEP;
        continue;
      }
      let bestChoice = SUBSTITUTE;
      let bestCost = nextCosts[j + 1]! + 1;
      let bestKeeps = nextKeeps[j + 1]!;
      const deleteCost = nextCosts[j]! + 1;
      const deleteKeeps = nextKeeps[j]!;
      if (deleteCost < bestCost || (deleteCost === bestCost && deleteKeeps > bestKeeps)) {
        bestChoice = DELETE;
        bestCost = deleteCost;
        bestKeeps = deleteKeeps;
      }
      const addCost = costs[j + 1]! + 1;
      const addKeeps = keeps[j + 1]!;
      if (addCost < bestCost || (addCost === bestCost && addKeeps > bestKeeps)) {
        bestChoice = ADD;
        bestCost = addCost;
        bestKeeps = addKeeps;
      }
      costs[j] = bestCost;
      keeps[j] = bestKeeps;
      choices[choiceIndex] = bestChoice;
    }
    nextCosts = costs;
    nextKeeps = keeps;
  }
  const steps: AlignStep[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const choice = choices[i * width + j];
    if (choice === KEEP) {
      steps.push({ kind: 'keep', line: oldLines[start + i]! });
      i++;
      j++;
    } else if (choice === SUBSTITUTE) {
      steps.push({ kind: 'del', line: oldLines[start + i]! }, { kind: 'add', text: newTexts[start + j]! });
      i++;
      j++;
    } else if (choice === ADD) {
      steps.push({ kind: 'add', text: newTexts[start + j]! });
      j++;
    } else if (choice === DELETE) {
      steps.push({ kind: 'del', line: oldLines[start + i]! });
      i++;
    } else {
      throw new Error('line alignment choice is missing');
    }
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
