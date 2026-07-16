import type { LineOp } from '../../core/ops.ts';

export function duplicateOps(
  lines: readonly { text: string }[],
  newTitle: string,
  makeId: () => string,
): LineOp[] {
  const ops: LineOp[] = [];
  let after = '_head';
  for (const text of [newTitle, ...lines.slice(1).map((line) => line.text)]) {
    const id = makeId();
    ops.push({ type: 'insert', id, after, text });
    after = id;
  }
  return ops;
}
