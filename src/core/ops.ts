export type Line = {
  id: string;
  text: string;
  created: number;
  updated: number;
  updatedVersion: number;
  userId: string;
};

export type LineOp =
  | { type: 'insert'; id: string; after: string; text: string }
  | { type: 'update'; id: string; text: string }
  | { type: 'delete'; id: string };

export class OpsError extends Error {}

export function validateOps(lines: Line[], ops: LineOp[]): void {
  if (ops.length === 0) throw new OpsError('ops must not be empty');
  const ids = new Set(lines.map((l) => l.id));
  for (const op of ops) {
    if (op.type === 'insert') {
      if (ids.has(op.id)) throw new OpsError(`duplicate line id: ${op.id}`);
      if (op.after !== '_head' && !ids.has(op.after)) {
        throw new OpsError(`missing anchor line: ${op.after}`);
      }
      ids.add(op.id);
    } else {
      if (!ids.has(op.id)) throw new OpsError(`missing line: ${op.id}`);
      if (op.type === 'delete') ids.delete(op.id);
    }
  }
}
