import { type Line, type LineOp } from './ops.ts';

export function rebase(base: Line[], local: Line[], latest: Line[]): LineOp[] {
  const baseById = new Map(base.map((l) => [l.id, l]));
  const localIds = new Set(local.map((l) => l.id));
  const latestIds = new Set(latest.map((l) => l.id));
  const ops: LineOp[] = [];

  for (const b of base) {
    if (!localIds.has(b.id) && latestIds.has(b.id)) {
      ops.push({ type: 'delete', id: b.id });
    }
  }

  let anchor = '_head';
  for (const l of local) {
    const b = baseById.get(l.id);
    if (b) {
      if (latestIds.has(l.id)) {
        if (l.text !== b.text) ops.push({ type: 'update', id: l.id, text: l.text });
        anchor = l.id;
      } else if (l.text !== b.text) {
        ops.push({ type: 'insert', id: l.id, after: anchor, text: l.text });
        anchor = l.id;
      }
    } else {
      ops.push({ type: 'insert', id: l.id, after: anchor, text: l.text });
      anchor = l.id;
    }
  }
  return ops;
}
