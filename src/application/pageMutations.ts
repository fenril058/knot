import { applyOps } from '../core/apply.ts';
import { diffLines } from '../core/diff.ts';
import { ulid } from '../core/id.ts';
import { rewritePageLinks } from '../core/links.ts';
import { OpsError, type Line, type LineOp } from '../core/ops.ts';
import { titleLc } from '../core/title.ts';
import { opsHash } from '../storage/hash.ts';
import { validateImportLines } from './importValidation.ts';
import { derivePageData, type DerivedPageData } from './pageDerivedData.ts';
import {
  BadCommitError,
  StorageError,
  UnknownPageError,
  type CommitInput,
  type CommitResult,
  type DeleteInput,
  type DeleteResult,
  type ImportPageInput,
  type ImportPageResult,
  type PageSnapshot,
  type ReplacePageTextInput,
  type ReplacePageTextResult,
  type RenameInput,
  type RenameResult,
} from '../storage/types.ts';

export { derivePageData } from './pageDerivedData.ts';

export type PageMutation = {
  before: PageSnapshot | null;
  after: PageSnapshot;
  titleHistory?: { oldTitle: string; oldTitleLc: string; started: number; ended: number };
  commit: {
    id: string;
    pageId: string;
    baseVersion: number;
    version: number;
    actorId: string;
    created: number;
    ops: LineOp[];
    opsHash: string;
  };
  derived: DerivedPageData;
};

export type AppliedCommit = { version: number; opsHash: string };

export interface PageTransaction {
  ensureActor(actorId: string, now: number): void;
  getAppliedCommit(commitId: string): AppliedCommit | null;
  getPageById(pageId: string): PageSnapshot | null;
  getPageByTitle(projectId: string, titleLcValue: string): PageSnapshot | null;
  getCurrentTitleStarted(pageId: string, fallback: number): number;
  pageIdExists(pageId: string): boolean;
  listPagesLinkingTo(projectId: string, targetTitleLc: string, excludePageId: string): PageSnapshot[];
  savePageMutation(mutation: PageMutation): void;
  finalizeAttachmentClaims(owner: string): void;
}

export interface PageRepository {
  transaction<T>(operation: (tx: PageTransaction) => T): T;
}

export interface GuardedPageMutationRepository {
  getAppliedCommit(commitId: string): Promise<AppliedCommit | null>;
  getPageById(pageId: string): Promise<PageSnapshot | null>;
  getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null>;
  getCurrentTitleStarted(pageId: string, fallback: number): Promise<number>;
  getPageMutationRevision(projectId: string): Promise<number>;
  tryApplyPageMutation(mutation: PageMutation, expectedRevision: number): Promise<boolean>;
}

export interface GuardedPageRenameRepository extends GuardedPageMutationRepository {
  listPagesLinkingTo(projectId: string, targetTitleLc: string, excludePageId: string): Promise<PageSnapshot[]>;
  tryApplyPageMutations(mutations: PageMutation[], expectedRevision: number): Promise<boolean>;
}

type PreparedCommit = { kind: 'prepared'; mutation: PageMutation };

function prepareCommit(
  input: CommitInput,
  prior: AppliedCommit | null,
  current: PageSnapshot | null,
): CommitResult | PreparedCommit {
  const { projectId, pageId, commitId, baseVersion, ops, actorId, now } = input;
  if (prior !== null) {
    if (prior.opsHash !== opsHash(pageId, baseVersion, ops)) {
      throw new BadCommitError(`commit ${commitId} was already applied with different content`);
    }
    return { kind: 'applied', version: prior.version };
  }

  if (current === null && baseVersion !== 0) throw new BadCommitError(`unknown page: ${pageId}`);
  if (current !== null && current.projectId !== projectId) {
    throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
  }
  if (current?.deleted === true) throw new BadCommitError(`page ${pageId} is deleted`);
  if (current !== null && baseVersion !== current.version) {
    return { kind: 'conflict', reason: 'version', page: current };
  }

  const version = baseVersion + 1;
  let lines: Line[];
  try {
    lines = applyOps(current?.lines ?? [], ops, { userId: actorId, now, version });
  } catch (error) {
    if (error instanceof OpsError) throw new BadCommitError(error.message);
    throw error;
  }

  const deleted = lines.length === 0;
  if (current === null && deleted) throw new BadCommitError('page creation must leave at least one line');
  const newTitle = deleted ? current!.title : lines[0]!.text;
  const newTitleLc = titleLc(newTitle);
  const after: PageSnapshot = {
    id: pageId,
    projectId,
    title: newTitle,
    titleLc: newTitleLc,
    version,
    pinned: current?.pinned ?? 0,
    deleted,
    image: null,
    created: current?.created ?? now,
    updated: now,
    lines,
  };
  const derived = derivePageData(lines, deleted);
  after.image = derived.image;
  return { kind: 'prepared', mutation: {
    before: current,
    after,
    commit: {
      id: commitId,
      pageId,
      baseVersion,
      version,
      actorId,
      created: now,
      ops,
      opsHash: opsHash(pageId, baseVersion, ops),
    },
    derived,
  } };
}

