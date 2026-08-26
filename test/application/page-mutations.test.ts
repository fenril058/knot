import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitPage,
  derivePageData,
  importPage,
  renamePage,
  type AppliedCommit,
  type PageMutation,
  type PageRepository,
  type PageTransaction,
} from '../../src/application/pageMutations.ts';
import type { PageSnapshot } from '../../src/storage/types.ts';

const now = 1_700_000_000;

class FakePageRepository implements PageRepository {
  pages = new Map<string, PageSnapshot>();
  commits = new Map<string, AppliedCommit>();
  actors = new Set<string>();
  finalizedClaims: string[] = [];
  mutations: PageMutation[] = [];
  failOnSave: number | null = null;
  finalizeError: Error | null = null;

  transaction<T>(operation: (tx: PageTransaction) => T): T {
    const snapshot = {
      pages: structuredClone(this.pages),
      commits: structuredClone(this.commits),
      actors: structuredClone(this.actors),
      finalizedClaims: [...this.finalizedClaims],
      mutations: structuredClone(this.mutations),
    };
    let saves = 0;
    const tx: PageTransaction = {
      ensureActor: (actorId) => {
        this.actors.add(actorId);
      },
      getAppliedCommit: (commitId) => this.commits.get(commitId) ?? null,
      getPageById: (pageId) => this.pages.get(pageId) ?? null,
      getPageByTitle: (projectId, normalizedTitle) =>
        [...this.pages.values()].find((page) =>
          page.projectId === projectId && page.titleLc === normalizedTitle && !page.deleted) ?? null,
      getCurrentTitleStarted: (_pageId, fallback) => fallback,
      pageIdExists: (pageId) => this.pages.has(pageId),
      listPagesLinkingTo: (projectId, targetTitleLc, excludePageId) =>
        [...this.pages.values()].filter((page) =>
          page.projectId === projectId
          && page.id !== excludePageId
          && !page.deleted
          && derivePageData(page.lines, false).links.some((link) => link.titleLc === targetTitleLc)),
      savePageMutation: (mutation) => {
        saves++;
        if (saves === this.failOnSave) throw new Error('persistence failed');
        this.pages.set(mutation.after.id, structuredClone(mutation.after));
        this.commits.set(mutation.commit.id, {
          version: mutation.commit.version,
          opsHash: mutation.commit.opsHash,
        });
        this.mutations.push(structuredClone(mutation));
      },
      finalizeAttachmentClaims: (owner) => {
        if (this.finalizeError !== null) throw this.finalizeError;
        this.finalizedClaims.push(owner);
      },
    };
    try {
      return operation(tx);
    } catch (error) {
      this.pages = snapshot.pages;
      this.commits = snapshot.commits;
      this.actors = snapshot.actors;
      this.finalizedClaims = snapshot.finalizedClaims;
      this.mutations = snapshot.mutations;
      throw error;
    }
  }
}

function createPage(repository: FakePageRepository, pageId: string, title: string, body: string[]): void {
  const ops = [title, ...body].map((text, index) => ({
    type: 'insert' as const,
    id: `${pageId}-line-${index}`,
    after: index === 0 ? '_head' : `${pageId}-line-${index - 1}`,
    text,
  }));
  const result = commitPage(repository, {
    projectId: 'project',
    pageId,
    commitId: `${pageId}-commit`,
    baseVersion: 0,
    ops,
    actorId: 'actor',
    now,
  });
  assert.equal(result.kind, 'applied');
}

void test('commit の適用と version conflict を SQLite なしで判定する', () => {
  const repository = new FakePageRepository();
  createPage(repository, 'page', 'Page', ['[Target]']);

  const page = repository.pages.get('page');
  assert.equal(page?.version, 1);
  assert.equal(repository.mutations[0]?.derived.links[0]?.titleLc, 'target');
  assert.deepEqual(repository.actors, new Set(['actor']));

  const conflict = commitPage(repository, {
    projectId: 'project',
    pageId: 'page',
    commitId: 'stale',
    baseVersion: 0,
    ops: [{ type: 'update', id: 'page-line-1', text: 'stale' }],
    actorId: 'actor',
    now: now + 1,
  });
  assert.equal(conflict.kind, 'conflict');
  assert.equal(conflict.kind === 'conflict' ? conflict.reason : '', 'version');
  assert.equal(repository.pages.get('page')?.lines[1]?.text, '[Target]');
});

