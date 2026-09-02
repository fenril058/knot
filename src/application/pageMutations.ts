import { applyOps } from '../core/apply.ts';
import { ulid } from '../core/id.ts';
import { extractRefs, rewritePageLinks } from '../core/links.ts';
import { OpsError, type Line, type LineOp } from '../core/ops.ts';
import { titleLc } from '../core/title.ts';
import { opsHash } from '../storage/hash.ts';
import { validateImportLines } from './importValidation.ts';
import {
  BadCommitError,
  StorageError,
  type CommitInput,
  type CommitResult,
  type DeleteInput,
  type DeleteResult,
  type ImportPageInput,
  type ImportPageResult,
  type PageSnapshot,
  type RenameInput,
  type RenameResult,
} from '../storage/types.ts';

export type DerivedPageData = {
  links: { title: string; titleLc: string }[];
  image: string | null;
  searchText: string | null;
};

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

export function derivePageData(lines: Line[], deleted: boolean): DerivedPageData {
  if (deleted) return { links: [], image: null, searchText: null };
  const searchText = lines.map((line) => line.text).join('\n');
  const refs = extractRefs(searchText);
  return { links: refs.linkTargets, image: refs.image, searchText };
}

function applyCommit(tx: PageTransaction, input: CommitInput): CommitResult {
  const { projectId, pageId, commitId, baseVersion, ops, actorId, now } = input;
  tx.ensureActor(actorId, now);

  const prior = tx.getAppliedCommit(commitId);
  if (prior !== null) {
    if (prior.opsHash !== opsHash(pageId, baseVersion, ops)) {
      throw new BadCommitError(`commit ${commitId} was already applied with different content`);
    }
    return { kind: 'applied', version: prior.version };
  }

  const current = tx.getPageById(pageId);
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
  if (!deleted && (current === null || newTitleLc !== current.titleLc)) {
    const clash = tx.getPageByTitle(projectId, newTitleLc);
    if (clash !== null && clash.id !== pageId) return { kind: 'conflict', reason: 'title', page: clash };
  }

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
  const mutation: PageMutation = {
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
  };
  if (current !== null && !deleted && newTitle !== current.title) {
    mutation.titleHistory = {
      oldTitle: current.title,
      oldTitleLc: current.titleLc,
      started: tx.getCurrentTitleStarted(pageId, current.created),
      ended: now,
    };
  }
  tx.savePageMutation(mutation);
  return { kind: 'applied', version };
}

export function commitPage(repository: PageRepository, input: CommitInput): CommitResult {
  return repository.transaction((tx) => applyCommit(tx, input));
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
    const page = tx.getPageById(pageId);
    if (page === null || page.deleted) throw new BadCommitError(`unknown page: ${pageId}`);
    if (page.projectId !== projectId) throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
    if (newTitle === '') throw new BadCommitError('title must not be empty');
    if (newTitle === page.title) throw new BadCommitError('title is unchanged');
    if (baseVersion !== page.version) return { kind: 'conflict', reason: 'version', page };

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
        const changes = rewritePageLinks(source.lines.map((line) => line.text), page.titleLc, newTitle);
        const ops: LineOp[] = [];
        changes.forEach((text, index) => {
          if (text !== null) ops.push({ type: 'update', id: source.lines[index]!.id, text });
        });
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
