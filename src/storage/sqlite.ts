import { DatabaseSync } from 'node:sqlite';
import {
  commitPage,
  deletePage as deletePageApplication,
  derivePageData,
  importPage as importPageApplication,
  renamePage as renamePageApplication,
  type PageMutation,
  type PageRepository,
  type PageTransaction,
} from '../application/pageMutations.ts';
import type { Line } from '../core/ops.ts';
import { ulid } from '../core/id.ts';
import type { SearchQuery } from '../core/searchQuery.ts';
import {
  StorageError,
  type Account,
  type Actor,
  type AddAccountResult,
  type ApiToken,
  type Attachment,
  type CommitInput,
  type CommitResult,
  type CreateAttachmentResult,
  type CreateProjectResult,
  type ImportPageInput,
  type ImportPageResult,
  type ListPageSummariesOptions,
  type NewAccount,
  type PageMeta,
  type PageSort,
  type PageSnapshot,
  type PageSummary,
  type PageVisitMetrics,
  type Project,
  type RelatedPage,
  type RelatedPages,
  type RenameInput,
  type RenameResult,
  type SearchHit,
  type Session,
  type Storage,
  type TitleEntry,
  type Visit,
} from './types.ts';

const PROJECT_NAME_RE = /^[a-z0-9-]+$/;
const MAX_PROJECT_NAME_LENGTH = 64;
const RESERVED_PROJECT_NAMES = new Set(['api', 'login', 'files', 'assets']);
const SQLITE_CONSTRAINT_UNIQUE = 2067;

type AccountRow = {
  id: string;
  actor_id: string;
  name: string;
  email: string | null;
  password_hash: string | null;
  is_admin: number;
  created: number;
};

type PageRow = {
  id: string;
  project_id: string;
  title: string;
  title_lc: string;
  version: number;
  pinned: number;
  deleted: number;
  image: string | null;
  created: number;
  updated: number;
};

type LineRow = {
  id: string;
  text: string;
  created: number;
  updated: number;
  updated_version: number;
  actor_id: string;
};

type AttachmentRow = {
  id: string;
  project_id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  actor_id: string;
  created: number;
  provisional: number;
};

function escapeLike(s: string): string {
  return s.replaceAll(/[\\%_]/g, (m) => `\\${m}`);
}

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'errcode' in error
    && error.errcode === SQLITE_CONSTRAINT_UNIQUE;
}

