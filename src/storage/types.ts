import type { Line, LineOp } from '../core/ops.ts';

export type Project = {
  id: string;
  name: string;
  displayName: string;
  created: number;
  updated: number;
};

export type DisplayUser = { id: string; name: string; displayName: string };

export type PageMeta = {
  id: string;
  projectId: string;
  title: string;
  titleLc: string;
  version: number;
  pinned: number;
  deleted: boolean;
  image: string | null;
  created: number;
  updated: number;
};

export type PageSnapshot = PageMeta & { lines: Line[] };

export type CommitInput = {
  projectId: string;
  pageId: string;
  commitId: string;
  baseVersion: number;
  ops: LineOp[];
  userId: string;
  now: number;
};

export type CommitResult =
  | { kind: 'applied'; version: number }
  | { kind: 'conflict'; reason: 'version' | 'title'; page: PageSnapshot };

export type ImportLine = { id: string; text: string; created: number; updated: number; userId: string };

export type ImportPageInput = {
  projectId: string;
  page: { id: string; title: string; created: number; updated: number };
  lines: ImportLine[];
  userId: string;
  now: number;
  onConflict: 'skip' | 'overwrite';
};

export type ImportPageResult = { kind: 'created' | 'overwritten' | 'skipped'; pageId: string };

export type SearchHit = { pageId: string; title: string; lines: string[] };

/** 400 系: 再送しても直らないクライアント不正。409（conflict）とは区別する。 */
export class BadCommitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadCommitError';
  }
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface Storage {
  ensureProject(name: string, now: number): Promise<Project>;
  getProject(name: string): Promise<Project | null>;
  /** name 一致の既存ユーザーがいればそれを優先し、実際に有効なユーザー ID を返す。 */
  upsertDisplayUser(user: DisplayUser, now: number): Promise<string>;
  listUsersForProject(projectId: string): Promise<DisplayUser[]>;
  getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null>;
  getPageById(pageId: string): Promise<PageSnapshot | null>;
  listPages(projectId: string): Promise<PageMeta[]>;
  commit(input: CommitInput): Promise<CommitResult>;
  importPage(input: ImportPageInput): Promise<ImportPageResult>;
  search(projectId: string, query: string): Promise<SearchHit[]>;
  reindex(projectId?: string): Promise<{ pages: number }>;
  close(): Promise<void>;
}
