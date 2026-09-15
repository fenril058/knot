import assert from 'node:assert/strict';
import type { Storage } from '../../src/storage/types.ts';

export async function assertRenameConflictContract(
  storage: Storage,
  projectId: string,
  actorId: string,
): Promise<void> {
  for (const [pageId, title, body] of [
    ['contract-target', 'Old', 'body'],
    ['contract-taken', 'Taken', 'occupied'],
    ['contract-source', 'Source', 'see [Old]'],
  ] as const) {
    await storage.commit({
      projectId,
      pageId,
      commitId: `${pageId}-commit`,
      baseVersion: 0,
      ops: [
        { type: 'insert', id: `${pageId}-title`, after: '_head', text: title },
        { type: 'insert', id: `${pageId}-body`, after: `${pageId}-title`, text: body },
      ],
      actorId,
      now: 100,
    });
  }

  const stale = await storage.renamePage({
    projectId,
    pageId: 'contract-target',
    baseVersion: 0,
    newTitle: 'New',
    rewriteLinks: true,
    actorId,
    now: 200,
  });
  assert.equal(stale.kind, 'conflict');
  if (stale.kind === 'conflict') {
    assert.equal(stale.reason, 'version');
    assert.equal(stale.page.id, 'contract-target');
    assert.equal(stale.page.version, 1);
  }

  const occupied = await storage.renamePage({
    projectId,
    pageId: 'contract-target',
    baseVersion: 1,
    newTitle: 'Taken',
    rewriteLinks: true,
    actorId,
    now: 200,
  });
  assert.equal(occupied.kind, 'conflict');
  if (occupied.kind === 'conflict') {
    assert.equal(occupied.reason, 'title');
    assert.equal(occupied.page.id, 'contract-taken');
  }

  assert.deepEqual(await storage.renamePage({
    projectId,
    pageId: 'contract-target',
    baseVersion: 1,
    newTitle: 'New',
    rewriteLinks: false,
    actorId,
    now: 200,
  }), { kind: 'applied', version: 2, rewritten: [] });
  assert.deepEqual((await storage.getPageById('contract-source'))?.lines.map((line) => line.text), [
    'Source',
    'see [Old]',
  ]);
}