function needsTitleLookup(mutation: PageMutation): boolean {
  return !mutation.after.deleted
    && (mutation.before === null || mutation.after.titleLc !== mutation.before.titleLc);
}

function titleConflict(mutation: PageMutation, clash: PageSnapshot | null): CommitResult | null {
  return clash !== null && clash.id !== mutation.after.id
    ? { kind: 'conflict', reason: 'title', page: clash }
    : null;
}

type TitleChangingMutation = PageMutation & { before: PageSnapshot };

function needsTitleHistory(mutation: PageMutation): mutation is TitleChangingMutation {
  return mutation.before !== null
    && !mutation.after.deleted
    && mutation.after.title !== mutation.before.title;
}

function addTitleHistory(mutation: PageMutation, started: number): void {
  if (!needsTitleHistory(mutation)) return;
  const { before, after } = mutation;
  mutation.titleHistory = {
    oldTitle: before.title,
    oldTitleLc: before.titleLc,
    started,
    ended: after.updated,
  };
}

function applyCommit(tx: PageTransaction, input: CommitInput): CommitResult {
  tx.ensureActor(input.actorId, input.now);
  const prepared = prepareCommit(input, tx.getAppliedCommit(input.commitId), tx.getPageById(input.pageId));
  if (prepared.kind !== 'prepared') return prepared;
  const { mutation } = prepared;
  if (needsTitleLookup(mutation)) {
    const conflict = titleConflict(mutation, tx.getPageByTitle(input.projectId, mutation.after.titleLc));
    if (conflict !== null) return conflict;
  }
  if (needsTitleHistory(mutation)) {
    addTitleHistory(mutation, tx.getCurrentTitleStarted(input.pageId, mutation.before.created));
  }
  tx.savePageMutation(mutation);
  return { kind: 'applied', version: mutation.after.version };
}

export function commitPage(repository: PageRepository, input: CommitInput): CommitResult {
  return repository.transaction((tx) => applyCommit(tx, input));
}

const MAX_GUARD_RETRIES = 3;

export async function commitPageGuarded(
  repository: GuardedPageMutationRepository,
  input: CommitInput,
): Promise<CommitResult> {
  for (let attempt = 0; attempt < MAX_GUARD_RETRIES; attempt += 1) {
    const expectedRevision = await repository.getPageMutationRevision(input.projectId);
    const prior = await repository.getAppliedCommit(input.commitId);
    const current = await repository.getPageById(input.pageId);
    const prepared = prepareCommit(input, prior, current);
    if (prepared.kind !== 'prepared') return prepared;
    const { mutation } = prepared;
    if (needsTitleLookup(mutation)) {
      const conflict = titleConflict(
        mutation,
        await repository.getPageByTitle(input.projectId, mutation.after.titleLc),
      );
      if (conflict !== null) return conflict;
    }
    if (needsTitleHistory(mutation)) {
      addTitleHistory(
        mutation,
        await repository.getCurrentTitleStarted(input.pageId, mutation.before.created),
      );
    }
    try {
      if (await repository.tryApplyPageMutation(mutation, expectedRevision)) {
        return { kind: 'applied', version: mutation.after.version };
      }
    } catch (error) {
      // A D1 transport error can arrive after the transaction committed. Confirm by commitId
      // before surfacing a retryable failure so the caller never applies the same commit twice.
      const applied = await repository.getAppliedCommit(input.commitId);
      if (applied !== null) {
        const confirmed = prepareCommit(input, applied, current);
        if (confirmed.kind === 'prepared') throw new StorageError('applied commit was not recognized');
        return confirmed;
      }
      throw error;
    }
  }
  throw new StorageError(`page mutation did not converge after ${MAX_GUARD_RETRIES} guarded attempts`);
}

