import { type Line, type LineOp } from './ops.ts';

type Step =
  | { kind: 'keep'; line: Line }
  | { kind: 'del'; line: Line }
  | { kind: 'add'; text: string };

function editScript(oldLines: Line[], newTexts: string[]): Step[] {
  const n = oldLines.length;
  const m = newTexts.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i].text === newTexts[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && oldLines[i].text === newTexts[j]) {
      steps.push({ kind: 'keep', line: oldLines[i] });
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      steps.push({ kind: 'add', text: newTexts[j] });
      j++;
    } else {
      steps.push({ kind: 'del', line: oldLines[i] });
      i++;
    }
  }
  return steps;
}

export function diffLines(oldLines: Line[], newTexts: string[], makeId: () => string): LineOp[] {
  const steps = editScript(oldLines, newTexts);
  const ops: LineOp[] = [];
  let anchor = '_head';
  let k = 0;
  while (k < steps.length) {
    const s = steps[k];
    if (s.kind === 'keep') {
      anchor = s.line.id;
      k++;
      continue;
    }
    const dels: Line[] = [];
    const adds: string[] = [];
    while (k < steps.length && steps[k].kind !== 'keep') {
      const g = steps[k++];
      if (g.kind === 'del') dels.push(g.line);
      else if (g.kind === 'add') adds.push(g.text);
    }
    const pairs = Math.min(dels.length, adds.length);
    for (let p = 0; p < pairs; p++) ops.push({ type: 'update', id: dels[p].id, text: adds[p] });
    for (let p = pairs; p < dels.length; p++) ops.push({ type: 'delete', id: dels[p].id });
    let a = pairs > 0 ? dels[pairs - 1].id : anchor;
    for (let p = pairs; p < adds.length; p++) {
      const id = makeId();
      ops.push({ type: 'insert', id, after: a, text: adds[p] });
      a = id;
    }
    if (pairs > 0) anchor = dels[pairs - 1].id;
  }
  return ops;
}
