import type { Line, LineOp } from '../core/ops.ts';

export type Project = {
  id: string;
  name: string;
  displayName: string;
  created: number;
  updated: number;
};

export type DisplayUser = { id: string; name: string; displayName: string };

export type AuthUser = {
  id: string;
  name: string;
  displayName: string;
  email: string | null;
  passwordHash: string | null;
  isAdmin: boolean;
  created: number;
};

export type NewUser = {
  id: string;
  name: string;
  displayName: string;
  email?: string;
  passwordHash: string;
  isAdmin: boolean;
};

export type AddUserResult = { kind: 'created' | 'claimed'; id: string };

export type Session = { id: string; userId: string; expires: number; created: number };

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

export type PageSummary = PageMeta & { descriptions: string[]; linked: number };
export type PageSort = 'updated' | 'created' | 'linked' | 'title';
export type ListPageSummariesOptions = { skip: number; limit: number; sort: PageSort };

export type CommitInput = {
  projectId: string;
  pageId: string;
  commitId: string;
  baseVersion: number;
  ops: LineOp[];
  userId: string;
  now: number;
};

/**
 * conflict の page は、reason 'version' では対象ページの最新スナップショット（リベースの入力）、
 * reason 'title' ではそのタイトルを占有している別ページ（新規作成の衝突では対象ページが存在しないため）。
 * リベースと再送の対象は reason 'version' だけである。
 */
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
  /** インポート時にエクスポート元の displayName を反映する。 */
  setProjectDisplayName(projectId: string, displayName: string, now: number): Promise<void>;
  /** name 一致の既存ユーザーがいればそれを優先し、実際に有効なユーザー ID を返す。 */
  upsertDisplayUser(user: DisplayUser, now: number): Promise<string>;
  listUsersForProject(projectId: string): Promise<DisplayUser[]>;
  /**
   * ログインユーザーを追加する。同名ユーザーが password_hash なしで存在する場合
   * （インポートで作られた表示ユーザー）はパスワードを付与して昇格する（claimed）。
   * password_hash ありの同名ユーザーが既にいれば StorageError。
   */
  addUser(user: NewUser, now: number): Promise<AddUserResult>;
  getUserByName(name: string): Promise<AuthUser | null>;
  getUserById(id: string): Promise<AuthUser | null>;
  createSession(session: Session): Promise<void>;
  /** 期限切れ（expires <= now）のセッションは削除して null を返す。 */
  getSession(id: string, now: number): Promise<Session | null>;
  refreshSession(id: string, expires: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
  getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null>;
  getPageById(pageId: string): Promise<PageSnapshot | null>;
  listPages(projectId: string): Promise<PageMeta[]>;
  listPageSummaries(
    projectId: string,
    opts: ListPageSummariesOptions,
  ): Promise<{ count: number; pages: PageSummary[] }>;
  commit(input: CommitInput): Promise<CommitResult>;
  importPage(input: ImportPageInput): Promise<ImportPageResult>;
  search(projectId: string, query: string): Promise<SearchHit[]>;
  reindex(projectId?: string): Promise<{ pages: number }>;
  close(): Promise<void>;
}
