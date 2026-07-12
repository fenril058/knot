import { createHash } from 'node:crypto';
import type { LineOp } from '../core/ops.ts';

/**
 * 再送の同一性判定に使う正規化ハッシュ。
 * 受信 JSON のキー順に依存しないよう、op を固定のフィールド順に詰め替えてから直列化する。
 */
export function opsHash(pageId: string, baseVersion: number, ops: LineOp[]): string {
  const canonical = ops.map((op) => {
    if (op.type === 'insert') return { type: op.type, id: op.id, after: op.after, text: op.text };
    if (op.type === 'update') return { type: op.type, id: op.id, text: op.text };
    return { type: op.type, id: op.id };
  });
  return createHash('sha256')
    .update(JSON.stringify({ pageId, baseVersion, ops: canonical }))
    .digest('hex');
}
