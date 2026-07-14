import { ulid } from '../../src/core/id.ts';
import type { Storage } from '../../src/storage/types.ts';

/** タイトル + 本文行の新規ページを 1 コミットで作り pageId を返す */
export async function seedPage(
  storage: Storage,
  projectId: string,
  title: string,
  body: string[],
  at: number,
): Promise<string> {
  const pageId = ulid(at * 1000);
  let after = '_head';
  const ops = [title, ...body].map((text) => {
    const id = ulid(at * 1000);
    const op = { type: 'insert' as const, id, after, text };
    after = id;
    return op;
  });
  await storage.commit({ projectId, pageId, commitId: ulid(at * 1000), baseVersion: 0, ops, userId: 'u', now: at });
  return pageId;
}
