import { type Line, type LineOp, validateOps } from './ops.ts';

export type ApplyContext = { userId: string; now: number; version: number };

export function applyOps(lines: Line[], ops: LineOp[], ctx: ApplyContext): Line[] {
  validateOps(lines, ops);
  const result = [...lines];
  for (const op of ops) {
    if (op.type === 'insert') {
      const at = op.after === '_head' ? 0 : result.findIndex((l) => l.id === op.after) + 1;
      result.splice(at, 0, {
        id: op.id,
        text: op.text,
        created: ctx.now,
        updated: ctx.now,
        updatedVersion: ctx.version,
        userId: ctx.userId,
      });
    } else if (op.type === 'update') {
      // validateOps が update 対象の id の存在を保証するので findIndex は -1 にならない。
      const i = result.findIndex((l) => l.id === op.id);
      result[i] = {
        ...result[i]!,
        text: op.text,
        updated: ctx.now,
        updatedVersion: ctx.version,
        userId: ctx.userId,
      };
    } else {
      result.splice(result.findIndex((l) => l.id === op.id), 1);
    }
  }
  return result;
}