function renameOps(page: PageSnapshot, newTitle: string): LineOp[] {
  return [{ type: 'update', id: page.lines[0]!.id, text: newTitle }];
}

function backlinkRewriteOps(source: PageSnapshot, oldTitleLc: string, newTitle: string): LineOp[] {
  const changes = rewritePageLinks(source.lines.map((line) => line.text), oldTitleLc, newTitle);
  const ops: LineOp[] = [];
  changes.forEach((text, index) => {
    if (text !== null) ops.push({ type: 'update', id: source.lines[index]!.id, text });
  });
  return ops;
}

async function prepareExistingGuardedMutation(
  repository: GuardedPageMutationRepository,
  input: CommitInput,
  current: PageSnapshot,
): Promise<CommitResult | PreparedCommit> {
  // rename の commit ID はこの operation 内で生成され、retry でも同じ ID を使う。
  // apply が false の場合は batch 全体が rollback 済みなので、事前の commit lookup は不要。
  const prepared = prepareCommit(input, null, current);
  if (prepared.kind !== 'prepared') return prepared;
  const { mutation } = prepared;
  if (needsTitleLookup(mutation)) {
    const conflict = titleConflict(
      mutation,
      await repository.getPageByTitle(input.projectId, mutation.after.titleLc),
    );
    if (conflict !== null) return conflict;
  }
  if (needsTitleHistory(mutation)) {
    addTitleHistory(
      mutation,
      await repository.getCurrentTitleStarted(input.pageId, mutation.before.created),
    );
  }
  return prepared;
}

export async function renamePageGuarded(
  repository: GuardedPageRenameRepository,
  input: RenameInput,
): Promise<RenameResult> {
  const { projectId, pageId, baseVersion, newTitle, rewriteLinks, actorId, now } = input;
  if (newTitle === '') throw new BadCommitError('title must not be empty');
  const commitIds = new Map<string, string>();
  const commitIdFor = (id: string): string => {
    const existing = commitIds.get(id);
    if (existing !== undefined) return existing;
    const created = ulid(now * 1000);
    commitIds.set(id, created);
    return created;
  };

  for (let attempt = 0; attempt < MAX_GUARD_RETRIES; attempt += 1) {
    const expectedRevision = await repository.getPageMutationRevision(projectId);
    const page = await repository.getPageById(pageId);
    if (page === null || page.projectId !== projectId) throw new UnknownPageError(`unknown page: ${pageId}`);
    if (baseVersion !== page.version) return { kind: 'conflict', reason: 'version', page };
    if (page.deleted) throw new UnknownPageError(`unknown page: ${pageId}`);
    if (newTitle === page.title) throw new BadCommitError('title is unchanged');

    const titlePrepared = await prepareExistingGuardedMutation(repository, {
      projectId,
      pageId,
      commitId: commitIdFor(pageId),
      baseVersion,
      ops: renameOps(page, newTitle),
      actorId,
      now,
    }, page);
    if (titlePrepared.kind !== 'prepared') {
      if (titlePrepared.kind === 'conflict') return titlePrepared;
      throw new StorageError('rename commit was unexpectedly already applied');
    }

    const mutations = [titlePrepared.mutation];
    const rewritten: { pageId: string; title: string; version: number }[] = [];
    if (rewriteLinks && titleLc(newTitle) !== page.titleLc) {
      const sources = await repository.listPagesLinkingTo(projectId, page.titleLc, pageId);
      for (const source of sources) {
        const ops = backlinkRewriteOps(source, page.titleLc, newTitle);
        if (ops.length === 0) continue;
        const prepared = await prepareExistingGuardedMutation(repository, {
          projectId,
          pageId: source.id,
          commitId: commitIdFor(source.id),
          baseVersion: source.version,
          ops,
          actorId,
          now,
        }, source);
        if (prepared.kind !== 'prepared') {
          throw new StorageError(`link rewrite conflict on page ${source.id}`);
        }
        mutations.push(prepared.mutation);
        rewritten.push({ pageId: source.id, title: source.title, version: prepared.mutation.after.version });
      }
    }
    if (await repository.tryApplyPageMutations(mutations, expectedRevision)) {
      return { kind: 'applied', version: titlePrepared.mutation.after.version, rewritten };
    }
  }
  throw new StorageError(`page rename did not converge after ${MAX_GUARD_RETRIES} guarded attempts`);
}