export class SqliteStorage implements Storage {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  #ensureActor(actorId: string, now: number): void {
    this.#db
      .prepare('INSERT OR IGNORE INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?)')
      .run(actorId, actorId, actorId, now);
  }

  #getProjectRow(name: string): Project | null {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = this.#db
      .prepare('SELECT id, name, display_name, created, updated FROM projects WHERE name = ?')
      .get(name) as { id: string; name: string; display_name: string; created: number; updated: number } | undefined;
    return r ? { id: r.id, name: r.name, displayName: r.display_name, created: r.created, updated: r.updated } : null;
  }

  async createProject(name: string, now: number): Promise<CreateProjectResult> {
    if (!PROJECT_NAME_RE.test(name) || RESERVED_PROJECT_NAMES.has(name)) {
      throw new StorageError(`invalid project name: ${name}`);
    }
    return this.#tx(() => {
      const existing = this.#getProjectRow(name);
      if (existing) return { kind: 'existing', project: existing };
      if (name.length > MAX_PROJECT_NAME_LENGTH) {
        throw new StorageError(`invalid project name: ${name}`);
      }
      const id = ulid(now * 1000);
      this.#db
        .prepare('INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, name, now, now);
      return { kind: 'created', project: { id, name, displayName: name, created: now, updated: now } };
    });
  }

  async ensureProject(name: string, now: number): Promise<Project> {
    return (await this.createProject(name, now)).project;
  }

  async getProject(name: string): Promise<Project | null> {
    return this.#getProjectRow(name);
  }

  async listProjects(): Promise<Project[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare('SELECT id, name, display_name, created, updated FROM projects ORDER BY name')
      .all() as { id: string; name: string; display_name: string; created: number; updated: number }[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      created: row.created,
      updated: row.updated,
    }));
  }

  async setProjectDisplayName(projectId: string, displayName: string, now: number): Promise<void> {
    this.#db
      .prepare('UPDATE projects SET display_name = ?, updated = ? WHERE id = ?')
      .run(displayName, now, projectId);
  }

  async upsertActor(actor: Actor, now: number): Promise<string> {
    this.#db
      .prepare(
        `INSERT INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(actor.id, actor.name, actor.displayName, now);
    return actor.id;
  }

  async getActorById(id: string): Promise<Actor | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db.prepare('SELECT id, name, display_name FROM actors WHERE id = ?').get(id) as
      | { id: string; name: string; display_name: string }
      | undefined;
    return row ? { id: row.id, name: row.name, displayName: row.display_name } : null;
  }

  async listActorsForProject(projectId: string): Promise<Actor[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare(
        `SELECT a.id, a.name, a.display_name FROM actors a
         WHERE a.id IN (
           SELECT l.actor_id FROM lines l JOIN pages p ON p.id = l.page_id WHERE p.project_id = ?
           UNION
           SELECT c.actor_id FROM commits c JOIN pages p ON p.id = c.page_id WHERE p.project_id = ?
         )
         ORDER BY a.name, a.id`,
      )
      .all(projectId, projectId) as { id: string; name: string; display_name: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, displayName: r.display_name }));
  }

  async getPageAuthors(
    pageId: string,
  ): Promise<{ user: Actor | null; lastUpdateUser: Actor | null }> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare(
        `WITH first_commit AS (
           SELECT actor_id FROM commits WHERE page_id = ? ORDER BY version ASC LIMIT 1
         ), last_commit AS (
           SELECT actor_id FROM commits WHERE page_id = ? ORDER BY version DESC LIMIT 1
         )
         SELECT
           first_user.id AS first_id,
           first_user.name AS first_name,
           first_user.display_name AS first_display_name,
           last_user.id AS last_id,
           last_user.name AS last_name,
           last_user.display_name AS last_display_name
         FROM first_commit
         CROSS JOIN last_commit
         LEFT JOIN actors first_user ON first_user.id = first_commit.actor_id
         LEFT JOIN actors last_user ON last_user.id = last_commit.actor_id`,
      )
      .get(pageId, pageId) as
      | {
          first_id: string | null;
          first_name: string | null;
          first_display_name: string | null;
          last_id: string | null;
          last_name: string | null;
          last_display_name: string | null;
        }
      | undefined;
    const user =
      row?.first_id !== null && row?.first_id !== undefined && row.first_name !== null && row.first_display_name !== null
        ? { id: row.first_id, name: row.first_name, displayName: row.first_display_name }
        : null;
    const lastUpdateUser =
      row?.last_id !== null && row?.last_id !== undefined && row.last_name !== null && row.last_display_name !== null
        ? { id: row.last_id, name: row.last_name, displayName: row.last_display_name }
        : null;
    return { user, lastUpdateUser };
  }

  #accountRowToAccount(r: AccountRow): Account {
    return {
      id: r.id,
      actorId: r.actor_id,
      name: r.name,
      email: r.email,
      passwordHash: r.password_hash,
      isAdmin: r.is_admin === 1,
      created: r.created,
    };
  }

  async addAccount(account: NewAccount, now: number): Promise<AddAccountResult> {
    return this.#tx(() => {
      if (this.#db.prepare('SELECT 1 FROM accounts WHERE name = ?').get(account.name) !== undefined) {
        throw new StorageError(`account already exists: ${account.name}`);
      }
      this.#db
        .prepare('INSERT INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?)')
        .run(account.actor.id, account.actor.name, account.actor.displayName, now);
      this.#db
        .prepare(
          `INSERT INTO accounts (id, actor_id, name, email, password_hash, is_admin, created)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          account.id,
          account.actor.id,
          account.name,
          account.email ?? null,
          account.passwordHash,
          account.isAdmin ? 1 : 0,
          now,
        );
      return { accountId: account.id, actorId: account.actor.id };
    });
  }

  async getAccountByName(name: string): Promise<Account | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = this.#db.prepare('SELECT * FROM accounts WHERE name = ?').get(name) as AccountRow | undefined;
    return r ? this.#accountRowToAccount(r) : null;
  }

  async getAccountById(id: string): Promise<Account | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = this.#db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
    return r ? this.#accountRowToAccount(r) : null;
  }

  async createApiToken(token: {
    id: string;
    accountId: string;
    label: string;
    tokenHash: string;
    created: number;
  }): Promise<void> {
    this.#db
      .prepare('INSERT INTO api_tokens (id, account_id, label, token_hash, created) VALUES (?, ?, ?, ?, ?)')
      .run(token.id, token.accountId, token.label, token.tokenHash, token.created);
  }

  async getAccountByApiTokenHash(tokenHash: string): Promise<Account | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare('SELECT a.* FROM accounts a JOIN api_tokens t ON t.account_id = a.id WHERE t.token_hash = ?')
      .get(tokenHash) as AccountRow | undefined;
    return row ? this.#accountRowToAccount(row) : null;
  }

  async listApiTokens(accountId: string): Promise<ApiToken[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare('SELECT id, account_id, label, created FROM api_tokens WHERE account_id = ? ORDER BY created ASC, id ASC')
      .all(accountId) as { id: string; account_id: string; label: string; created: number }[];
    return rows.map((row) => ({ id: row.id, accountId: row.account_id, label: row.label, created: row.created }));
  }

  async deleteApiToken(id: string): Promise<boolean> {
    return this.#db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes > 0;
  }

  async createSession(session: Session): Promise<void> {
    this.#db
      .prepare('INSERT INTO sessions (id, account_id, expires, created) VALUES (?, ?, ?, ?)')
      .run(session.id, session.accountId, session.expires, session.created);
  }

  async getSession(id: string, now: number): Promise<Session | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = this.#db.prepare('SELECT id, account_id, expires, created FROM sessions WHERE id = ?').get(id) as
      | { id: string; account_id: string; expires: number; created: number }
      | undefined;
    if (!r) return null;
    if (r.expires <= now) {
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    return { id: r.id, accountId: r.account_id, expires: r.expires, created: r.created };
  }

  async refreshSession(id: string, expires: number): Promise<void> {
    this.#db.prepare('UPDATE sessions SET expires = ? WHERE id = ?').run(expires, id);
  }

  async deleteSession(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  #createAttachment(attachment: Attachment, claimOwner?: string): void {
    this.#tx(() => {
      this.#ensureActor(attachment.actorId, attachment.created);
      this.#db
        .prepare(
          `INSERT INTO attachments
           (id, project_id, filename, content_type, size, sha256, actor_id, created, provisional)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attachment.id,
          attachment.projectId,
          attachment.filename,
          attachment.contentType,
          attachment.size,
          attachment.sha256,
          attachment.actorId,
          attachment.created,
          claimOwner === undefined ? 0 : 1,
        );
      if (claimOwner !== undefined) {
        this.#db
          .prepare('INSERT INTO attachment_claims (attachment_id, owner) VALUES (?, ?)')
          .run(attachment.id, claimOwner);
      }
    });
  }

  async createAttachment(attachment: Attachment, claimOwner?: string): Promise<void> {
    this.#createAttachment(attachment, claimOwner);
  }

  async tryCreateAttachment(attachment: Attachment, claimOwner?: string): Promise<CreateAttachmentResult> {
    try {
      this.#createAttachment(attachment, claimOwner);
      return { kind: 'created' };
    } catch (error) {
      if (isUniqueConstraint(error)) return { kind: 'conflict' };
      throw error;
    }
  }

  async updateAttachmentMetadata(id: string, filename: string, contentType: string): Promise<void> {
    this.#db.prepare('UPDATE attachments SET filename = ?, content_type = ? WHERE id = ?').run(filename, contentType, id);
  }

  async releaseAttachmentClaims(owner: string): Promise<string[]> {
    return this.#tx(() => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const claims = this.#db
        .prepare('SELECT attachment_id FROM attachment_claims WHERE owner = ?')
        .all(owner) as { attachment_id: string }[];
      this.#db.prepare('DELETE FROM attachment_claims WHERE owner = ?').run(owner);
      const removed: string[] = [];
      const hasClaim = this.#db.prepare('SELECT 1 FROM attachment_claims WHERE attachment_id = ? LIMIT 1');
      const hasReference = this.#db.prepare('SELECT 1 FROM lines WHERE instr(text, ?) > 0 LIMIT 1');
      const remove = this.#db.prepare('DELETE FROM attachments WHERE id = ? AND provisional = 1');
      for (const { attachment_id: id } of claims) {
        if (hasClaim.get(id) !== undefined) continue;
        if (hasReference.get(`/files/${id}`) !== undefined) continue;
        if (remove.run(id).changes > 0) removed.push(id);
      }
      return removed;
    });
  }

  async finalizeAttachmentClaims(owner: string): Promise<void> {
    this.#tx(() => this.#finalizeAttachmentClaims(owner));
  }

  #finalizeAttachmentClaims(owner: string): void {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const claims = this.#db
      .prepare('SELECT attachment_id FROM attachment_claims WHERE owner = ?')
      .all(owner) as { attachment_id: string }[];
    const makePermanent = this.#db.prepare('UPDATE attachments SET provisional = 0 WHERE id = ?');
    const clearClaims = this.#db.prepare('DELETE FROM attachment_claims WHERE attachment_id = ?');
    for (const { attachment_id: id } of claims) {
      makePermanent.run(id);
      clearClaims.run(id);
    }
  }

  #attachmentRowToAttachment(row: AttachmentRow): Attachment {
    return {
      id: row.id,
      projectId: row.project_id,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size,
      sha256: row.sha256,
      actorId: row.actor_id,
      created: row.created,
    };
  }

  async listAttachments(projectId: string): Promise<Attachment[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare('SELECT * FROM attachments WHERE project_id = ? AND provisional = 0 ORDER BY created ASC')
      .all(projectId) as AttachmentRow[];
    return rows.map((row) => this.#attachmentRowToAttachment(row));
  }

  async getAttachment(id: string): Promise<Attachment | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare('SELECT * FROM attachments WHERE id = ? AND provisional = 0')
      .get(id) as AttachmentRow | undefined;
    return row ? this.#attachmentRowToAttachment(row) : null;
  }

  async reuseAttachmentBySha256(
    projectId: string,
    sha256: string,
    claimOwner?: string,
  ): Promise<Attachment | null> {
    return this.#tx(() => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const row = this.#db
        .prepare('SELECT * FROM attachments WHERE project_id = ? AND sha256 = ?')
        .get(projectId, sha256) as AttachmentRow | undefined;
      if (row === undefined) return null;
      if (row.provisional === 1) {
        if (claimOwner === undefined) {
          this.#db.prepare('UPDATE attachments SET provisional = 0 WHERE id = ?').run(row.id);
          this.#db.prepare('DELETE FROM attachment_claims WHERE attachment_id = ?').run(row.id);
        } else {
          this.#db
            .prepare('INSERT OR IGNORE INTO attachment_claims (attachment_id, owner) VALUES (?, ?)')
            .run(row.id, claimOwner);
        }
      }
      return this.#attachmentRowToAttachment(row);
    });
  }

  #pageRowToMeta(r: PageRow): PageMeta {
    return {
      id: r.id,
      projectId: r.project_id,
      title: r.title,
      titleLc: r.title_lc,
      version: r.version,
      pinned: r.pinned,
      deleted: r.deleted === 1,
      image: r.image,
      created: r.created,
      updated: r.updated,
    };
  }

  #getLines(pageId: string): Line[] {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare('SELECT id, text, created, updated, updated_version, actor_id FROM lines WHERE page_id = ? ORDER BY ord')
      .all(pageId) as LineRow[];
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      created: r.created,
      updated: r.updated,
      updatedVersion: r.updated_version,
      userId: r.actor_id,
    }));
  }

  #snapshot(row: PageRow): PageSnapshot {
    return { ...this.#pageRowToMeta(row), lines: this.#getLines(row.id) };
  }

  #pageRepository(): PageRepository {
    return {
      transaction: <T>(operation: (tx: PageTransaction) => T): T => this.#tx(() => operation({
        ensureActor: (actorId, now) => this.#ensureActor(actorId, now),
        getAppliedCommit: (commitId) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const row = this.#db
            .prepare('SELECT version, ops_hash FROM commits WHERE id = ?')
            .get(commitId) as { version: number; ops_hash: string } | undefined;
          return row === undefined ? null : { version: row.version, opsHash: row.ops_hash };
        },
        getPageById: (pageId) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
          return row === undefined ? null : this.#snapshot(row);
        },
        getPageByTitle: (projectId, titleLcValue) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const row = this.#db
            .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0')
            .get(projectId, titleLcValue) as PageRow | undefined;
          return row === undefined ? null : this.#snapshot(row);
        },
        getCurrentTitleStarted: (pageId, fallback) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const row = this.#db
            .prepare('SELECT COALESCE(MAX(ended), ?) AS started FROM title_history WHERE page_id = ?')
            .get(fallback, pageId) as { started: number };
          return row.started;
        },
        pageIdExists: (pageId) => this.#db.prepare('SELECT 1 FROM pages WHERE id = ?').get(pageId) !== undefined,
        listPagesLinkingTo: (projectId, targetTitleLc, excludePageId) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const rows = this.#db
            .prepare(
              `SELECT DISTINCT p.* FROM pages p JOIN links l ON l.source_page_id = p.id
               WHERE l.project_id = ? AND l.target_title_lc = ? AND p.id != ? AND p.deleted = 0`,
            )
            .all(projectId, targetTitleLc, excludePageId) as PageRow[];
          return rows.map((row) => this.#snapshot(row));
        },
        savePageMutation: (mutation) => this.#savePageMutation(mutation),
        finalizeAttachmentClaims: (owner) => this.#finalizeAttachmentClaims(owner),
      })),
    };
  }

  #savePageMutation(mutation: PageMutation): void {
    const { before, after, commit, derived } = mutation;
    if (before === null) {
      this.#db
        .prepare(
          `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          after.id,
          after.projectId,
          after.title,
          after.titleLc,
          after.version,
          after.pinned,
          after.deleted ? 1 : 0,
          derived.image,
          after.created,
          after.updated,
        );
    } else {
      if (mutation.titleHistory !== undefined) {
        const history = mutation.titleHistory;
        this.#db
          .prepare('INSERT INTO title_history (page_id, old_title, old_title_lc, started, ended) VALUES (?, ?, ?, ?, ?)')
          .run(after.id, history.oldTitle, history.oldTitleLc, history.started, history.ended);
      }
      this.#db
        .prepare(
          `UPDATE pages SET title = ?, title_lc = ?, version = ?, pinned = ?, deleted = ?, image = ?, created = ?, updated = ?
           WHERE id = ?`,
        )
        .run(
          after.title,
          after.titleLc,
          after.version,
          after.pinned,
          after.deleted ? 1 : 0,
          derived.image,
          after.created,
          after.updated,
          after.id,
        );
    }
    this.#writeLines(after.id, after.lines);
    this.#db
      .prepare(
        `INSERT INTO commits (id, page_id, base_version, version, actor_id, created, ops, ops_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        commit.id,
        commit.pageId,
        commit.baseVersion,
        commit.version,
        commit.actorId,
        commit.created,
        JSON.stringify(commit.ops),
        commit.opsHash,
      );
    this.#writeDerived(after.projectId, after.id, derived);
  }

  #writeDerived(projectId: string, pageId: string, derived: PageMutation['derived']): void {
    this.#db.prepare('DELETE FROM links WHERE source_page_id = ?').run(pageId);
    this.#db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    this.#db.prepare('UPDATE pages SET image = ? WHERE id = ?').run(derived.image, pageId);
    if (derived.searchText === null) return;
    const insertLink = this.#db.prepare(
      'INSERT OR IGNORE INTO links (project_id, source_page_id, target_title_lc, target_title) VALUES (?, ?, ?, ?)',
    );
    for (const target of derived.links) insertLink.run(projectId, pageId, target.titleLc, target.title);
    this.#db
      .prepare('INSERT INTO pages_fts (page_id, project_id, content) VALUES (?, ?, ?)')
      .run(pageId, projectId, derived.searchText);
  }

  async getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0')
      .get(projectId, titleLcValue) as PageRow | undefined;
    return row ? this.#snapshot(row) : null;
  }

  async getPageById(pageId: string): Promise<PageSnapshot | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
    return row ? this.#snapshot(row) : null;
  }

  async listPages(projectId: string): Promise<PageMeta[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare('SELECT * FROM pages WHERE project_id = ? AND deleted = 0 ORDER BY updated DESC, id')
      .all(projectId) as PageRow[];
    return rows.map((r) => this.#pageRowToMeta(r));
  }

  async listPageSummaries(
    projectId: string,
    opts: ListPageSummariesOptions,
  ): Promise<{ count: number; pages: PageSummary[] }> {
    const orderBy: Record<PageSort, string> = {
      updated: 'p.updated DESC, p.id',
      created: 'p.created DESC, p.id',
      linked: 'linked DESC, p.updated DESC, p.id',
      title: 'p.title_lc ASC',
      views: 'views DESC, p.updated DESC, p.id',
      accessed: 'accessed DESC, p.updated DESC, p.id',
    };
    const orderByClause = opts.pinnedFirst ? `p.pinned DESC, ${orderBy[opts.sort]}` : orderBy[opts.sort];
    const visitSort = opts.sort === 'views' || opts.sort === 'accessed';
    const count = (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      this.#db.prepare('SELECT COUNT(*) AS n FROM pages WHERE project_id = ? AND deleted = 0').get(projectId) as { n: number }
    ).n;
    const rowsSql = visitSort
      ? `SELECT p.*, (
           SELECT COUNT(*) FROM links l WHERE l.project_id = p.project_id AND l.target_title_lc = p.title_lc
         ) AS linked,
         COALESCE((SELECT SUM(pv.views) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS views,
         COALESCE((SELECT MAX(pv.visited) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS accessed
         FROM pages p WHERE p.project_id = ? AND p.deleted = 0
         ORDER BY ${orderByClause}
         LIMIT ? OFFSET ?`
      : opts.sort === 'linked'
        ? `WITH selected AS MATERIALIZED (
             SELECT p.id, p.pinned, p.updated, (
               SELECT COUNT(*) FROM links l WHERE l.project_id = p.project_id AND l.target_title_lc = p.title_lc
             ) AS linked
             FROM pages p WHERE p.project_id = ? AND p.deleted = 0
             ORDER BY ${orderByClause}
             LIMIT ? OFFSET ?
           )
           SELECT p.*, selected.linked,
             COALESCE((SELECT SUM(pv.views) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS views,
             COALESCE((SELECT MAX(pv.visited) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS accessed
           FROM selected JOIN pages p ON p.id = selected.id
           ORDER BY ${opts.pinnedFirst ? 'selected.pinned DESC, ' : ''}selected.linked DESC, selected.updated DESC, selected.id`
        : `WITH selected AS MATERIALIZED (
           SELECT p.id
           FROM pages p WHERE p.project_id = ? AND p.deleted = 0
           ORDER BY ${orderByClause}
           LIMIT ? OFFSET ?
         )
         SELECT p.*, (
             SELECT COUNT(*) FROM links l WHERE l.project_id = p.project_id AND l.target_title_lc = p.title_lc
           ) AS linked,
           COALESCE((SELECT SUM(pv.views) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS views,
           COALESCE((SELECT MAX(pv.visited) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS accessed
         FROM selected JOIN pages p ON p.id = selected.id
         ORDER BY ${orderByClause}`;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare(rowsSql)
      .all(projectId, opts.limit, opts.skip) as (PageRow & PageVisitMetrics & { linked: number })[];
    const descriptions = this.#db.prepare(
      "SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5",
    );
    const pages = rows.map((r) => ({
      ...this.#pageRowToMeta(r),
      linked: r.linked,
      views: r.views,
      accessed: r.accessed,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      descriptions: (descriptions.all(r.id) as { text: string }[]).map((d) => d.text),
    }));
    return { count, pages };
  }

  #relatedDescriptions(pageId: string): string[] {
    return (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      this.#db
        .prepare("SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5")
        .all(pageId) as { text: string }[]
    ).map((r) => r.text);
  }

  #linkedCount(projectId: string, titleLcValue: string): number {
    return (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      this.#db
        .prepare('SELECT COUNT(*) AS n FROM links WHERE project_id = ? AND target_title_lc = ?')
        .get(projectId, titleLcValue) as { n: number }
    ).n;
  }

  #outboundLc(pageId: string): string[] {
    return (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      this.#db.prepare('SELECT target_title_lc FROM links WHERE source_page_id = ?').all(pageId) as {
        target_title_lc: string;
      }[]
    ).map((r) => r.target_title_lc);
  }

  #toRelatedPage(row: PageRow, linksLc: string[]): RelatedPage {
    return {
      id: row.id,
      title: row.title,
      titleLc: row.title_lc,
      image: row.image,
      descriptions: this.#relatedDescriptions(row.id),
      linksLc,
      linked: this.#linkedCount(row.project_id, row.title_lc),
      updated: row.updated,
      accessed: this.#pageVisitMetrics(row.id).accessed,
    };
  }

  async getRelatedPages(projectId: string, pageId: string, titleLcValue: string): Promise<RelatedPages> {
    const targets = this.#outboundLc(pageId);
    const placeholders = targets.map(() => '?').join(', ');

    const forward =
      targets.length === 0
        ? []
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        : (this.#db
            .prepare(
              `SELECT * FROM pages WHERE project_id = ? AND deleted = 0 AND id != ? AND title_lc IN (${placeholders})`,
            )
            .all(projectId, pageId, ...targets) as PageRow[]);

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const back = this.#db
      .prepare(
        `SELECT p.* FROM pages p JOIN links l ON l.source_page_id = p.id
         WHERE l.project_id = ? AND l.target_title_lc = ? AND p.id != ? AND p.deleted = 0`,
      )
      .all(projectId, titleLcValue, pageId) as PageRow[];

    const oneHop = new Map<string, PageRow>();
    for (const row of [...forward, ...back]) oneHop.set(row.id, row);
    const links1hop = [...oneHop.values()].map((row) => this.#toRelatedPage(row, this.#outboundLc(row.id)));

    let links2hop: RelatedPage[] = [];
    if (targets.length > 0) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const rows = this.#db
        .prepare(
          `SELECT p.*, l.target_title_lc AS shared FROM pages p JOIN links l ON l.source_page_id = p.id
           WHERE l.project_id = ? AND l.target_title_lc IN (${placeholders}) AND p.deleted = 0`,
        )
        .all(projectId, ...targets) as (PageRow & { shared: string })[];
      const byPage = new Map<string, { row: PageRow; shared: string[] }>();
      for (const row of rows) {
        if (row.id === pageId || oneHop.has(row.id)) continue;
        const entry = byPage.get(row.id) ?? { row, shared: [] };
        entry.shared.push(row.shared);
        byPage.set(row.id, entry);
      }
      links2hop = [...byPage.values()].map(({ row, shared }) => this.#toRelatedPage(row, shared));
    }

    return {
      links1hop,
      links2hop,
      hasBackLinks: back.length > 0,
      linked: this.#linkedCount(projectId, titleLcValue),
    };
  }

  async listPageTitles(projectId: string): Promise<TitleEntry[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare('SELECT * FROM pages WHERE project_id = ? AND deleted = 0 ORDER BY updated DESC, id')
      .all(projectId) as PageRow[];
    const linksStmt = this.#db.prepare('SELECT target_title FROM links WHERE source_page_id = ?');
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      hasIcon: r.image !== null,
      updated: r.updated,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      links: (linksStmt.all(r.id) as { target_title: string }[]).map((l) => l.target_title),
      image: r.image,
    }));
  }

  async listKnownPages(projectId: string): Promise<{ titleLc: string; title: string; image: string | null }[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare('SELECT title_lc, title, image FROM pages WHERE project_id = ? AND deleted = 0')
      .all(projectId) as { title_lc: string; title: string; image: string | null }[];
    return rows.map((row) => ({ titleLc: row.title_lc, title: row.title, image: row.image }));
  }

  async setPinned(pageId: string, pinned: boolean): Promise<void> {
    this.#db.prepare('UPDATE pages SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, pageId);
  }

  async getVisit(accountId: string, pageId: string): Promise<Visit | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare('SELECT visited, last_seen_version FROM page_visits WHERE account_id = ? AND page_id = ?')
      .get(accountId, pageId) as { visited: number; last_seen_version: number } | undefined;
    return row ? { visited: row.visited, lastSeenVersion: row.last_seen_version } : null;
  }

  #pageVisitMetrics(pageId: string): PageVisitMetrics {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(views), 0) AS views, COALESCE(MAX(visited), 0) AS accessed
         FROM page_visits WHERE page_id = ?`,
      )
      .get(pageId) as PageVisitMetrics;
    return { views: row.views, accessed: row.accessed };
  }

  async getPageVisitMetrics(pageId: string): Promise<PageVisitMetrics> {
    return this.#pageVisitMetrics(pageId);
  }

  async recordVisit(accountId: string, pageId: string, visitedAt: number, lastSeenVersion: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO page_visits (account_id, page_id, visited, last_seen_version) VALUES (?, ?, ?, ?)
         ON CONFLICT (account_id, page_id) DO UPDATE SET
           visited = MAX(page_visits.visited, excluded.visited),
           last_seen_version = MAX(page_visits.last_seen_version, excluded.last_seen_version),
           views = page_visits.views + 1`,
      )
      .run(accountId, pageId, visitedAt, lastSeenVersion);
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    return commitPage(this.#pageRepository(), input);
  }

  async deletePage(projectId: string, pageId: string, actorId: string, now: number): Promise<{ version: number }> {
    return deletePageApplication(this.#pageRepository(), projectId, pageId, actorId, now);
  }

  async renamePage(input: RenameInput): Promise<RenameResult> {
    return renamePageApplication(this.#pageRepository(), input);
  }

  #writeLines(pageId: string, lines: Line[]): void {
    this.#db.prepare('DELETE FROM lines WHERE page_id = ?').run(pageId);
    const st = this.#db.prepare(
      `INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, ord) => {
      st.run(l.id, pageId, ord, l.text, l.created, l.updated, l.updatedVersion, l.userId);
    });
  }

  async importPage(input: ImportPageInput): Promise<ImportPageResult> {
    return importPageApplication(this.#pageRepository(), input);
  }

  async search(projectId: string, query: SearchQuery): Promise<SearchHit[]> {
    if (query.words.includes('')) return [];
    const words = [...new Set(query.words)];
    const excludes = [...new Set(query.excludes)];
    const pagesByTerm = new Map<string, { id: string; title: string; image: string | null }[]>();
    const searchTerm = (term: string) => {
      const cached = pagesByTerm.get(term);
      if (cached !== undefined) return cached;
      const pages = this.#searchTerm(projectId, term);
      pagesByTerm.set(term, pages);
      return pages;
    };
    const firstWord = words[0];
    if (firstWord === undefined) return [];
    const pages = searchTerm(firstWord);
    const requiredPageIds = words.slice(1).map((word) =>
      new Set(searchTerm(word).map((page) => page.id)));
    const excludedPageIds = new Set(excludes.flatMap((word) =>
      searchTerm(word).map((page) => page.id)));
    const filtered = pages.filter((page) =>
      requiredPageIds.every((ids) => ids.has(page.id)) && !excludedPageIds.has(page.id));
    const likePatterns = words.map((word) => `%${escapeLike(word)}%`);
    const matchedLines = this.#db.prepare(
      `SELECT text FROM lines WHERE page_id = ? AND (${words.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ')})
       ORDER BY ord`,
    );
    return filtered.map((p) => ({
      pageId: p.id,
      title: p.title,
      image: p.image,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      lines: (matchedLines.all(p.id, ...likePatterns) as { text: string }[]).map((r) => r.text),
    }));
  }

  #searchTerm(projectId: string, query: string): { id: string; title: string; image: string | null }[] {
    // 検索語の長さは code point 数で判定する（絵文字を分割するのは承知のうえ。
    // 書記素単位が要るほどの精度は下限判定に不要）
    // oxlint-disable-next-line typescript/no-misused-spread
    return [...query].length >= 3 ? this.#searchFts(projectId, query) : this.#searchLike(projectId, query);
  }

  #searchFts(projectId: string, query: string): { id: string; title: string; image: string | null }[] {
    const phrase = `"${query.replaceAll('"', '""')}"`;
    // FTS5 の MATCH はテーブル別名を受け付けない（実測）。JOIN でも pages_fts に別名を付けず、
    // 実名のまま `pages_fts MATCH ?` と書く。
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return this.#db
      .prepare(
        `SELECT p.id, p.title, p.image FROM pages_fts JOIN pages p ON p.id = pages_fts.page_id
         WHERE pages_fts MATCH ? AND pages_fts.project_id = ? AND p.deleted = 0
         ORDER BY pages_fts.rank`,
      )
      .all(phrase, projectId) as { id: string; title: string; image: string | null }[];
  }

  #searchLike(projectId: string, query: string): { id: string; title: string; image: string | null }[] {
    const pattern = `%${escapeLike(query)}%`;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return this.#db
      .prepare(
        `SELECT DISTINCT p.id, p.title, p.image, p.updated FROM pages p JOIN lines l ON l.page_id = p.id
         WHERE p.project_id = ? AND p.deleted = 0 AND l.text LIKE ? ESCAPE '\\'
         ORDER BY p.updated DESC`,
      )
      .all(projectId, pattern) as { id: string; title: string; image: string | null }[];
  }

  async reindex(projectId?: string): Promise<{ pages: number }> {
    return this.#tx(() => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const rows = (
        projectId === undefined
          ? this.#db.prepare('SELECT * FROM pages').all()
          : this.#db.prepare('SELECT * FROM pages WHERE project_id = ?').all(projectId)
      ) as PageRow[];
      for (const row of rows) {
        const lines = this.#getLines(row.id);
        this.#writeDerived(row.project_id, row.id, derivePageData(lines, row.deleted === 1));
      }
      return { pages: rows.length };
    });
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
