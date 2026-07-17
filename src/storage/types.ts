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

export type ApiToken = { id: string; userId: string; label: string; created: number };

export type Attachment = {
  id: string;
  projectId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  userId: string;
  created: number;
};

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
export type ListPageSummariesOptions = { skip: number; limit: number; sort: PageSort; pinnedFirst?: boolean };

export type RelatedPage = {
  id: string;
  title: string;
  titleLc: string;
  image: string | null;
  descriptions: string[];
  linksLc: string[];
  linked: number;
  updated: number;
};

/** linked は対象ページ自身の被リンク数（ページ本体応答の linked フィールド用） */
export type RelatedPages = {
  links1hop: RelatedPage[];
  links2hop: RelatedPage[];
  hasBackLinks: boolean;
  linked: number;
};

export type TitleEntry = { id: string; title: string; hasIcon: boolean; updated: number; links: string[]; image: string | null };

export type Visit = { visited: number; lastSeenVersion: number };

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

export type RenameInput = {
  projectId: string;
  pageId: string;
  baseVersion: number;
  newTitle: string;
  rewriteLinks: boolean;
  userId: string;
  now: number;
};

export type RenameResult =
  | { kind: 'applied'; version: number; rewritten: { pageId: string; title: string; version: number }[] }
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

export type SearchHit = { pageId: string; title: string; image: string | null; lines: string[] };

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
  listProjects(): Promise<Project[]>;
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
  createApiToken(token: { id: string; userId: string; label: string; tokenHash: string; created: number }): Promise<void>;
  getUserByApiTokenHash(tokenHash: string): Promise<AuthUser | null>;
  listApiTokens(userId: string): Promise<ApiToken[]>;
  deleteApiToken(id: string): Promise<boolean>;
  createSession(session: Session): Promise<void>;
  /** 期限切れ（expires <= now）のセッションは削除して null を返す。 */
  getSession(id: string, now: number): Promise<Session | null>;
  refreshSession(id: string, expires: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
  createAttachment(attachment: Attachment): Promise<void>;
  getAttachment(id: string): Promise<Attachment | null>;
  /** 再利用はプロジェクト単位とし、別プロジェクトの ID やメタデータを返さない。 */
  findAttachmentBySha256(projectId: string, sha256: string): Promise<Attachment | null>;
  getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null>;
  getPageById(pageId: string): Promise<PageSnapshot | null>;
  listPages(projectId: string): Promise<PageMeta[]>;
  listPageSummaries(
    projectId: string,
    opts: ListPageSummariesOptions,
  ): Promise<{ count: number; pages: PageSummary[] }>;
  /**
   * links1hop: このページの前方リンク先として存在するページ ∪ このページへ張っているページ。
   * links2hop: このページの前方リンク先（赤リンク含む）へ張っている他のページ（自分と 1hop を除く）。
   *            その entry の linksLc は共有しているリンク先の lc。
   * 1hop の linksLc はそのページ自身の前方リンク lc。
   * hasBackLinks: extractRefs は [X.icon] もリンクとして links に記録するため、
   * これは「逆リンクまたはアイコン参照の有無」に一致し、応答フィールド
   * hasBackLinksOrIcons の意味をそのまま満たす。
   */
  getRelatedPages(projectId: string, pageId: string, titleLcValue: string): Promise<RelatedPages>;
  /** 全ページのタイトルと前方リンク（原文タイトル）。search/titles と 2-hop・補完のデータ源 */
  listPageTitles(projectId: string): Promise<TitleEntry[]>;
  /** HTML レンダリング用の既知ページ。前方リンクを取得せず単一クエリで返す。 */
  listKnownPages(projectId: string): Promise<{ titleLc: string; title: string; image: string | null }[]>;
  setPinned(pageId: string, pinned: boolean): Promise<void>;
  commit(input: CommitInput): Promise<CommitResult>;
  /** 全行 delete のコミットとしてページを削除する。不在・削除済みは BadCommitError */
  deletePage(projectId: string, pageId: string, userId: string, now: number): Promise<{ version: number }>;
  /** タイトル変更 + 任意でリンク元書き換え。単一トランザクションで全部成功か全部失敗 */
  renamePage(input: RenameInput): Promise<RenameResult>;
  importPage(input: ImportPageInput): Promise<ImportPageResult>;
  search(projectId: string, query: string): Promise<SearchHit[]>;
  reindex(projectId?: string): Promise<{ pages: number }>;
  /** 前回訪問を上書きする前に呼ぶこと。未訪問は null */
  getVisit(userId: string, pageId: string): Promise<Visit | null>;
  recordVisit(userId: string, pageId: string, visitedAt: number, lastSeenVersion: number): Promise<void>;
  close(): Promise<void>;
}