export async function deletePageGuarded(
  repository: GuardedPageMutationRepository,
  input: DeleteInput,
): Promise<DeleteResult> {
  const page = await repository.getPageById(input.pageId);
  if (page === null) throw new BadCommitError(`unknown page: ${input.pageId}`);
  if (page.projectId !== input.projectId) {
    throw new BadCommitError(`page ${input.pageId} is not in project ${input.projectId}`);
  }
  if (input.baseVersion !== page.version) return { kind: 'conflict', reason: 'version', page };
  if (page.deleted) throw new BadCommitError(`unknown page: ${input.pageId}`);
  const result = await commitPageGuarded(repository, {
    ...input,
    commitId: ulid(input.now * 1000),
    ops: page.lines.map((line) => ({ type: 'delete', id: line.id })),
  });
  if (result.kind === 'applied') return result;
  if (result.reason === 'title') throw new StorageError('unexpected title conflict in deletePage');
  return { kind: 'conflict', reason: 'version', page: result.page };
}

export function replacePageText(
  repository: PageRepository,
  input: ReplacePageTextInput,
): ReplacePageTextResult {
  const { projectId, baseVersion, newTexts, actorId, now } = input;
  return repository.transaction((tx) => {
    let page: PageSnapshot | null = null;
    let pageId: string;
    if (input.pageId === null) {
      if (baseVersion !== 0) throw new UnknownPageError('pageId required for existing page');
      if (newTexts.length === 0 || titleLc(newTexts[0]!) !== input.urlTitleLc) {
        throw new BadCommitError('first line must match the URL title');
      }
      pageId = ulid(now * 1000);
    } else {
      pageId = input.pageId;
      page = tx.getPageById(pageId);
      if (page === null) throw new UnknownPageError(`unknown page: ${pageId}`);
      if (page.projectId !== projectId) throw new UnknownPageError(`page ${pageId} is not in project ${projectId}`);
      if (baseVersion !== page.version) return { kind: 'conflict', reason: 'version', page };
      if (page.deleted) throw new UnknownPageError(`unknown page: ${pageId}`);
    }

    const ops = diffLines(page?.lines ?? [], newTexts, () => ulid(now * 1000));
    if (ops.length === 0) {
      if (page === null) throw new StorageError('new page unexpectedly produced no operations');
      return { kind: 'applied', version: page.version, commitId: null };
    }

    const commitId = ulid(now * 1000);
    const result = applyCommit(tx, {
      projectId,
      pageId,
      commitId,
      baseVersion,
      ops,
      actorId,
      now,
    });
    return result.kind === 'applied' ? { ...result, commitId } : result;
  });
}

export function deletePage(
  repository: PageRepository,
  input: DeleteInput,
): DeleteResult {
  const { projectId, pageId, baseVersion, actorId, now } = input;
  return repository.transaction((tx) => {
    const page = tx.getPageById(pageId);
    if (page === null) throw new BadCommitError(`unknown page: ${pageId}`);
    if (page.projectId !== projectId) throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
    if (baseVersion !== page.version) return { kind: 'conflict', reason: 'version', page };
    if (page.deleted) throw new BadCommitError(`unknown page: ${pageId}`);
    const ops: LineOp[] = page.lines.map((line) => ({ type: 'delete', id: line.id }));
    const result = applyCommit(tx, {
      projectId,
      pageId,
      commitId: ulid(now * 1000),
      baseVersion,
      ops,
      actorId,
      now,
    });
    if (result.kind !== 'applied') throw new StorageError('unexpected conflict in deletePage');
    return result;
  });
}

