import type { Line, LineOp } from '../core/ops.ts';
import type { SearchQuery } from '../core/searchQuery.ts';

export type Project = {
  id: string;
  name: string;
  displayName: string;
  created: number;
  updated: number;
};

export type Actor = { id: string; name: string; displayName: string };

export type Account = {
  id: string;
  actorId: string;
  name: string;
  email: string | null;
  passwordHash: string | null;
  isAdmin: boolean;
  created: number;
};

export type NewAccount = {
  id: string;
  actor: Actor;
  name: string;
  email?: string;
  passwordHash: string;
  isAdmin: boolean;
};

export type AddAccountResult = { accountId: string; actorId: string };

export type Session = { id: string; accountId: string; expires: number; created: number };

export type ApiToken = { id: string; accountId: string; label: string; created: number };

export type Attachment = {
  id: string;
  projectId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  actorId: string;
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

export type PageVisitMetrics = { views: number; accessed: number };
export type PageSummary = PageMeta & PageVisitMetrics & { descriptions: string[]; linked: number };
export type PageSort = 'updated' | 'created' | 'linked' | 'title' | 'views' | 'accessed';
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
  accessed: number;
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
  actorId: string;
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
  actorId: string;
  now: number;
};

export type RenameResult =
  | { kind: 'applied'; version: number; rewritten: { pageId: string; title: string; version: number }[] }
  | { kind: 'conflict'; reason: 'version' | 'title'; page: PageSnapshot };

export type ImportLine = { id: string; text: string; created: number; updated: number; actorId: string };

export type ImportPageInput = {
  projectId: string;
  page: { id: string; title: string; created: number; updated: number };
  lines: ImportLine[];
  actorId: string;
  now: number;
  onConflict: 'skip' | 'overwrite';
  /** ページ確定まで暫定添付を保持する import 処理の識別子。 */
  attachmentClaimOwner?: string;
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
  /** Actor は未登録 ID だけ追加し、同名や ID 衝突を根拠に既存 identity を変更しない。 */
  upsertActor(actor: Actor, now: number): Promise<string>;
  getActorById(id: string): Promise<Actor | null>;
  listActorsForProject(projectId: string): Promise<Actor[]>;
  /** Account と、通常の web 編集で使用する専用 Actor を同時に追加する。 */
  addAccount(account: NewAccount, now: number): Promise<AddAccountResult>;
  getAccountByName(name: string): Promise<Account | null>;
  getAccountById(id: string): Promise<Account | null>;
  createApiToken(token: { id: string; accountId: string; label: string; tokenHash: string; created: number }): Promise<void>;
  getAccountByApiTokenHash(tokenHash: string): Promise<Account | null>;
  listApiTokens(accountId: string): Promise<ApiToken[]>;
  deleteApiToken(id: string): Promise<boolean>;
  createSession(session: Session): Promise<void>;
  /** 期限切れ（expires <= now）のセッションは削除して null を返す。 */
  getSession(id: string, now: number): Promise<Session | null>;
  refreshSession(id: string, expires: number): Promise<void>;
  deleteSession(id: string): Promise<void>;
  /** claimOwner がある添付は、対応するページが確定するまで一覧・取得 API へ公開しない。 */
  createAttachment(attachment: Attachment, claimOwner?: string): Promise<void>;
  updateAttachmentMetadata(id: string, filename: string, contentType: string): Promise<void>;
  /** owner の利用宣言を解除し、他の利用者もページ参照もない暫定添付 ID を返す。 */
  releaseAttachmentClaims(owner: string): Promise<string[]>;
  /** owner が利用中の暫定添付を確定し、同じ添付に対する利用宣言を解除する。 */
  finalizeAttachmentClaims(owner: string): Promise<void>;
  listAttachments(projectId: string): Promise<Attachment[]>;
  getAttachment(id: string): Promise<Attachment | null>;
  /** 再利用はプロジェクト単位とし、claimOwner があれば暫定添付への利用を宣言する。 */
  reuseAttachmentBySha256(projectId: string, sha256: string, claimOwner?: string): Promise<Attachment | null>;
  getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null>;
  getPageById(pageId: string): Promise<PageSnapshot | null>;
  getPageAuthors(pageId: string): Promise<{ user: Actor | null; lastUpdateUser: Actor | null }>;
  listPages(projectId: string): Promise<PageMeta[]>;
  listPageSummaries(
    projectId: string,
    opts: ListPageSummariesOptions,
  ): Promise<{ count: number; pages: PageSummary[] }>;
  /**
   * links1hop: このページの前方リンク先として存在するページ ∪ このページへ張っているページ。
   * links2hop: このページの前方リンク先（空リンク含む）へ張っている他のページ（自分と 1hop を除く）。
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
  deletePage(projectId: string, pageId: string, actorId: string, now: number): Promise<{ version: number }>;
  /** タイトル変更 + 任意でリンク元書き換え。単一トランザクションで全部成功か全部失敗 */
  renamePage(input: RenameInput): Promise<RenameResult>;
  importPage(input: ImportPageInput): Promise<ImportPageResult>;
  search(projectId: string, query: SearchQuery): Promise<SearchHit[]>;
  reindex(projectId?: string): Promise<{ pages: number }>;
  /** 前回訪問を上書きする前に呼ぶこと。未訪問は null */
  getVisit(accountId: string, pageId: string): Promise<Visit | null>;
  getPageVisitMetrics(pageId: string): Promise<PageVisitMetrics>;
  recordVisit(accountId: string, pageId: string, visitedAt: number, lastSeenVersion: number): Promise<void>;
  close(): Promise<void>;
}