void test('rename と逆リンク書き換えを一つの application transaction で適用する', () => {
  const repository = new FakePageRepository();
  createPage(repository, 'target', 'Old', ['body']);
  createPage(repository, 'source', 'Source', ['[Old]']);

  const result = renamePage(repository, {
    projectId: 'project',
    pageId: 'target',
    baseVersion: 1,
    newTitle: 'New',
    rewriteLinks: true,
    actorId: 'actor',
    now: now + 1,
  });

  assert.equal(result.kind, 'applied');
  assert.equal(repository.pages.get('target')?.title, 'New');
  assert.equal(repository.pages.get('source')?.lines[1]?.text, '[New]');
  assert.equal(repository.pages.get('source')?.version, 2);
});

void test('逆リンク commit の失敗時は rename 全体を rollback する', () => {
  const repository = new FakePageRepository();
  createPage(repository, 'target', 'Old', ['body']);
  createPage(repository, 'source', 'Source', ['[Old]']);
  repository.failOnSave = 2;

  assert.throws(() => renamePage(repository, {
    projectId: 'project',
    pageId: 'target',
    baseVersion: 1,
    newTitle: 'New',
    rewriteLinks: true,
    actorId: 'actor',
    now: now + 1,
  }), /persistence failed/);

  assert.equal(repository.pages.get('target')?.title, 'Old');
  assert.equal(repository.pages.get('source')?.lines[1]?.text, '[Old]');
  assert.equal(repository.pages.get('target')?.version, 1);
  assert.equal(repository.pages.get('source')?.version, 1);
});

void test('import の skip と overwrite、Actor、commit、claim finalize を SQLite なしで扱う', () => {
  const repository = new FakePageRepository();
  const first = importPage(repository, {
    projectId: 'project',
    page: { id: 'imported-page', title: 'Page', created: 10, updated: 20 },
    lines: [{ id: 'line-1', text: 'Page', created: 10, updated: 20, actorId: 'imported-actor' }],
    actorId: 'importer',
    now,
    onConflict: 'skip',
  });
  assert.deepEqual(first, { kind: 'created', pageId: 'imported-page' });

  const skipped = importPage(repository, {
    projectId: 'project',
    page: { id: 'other-id', title: 'Page', created: 30, updated: 40 },
    lines: [{ id: 'line-2', text: 'Page', created: 30, updated: 40, actorId: 'other-actor' }],
    actorId: 'importer',
    now: now + 1,
    onConflict: 'skip',
  });
  assert.deepEqual(skipped, { kind: 'skipped', pageId: 'imported-page' });
  assert.equal(repository.pages.get('imported-page')?.lines[0]?.userId, 'imported-actor');

  const overwritten = importPage(repository, {
    projectId: 'project',
    page: { id: 'ignored-id', title: 'Page', created: 30, updated: 40 },
    lines: [{ id: 'line-3', text: 'Page', created: 30, updated: 40, actorId: 'replacement-actor' }],
    actorId: 'importer',
    now: now + 2,
    onConflict: 'overwrite',
    attachmentClaimOwner: 'claim',
  });

  assert.deepEqual(overwritten, { kind: 'overwritten', pageId: 'imported-page' });
  assert.equal(repository.pages.get('imported-page')?.lines[0]?.userId, 'replacement-actor');
  assert.deepEqual(repository.mutations.at(-1)?.commit.ops.map((op) => op.type), ['delete', 'insert']);
  assert.deepEqual(repository.finalizedClaims, ['claim']);
  assert.deepEqual(repository.actors, new Set(['importer', 'imported-actor', 'other-actor', 'replacement-actor']));
});

void test('claim finalize の失敗時は import のページと commit を rollback する', () => {
  const repository = new FakePageRepository();
  repository.finalizeError = new Error('finalize failed');

  assert.throws(() => importPage(repository, {
    projectId: 'project',
    page: { id: 'page', title: 'Page', created: 10, updated: 20 },
    lines: [{ id: 'line', text: 'Page', created: 10, updated: 20, actorId: 'imported-actor' }],
    actorId: 'importer',
    now,
    onConflict: 'skip',
    attachmentClaimOwner: 'claim',
  }), /finalize failed/);

  assert.deepEqual(repository.pages, new Map());
  assert.deepEqual(repository.commits, new Map());
  assert.deepEqual(repository.finalizedClaims, []);
});

void test('application のページ変更は SQLite API を import しない', () => {
  const source = readFileSync(new URL('../../src/application/pageMutations.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:sqlite|DatabaseSync|BEGIN IMMEDIATE|PRAGMA/);
});