export function renamePage(repository: PageRepository, input: RenameInput): RenameResult {
  const { projectId, pageId, baseVersion, newTitle, rewriteLinks, actorId, now } = input;
  return repository.transaction((tx) => {
    // URL のタイトルではなく呼び出し元が指定した pageId で対象を固定し、version 照合まで同じ transaction で行う。
    const page = tx.getPageById(pageId);
    if (page === null) throw new UnknownPageError(`unknown page: ${pageId}`);
    if (page.projectId !== projectId) throw new UnknownPageError(`page ${pageId} is not in project ${projectId}`);
    if (newTitle === '') throw new BadCommitError('title must not be empty');
    // 他クライアントの削除で version が進んだ場合も、利用者には未確認の変更との競合として返す。
    if (baseVersion !== page.version) return { kind: 'conflict', reason: 'version', page };
    if (page.deleted) throw new UnknownPageError(`unknown page: ${pageId}`);
    if (newTitle === page.title) throw new BadCommitError('title is unchanged');

    const titleCommit = applyCommit(tx, {
      projectId,
      pageId,
      commitId: ulid(now * 1000),
      baseVersion,
      ops: [{ type: 'update', id: page.lines[0]!.id, text: newTitle }],
      actorId,
      now,
    });
    if (titleCommit.kind === 'conflict') {
      return { kind: 'conflict', reason: 'title', page: titleCommit.page };
    }

    const rewritten: { pageId: string; title: string; version: number }[] = [];
    if (rewriteLinks && titleLc(newTitle) !== page.titleLc) {
      const sources = tx.listPagesLinkingTo(projectId, page.titleLc, pageId);
      for (const source of sources) {
        const ops = backlinkRewriteOps(source, page.titleLc, newTitle);
        if (ops.length === 0) continue;
        const result = applyCommit(tx, {
          projectId,
          pageId: source.id,
          commitId: ulid(now * 1000),
          baseVersion: source.version,
          ops,
          actorId,
          now,
        });
        if (result.kind !== 'applied') throw new StorageError(`link rewrite conflict on page ${source.id}`);
        rewritten.push({ pageId: source.id, title: source.title, version: result.version });
      }
    }
    return { kind: 'applied', version: titleCommit.version, rewritten };
  });
}

export function importPage(repository: PageRepository, input: ImportPageInput): ImportPageResult {
  return repository.transaction((tx) => {
    const { projectId, page, lines, actorId, now, onConflict } = input;
    tx.ensureActor(actorId, now);
    for (const line of lines) tx.ensureActor(line.actorId, line.created);
    validateImportLines(page.title, lines);
    const normalizedTitle = titleLc(page.title);
    const existing = tx.getPageByTitle(projectId, normalizedTitle);
    if (existing !== null && onConflict === 'skip') return { kind: 'skipped', pageId: existing.id };

    const insertOps: LineOp[] = lines.map((line, index) => ({
      type: 'insert',
      id: line.id,
      after: index === 0 ? '_head' : lines[index - 1]!.id,
      text: line.text,
    }));
    const current = existing;
    const pageId = current === null && tx.pageIdExists(page.id) ? ulid(now * 1000) : (current?.id ?? page.id);
    const version = (current?.version ?? 0) + 1;
    const importedLines: Line[] = lines.map((line) => ({
      id: line.id,
      text: line.text,
      created: line.created,
      updated: line.updated,
      updatedVersion: version,
      userId: line.actorId,
    }));
    const ops = current === null
      ? insertOps
      : [...current.lines.map((line): LineOp => ({ type: 'delete', id: line.id })), ...insertOps];
    const derived = derivePageData(importedLines, false);
    const after: PageSnapshot = {
      id: pageId,
      projectId,
      title: page.title,
      titleLc: normalizedTitle,
      version,
      pinned: current?.pinned ?? 0,
      deleted: false,
      image: derived.image,
      created: page.created,
      updated: page.updated,
      lines: importedLines,
    };
    tx.savePageMutation({
      before: current,
      after,
      commit: {
        id: ulid(now * 1000),
        pageId,
        baseVersion: current?.version ?? 0,
        version,
        actorId,
        created: now,
        ops,
        opsHash: opsHash(pageId, current?.version ?? 0, ops),
      },
      derived,
    });
    if (input.attachmentClaimOwner !== undefined) tx.finalizeAttachmentClaims(input.attachmentClaimOwner);
    return { kind: current === null ? 'created' : 'overwritten', pageId };
  });
}
