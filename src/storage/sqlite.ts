import { DatabaseSync } from 'node:sqlite';
import { OpsError, type Line, type LineOp } from '../core/ops.ts';
import { applyOps } from '../core/apply.ts';
import { extractRefs, rewritePageLinks } from '../core/links.ts';
import { titleLc } from '../core/title.ts';
import { ulid } from '../core/id.ts';
import type { SearchQuery } from '../core/searchQuery.ts';
import { opsHash } from './hash.ts';
import { validateImportLines } from './importValidation.ts';
import {
  BadCommitError,
  StorageError,
  type AddUserResult,
  type ApiToken,
  type Attachment,
  type AuthUser,
  type CommitInput,
  type CommitResult,
  type DisplayUser,
  type ImportLine,
  type ImportPageInput,
  type ImportPageResult,
  type ListPageSummariesOptions,
  type NewUser,
  type PageMeta,
  type PageSort,
  type PageSnapshot,
  type PageSummary,
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
const RESERVED_PROJECT_NAMES = new Set(['api', 'login', 'files', 'assets']);

type UserRow = {
  id: string;
  name: string;
  display_name: string;
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
  user_id: string;
};

type AttachmentRow = {
  id: string;
  project_id: string;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  user_id: string;
  created: number;
  provisional: number;
};

function escapeLike(s: string): string {
  return s.replaceAll(/[\\%_]/g, (m) => `\\${m}`);
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

  #getProjectRow(name: string): Project | null {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = this.#db
      .prepare('SELECT id, name, display_name, created, updated FROM projects WHERE name = ?')
      .get(name) as { id: string; name: string; display_name: string; created: number; updated: number } | undefined;
    return r ? { id: r.id, name: r.name, displayName: r.display_name, created: r.created, updated: r.updated } : null;
  }

  async ensureProject(name: string, now: number): Promise<Project> {
    if (!PROJECT_NAME_RE.test(name) || RESERVED_PROJECT_NAMES.has(name)) {
      throw new StorageError(`invalid project name: ${name}`);
    }
    return this.#tx(() => {
      const existing = this.#getProjectRow(name);
      if (existing) return existing;
      const id = ulid(now * 1000);
      this.#db
        .prepare('INSERT INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, name, now, now);
      return { id, name, displayName: name, created: now, updated: now };
    });
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

  async upsertDisplayUser(user: DisplayUser, now: number): Promise<string> {
    this.#db
      .prepare('INSERT OR IGNORE INTO users (id, name, display_name, created) VALUES (?, ?, ?, ?)')
      .run(user.id, user.name, user.displayName, now);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db.prepare('SELECT id FROM users WHERE name = ?').get(user.name) as
      | { id: string }
      | undefined;
    return row ? row.id : user.id;
  }

  async listUsersForProject(projectId: string): Promise<DisplayUser[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare(
        `SELECT u.id, u.name, u.display_name FROM users u
         WHERE u.id IN (
           SELECT l.user_id FROM lines l JOIN pages p ON p.id = l.page_id WHERE p.project_id = ?
           UNION
           SELECT c.user_id FROM commits c JOIN pages p ON p.id = c.page_id WHERE p.project_id = ?
         )
         ORDER BY u.name`,
      )
      .all(projectId, projectId) as { id: string; name: string; display_name: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, displayName: r.display_name }));
  }

  async getPageAuthors(
    pageId: string,
  ): Promise<{ user: DisplayUser | null; lastUpdateUser: DisplayUser | null }> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare(
        `WITH first_commit AS (
           SELECT user_id FROM commits WHERE page_id = ? ORDER BY version ASC LIMIT 1
         ), last_commit AS (
           SELECT user_id FROM commits WHERE page_id = ? ORDER BY version DESC LIMIT 1
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
         LEFT JOIN users first_user ON first_user.id = first_commit.user_id
         LEFT JOIN users last_user ON last_user.id = last_commit.user_id`,
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

  #userRowToAuthUser(r: UserRow): AuthUser {
    return {
      id: r.id,
      name: r.name,
      displayName: r.display_name,
      email: r.email,
      passwordHash: r.password_hash,
      isAdmin: r.is_admin === 1,
      created: r.created,
    };
  }

  async addUser(user: NewUser, now: number): Promise<AddUserResult> {
    return this.#tx(() => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const existing = this.#db
        .prepare('SELECT id, password_hash FROM users WHERE name = ?')
        .get(user.name) as { id: string; password_hash: string | null } | undefined;
      if (existing) {
        if (existing.password_hash !== null) {
          throw new StorageError(`user already exists: ${user.name}`);
        }
        this.#db
          .prepare('UPDATE users SET display_name = ?, email = ?, password_hash = ?, is_admin = ? WHERE id = ?')
          .run(user.displayName, user.email ?? null, user.passwordHash, user.isAdmin ? 1 : 0, existing.id);
        return { kind: 'claimed' as const, id: existing.id };
      }
      this.#db
        .prepare(
          'INSERT INTO users (id, name, display_name, email, password_hash, is_admin, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(user.id, user.name, user.displayName, user.email ?? null, user.passwordHash, user.isAdmin ? 1 : 0, now);
      return { kind: 'created' as const, id: user.id };
    });
  }

  async getUserByName(name: string): Promise<AuthUser | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = this.#db.prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
    return r ? this.#userRowToAuthUser(r) : null;
  }

  async getUserById(id: string): Promise<AuthUser | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? this.#userRowToAuthUser(r) : null;
  }

  async createApiToken(token: {
    id: string;
    userId: string;
    label: string;
    tokenHash: string;
    created: number;
  }): Promise<void> {
    this.#db
      .prepare('INSERT INTO api_tokens (id, user_id, label, token_hash, created) VALUES (?, ?, ?, ?, ?)')
      .run(token.id, token.userId, token.label, token.tokenHash, token.created);
  }

  async getUserByApiTokenHash(tokenHash: string): Promise<AuthUser | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare('SELECT u.* FROM users u JOIN api_tokens t ON t.user_id = u.id WHERE t.token_hash = ?')
      .get(tokenHash) as UserRow | undefined;
    return row ? this.#userRowToAuthUser(row) : null;
  }

  async listApiTokens(userId: string): Promise<ApiToken[]> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare('SELECT id, user_id, label, created FROM api_tokens WHERE user_id = ? ORDER BY created ASC, id ASC')
      .all(userId) as { id: string; user_id: string; label: string; created: number }[];
    return rows.map((row) => ({ id: row.id, userId: row.user_id, label: row.label, created: row.created }));
  }

  async deleteApiToken(id: string): Promise<boolean> {
    return this.#db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes > 0;
  }

  async createSession(session: Session): Promise<void> {
    this.#db
      .prepare('INSERT INTO sessions (id, user_id, expires, created) VALUES (?, ?, ?, ?)')
      .run(session.id, session.userId, session.expires, session.created);
  }

  async getSession(id: string, now: number): Promise<Session | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const r = this.#db.prepare('SELECT id, user_id, expires, created FROM sessions WHERE id = ?').get(id) as
      | { id: string; user_id: string; expires: number; created: number }
      | undefined;
    if (!r) return null;
    if (r.expires <= now) {
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    return { id: r.id, userId: r.user_id, expires: r.expires, created: r.created };
  }

  async refreshSession(id: string, expires: number): Promise<void> {
    this.#db.prepare('UPDATE sessions SET expires = ? WHERE id = ?').run(expires, id);
  }

  async deleteSession(id: string): Promise<void> {
    this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  async createAttachment(attachment: Attachment, claimOwner?: string): Promise<void> {
    this.#tx(() => {
      this.#db
        .prepare(
          `INSERT INTO attachments
           (id, project_id, filename, content_type, size, sha256, user_id, created, provisional)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          attachment.id,
          attachment.projectId,
          attachment.filename,
          attachment.contentType,
          attachment.size,
          attachment.sha256,
          attachment.userId,
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

  #attachmentRowToAttachment(row: AttachmentRow): Attachment {
    return {
      id: row.id,
      projectId: row.project_id,
      filename: row.filename,
      contentType: row.content_type,
      size: row.size,
      sha256: row.sha256,
      userId: row.user_id,
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
      .prepare('SELECT id, text, created, updated, updated_version, user_id FROM lines WHERE page_id = ? ORDER BY ord')
      .all(pageId) as LineRow[];
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      created: r.created,
      updated: r.updated,
      updatedVersion: r.updated_version,
      userId: r.user_id,
    }));
  }

  #snapshot(row: PageRow): PageSnapshot {
    return { ...this.#pageRowToMeta(row), lines: this.#getLines(row.id) };
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
    };
    const orderByClause = opts.pinnedFirst ? `p.pinned DESC, ${orderBy[opts.sort]}` : orderBy[opts.sort];
    const count = (
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      this.#db.prepare('SELECT COUNT(*) AS n FROM pages WHERE project_id = ? AND deleted = 0').get(projectId) as { n: number }
    ).n;
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const rows = this.#db
      .prepare(
        `SELECT p.*, (
           SELECT COUNT(*) FROM links l WHERE l.project_id = p.project_id AND l.target_title_lc = p.title_lc
         ) AS linked
         FROM pages p WHERE p.project_id = ? AND p.deleted = 0
         ORDER BY ${orderByClause}
         LIMIT ? OFFSET ?`,
      )
      .all(projectId, opts.limit, opts.skip) as (PageRow & { linked: number })[];
    const descriptions = this.#db.prepare(
      "SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5",
    );
    const pages = rows.map((r) => ({
      ...this.#pageRowToMeta(r),
      linked: r.linked,
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

  async getVisit(userId: string, pageId: string): Promise<Visit | null> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db
      .prepare('SELECT visited, last_seen_version FROM page_visits WHERE user_id = ? AND page_id = ?')
      .get(userId, pageId) as { visited: number; last_seen_version: number } | undefined;
    return row ? { visited: row.visited, lastSeenVersion: row.last_seen_version } : null;
  }

  async recordVisit(userId: string, pageId: string, visitedAt: number, lastSeenVersion: number): Promise<void> {
    this.#db
      .prepare(
        `INSERT INTO page_visits (user_id, page_id, visited, last_seen_version) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, page_id) DO UPDATE SET
           visited = MAX(page_visits.visited, excluded.visited),
           last_seen_version = MAX(page_visits.last_seen_version, excluded.last_seen_version)`,
      )
      .run(userId, pageId, visitedAt, lastSeenVersion);
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    return this.#tx(() => this.#applyCommit(input));
  }

  async deletePage(projectId: string, pageId: string, userId: string, now: number): Promise<{ version: number }> {
    return this.#tx(() => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
      if (!row || row.deleted === 1) throw new BadCommitError(`unknown page: ${pageId}`);
      if (row.project_id !== projectId) throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
      const ops: LineOp[] = this.#getLines(pageId).map((l) => ({ type: 'delete' as const, id: l.id }));
      const result = this.#applyCommit({
        projectId, pageId, commitId: ulid(now * 1000), baseVersion: row.version, ops, userId, now,
      });
      if (result.kind !== 'applied') throw new StorageError('unexpected conflict in deletePage');
      return { version: result.version };
    });
  }

  async renamePage(input: RenameInput): Promise<RenameResult> {
    const { projectId, pageId, baseVersion, newTitle, rewriteLinks, userId, now } = input;
    return this.#tx(() => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
      if (!row || row.deleted === 1) throw new BadCommitError(`unknown page: ${pageId}`);
      if (row.project_id !== projectId) throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
      if (newTitle === '') throw new BadCommitError('title must not be empty');
      if (newTitle === row.title) throw new BadCommitError('title is unchanged');
      if (baseVersion !== row.version) {
        return { kind: 'conflict' as const, reason: 'version' as const, page: this.#snapshot(row) };
      }
      const oldTitleLc = row.title_lc;

      // 未削除ページであることを上で確認済み。未削除なら 1 行以上あることをコミットが保証する。
      const lines = this.#getLines(pageId);
      const titleCommit = this.#applyCommit({
        projectId, pageId, commitId: ulid(now * 1000), baseVersion,
        ops: [{ type: 'update', id: lines[0]!.id, text: newTitle }], userId, now,
      });
      if (titleCommit.kind === 'conflict') {
        return { kind: 'conflict' as const, reason: 'title' as const, page: titleCommit.page };
      }

      const rewritten: { pageId: string; title: string; version: number }[] = [];
      if (rewriteLinks && titleLc(newTitle) !== oldTitleLc) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const sources = this.#db
          .prepare(
            `SELECT DISTINCT p.id FROM pages p JOIN links l ON l.source_page_id = p.id
             WHERE l.project_id = ? AND l.target_title_lc = ? AND p.id != ? AND p.deleted = 0`,
          )
          .all(projectId, oldTitleLc, pageId) as { id: string }[];
        for (const source of sources) {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const srcRow = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(source.id) as PageRow;
          const srcLines = this.#getLines(source.id);
          const changes = rewritePageLinks(srcLines.map((l) => l.text), oldTitleLc, newTitle);
          const ops: LineOp[] = [];
          // changes は srcLines を map した結果なので添字が対応する。
          changes.forEach((text, i) => {
            if (text !== null) ops.push({ type: 'update', id: srcLines[i]!.id, text });
          });
          if (ops.length === 0) continue;
          const result = this.#applyCommit({
            projectId, pageId: source.id, commitId: ulid(now * 1000), baseVersion: srcRow.version, ops, userId, now,
          });
          if (result.kind !== 'applied') {
            throw new StorageError(`link rewrite conflict on page ${source.id}`);
          }
          rewritten.push({ pageId: source.id, title: srcRow.title, version: result.version });
        }
      }
      return { kind: 'applied' as const, version: titleCommit.version, rewritten };
    });
  }

  #applyCommit(input: CommitInput): CommitResult {
    const { projectId, pageId, commitId, baseVersion, ops, userId, now } = input;

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const prior = this.#db
      .prepare('SELECT version, ops_hash FROM commits WHERE id = ?')
      .get(commitId) as { version: number; ops_hash: string } | undefined;
    if (prior) {
      if (prior.ops_hash !== opsHash(pageId, baseVersion, ops)) {
        throw new BadCommitError(`commit ${commitId} was already applied with different content`);
      }
      return { kind: 'applied', version: prior.version };
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
    if (!row && baseVersion !== 0) throw new BadCommitError(`unknown page: ${pageId}`);
    if (row && row.project_id !== projectId) {
      throw new BadCommitError(`page ${pageId} is not in project ${projectId}`);
    }
    if (row && row.deleted === 1) throw new BadCommitError(`page ${pageId} is deleted`);
    if (row && baseVersion !== row.version) {
      return { kind: 'conflict', reason: 'version', page: this.#snapshot(row) };
    }

    const currentLines = row ? this.#getLines(pageId) : [];
    const version = baseVersion + 1;
    let newLines: Line[];
    try {
      newLines = applyOps(currentLines, ops, { userId, now, version });
    } catch (e) {
      if (e instanceof OpsError) throw new BadCommitError(e.message);
      throw e;
    }

    const deleted = newLines.length === 0;
    // 新規作成はタイトル行が残る最初のコミットでなければならない（スペック「行操作とコミット」）
    if (!row && deleted) throw new BadCommitError('page creation must leave at least one line');
    // deleted が false なので newLines は 1 行以上ある。
    const newTitle = deleted ? (row ? row.title : '') : newLines[0]!.text;
    const newTitleLc = titleLc(newTitle);

    if (!deleted && (!row || newTitleLc !== row.title_lc)) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const clash = this.#db
        .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0 AND id != ?')
        .get(projectId, newTitleLc, pageId) as PageRow | undefined;
      if (clash) return { kind: 'conflict', reason: 'title', page: this.#snapshot(clash) };
    }

    if (!row) {
      this.#db
        .prepare(
          `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
           VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, ?)`,
        )
        .run(pageId, projectId, newTitle, newTitleLc, version, deleted ? 1 : 0, now, now);
    } else {
      if (!deleted && newTitle !== row.title) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const started = this.#db
          .prepare('SELECT COALESCE(MAX(ended), ?) AS s FROM title_history WHERE page_id = ?')
          .get(row.created, pageId) as { s: number };
        this.#db
          .prepare('INSERT INTO title_history (page_id, old_title, old_title_lc, started, ended) VALUES (?, ?, ?, ?, ?)')
          .run(pageId, row.title, row.title_lc, started.s, now);
      }
      this.#db
        .prepare('UPDATE pages SET title = ?, title_lc = ?, version = ?, deleted = ?, updated = ? WHERE id = ?')
        .run(newTitle, newTitleLc, version, deleted ? 1 : 0, now, pageId);
    }

    this.#writeLines(pageId, newLines);
    this.#insertCommit(commitId, pageId, baseVersion, version, userId, now, ops);
    this.#updateDerived(projectId, pageId, newLines, deleted);
    return { kind: 'applied', version };
  }

  #updateDerived(projectId: string, pageId: string, lines: Line[], deleted: boolean): void {
    this.#db.prepare('DELETE FROM links WHERE source_page_id = ?').run(pageId);
    this.#db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    if (deleted) {
      this.#db.prepare('UPDATE pages SET image = NULL WHERE id = ?').run(pageId);
      return;
    }
    const text = lines.map((l) => l.text).join('\n');
    const refs = extractRefs(text);
    const insertLink = this.#db.prepare(
      'INSERT OR IGNORE INTO links (project_id, source_page_id, target_title_lc, target_title) VALUES (?, ?, ?, ?)',
    );
    for (const target of refs.linkTargets) insertLink.run(projectId, pageId, target.titleLc, target.title);
    this.#db.prepare('UPDATE pages SET image = ? WHERE id = ?').run(refs.image, pageId);
    this.#db
      .prepare('INSERT INTO pages_fts (page_id, project_id, content) VALUES (?, ?, ?)')
      .run(pageId, projectId, text);
  }

  #writeLines(pageId: string, lines: Line[]): void {
    this.#db.prepare('DELETE FROM lines WHERE page_id = ?').run(pageId);
    const st = this.#db.prepare(
      `INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, ord) => {
      st.run(l.id, pageId, ord, l.text, l.created, l.updated, l.updatedVersion, l.userId);
    });
  }

  #insertCommit(
    commitId: string,
    pageId: string,
    baseVersion: number,
    version: number,
    userId: string,
    now: number,
    ops: LineOp[],
  ): void {
    this.#db
      .prepare(
        `INSERT INTO commits (id, page_id, base_version, version, user_id, created, ops, ops_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(commitId, pageId, baseVersion, version, userId, now, JSON.stringify(ops), opsHash(pageId, baseVersion, ops));
  }

  async importPage(input: ImportPageInput): Promise<ImportPageResult> {
    return this.#tx(() => {
      const { projectId, page, lines, userId, now, onConflict } = input;
      validateImportLines(page.title, lines);
      const lcValue = titleLc(page.title);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const existing = this.#db
        .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0')
        .get(projectId, lcValue) as PageRow | undefined;

      if (existing && onConflict === 'skip') return { kind: 'skipped' as const, pageId: existing.id };

      // i === 0 を先に分岐しているので lines[i - 1] は範囲内。
      const insertOps: LineOp[] = lines.map((l, i) => ({
        type: 'insert' as const,
        id: l.id,
        after: i === 0 ? '_head' : lines[i - 1]!.id,
        text: l.text,
      }));

      if (existing) {
        const deleteOps: LineOp[] = this.#getLines(existing.id).map((l) => ({ type: 'delete' as const, id: l.id }));
        const version = existing.version + 1;
        this.#writeImportedLines(existing.id, lines, version);
        this.#db
          .prepare('UPDATE pages SET title = ?, version = ?, created = ?, updated = ? WHERE id = ?')
          .run(page.title, version, page.created, page.updated, existing.id);
        this.#insertCommit(ulid(now * 1000), existing.id, existing.version, version, userId, now, [
          ...deleteOps,
          ...insertOps,
        ]);
        this.#updateDerived(projectId, existing.id, this.#getLines(existing.id), false);
        if (input.attachmentClaimOwner !== undefined) this.#finalizeAttachmentClaims(input.attachmentClaimOwner);
        return { kind: 'overwritten' as const, pageId: existing.id };
      }

      const idTaken = this.#db.prepare('SELECT 1 AS x FROM pages WHERE id = ?').get(page.id) !== undefined;
      const pageId = idTaken ? ulid(now * 1000) : page.id;
      this.#db
        .prepare(
          `INSERT INTO pages (id, project_id, title, title_lc, version, pinned, deleted, image, created, updated)
           VALUES (?, ?, ?, ?, 1, 0, 0, NULL, ?, ?)`,
        )
        .run(pageId, projectId, page.title, lcValue, page.created, page.updated);
      this.#writeImportedLines(pageId, lines, 1);
      this.#insertCommit(ulid(now * 1000), pageId, 0, 1, userId, now, insertOps);
      this.#updateDerived(projectId, pageId, this.#getLines(pageId), false);
      if (input.attachmentClaimOwner !== undefined) this.#finalizeAttachmentClaims(input.attachmentClaimOwner);
      return { kind: 'created' as const, pageId };
    });
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

  #writeImportedLines(pageId: string, lines: ImportLine[], version: number): void {
    this.#db.prepare('DELETE FROM lines WHERE page_id = ?').run(pageId);
    const st = this.#db.prepare(
      `INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, ord) => st.run(l.id, pageId, ord, l.text, l.created, l.updated, version, l.userId));
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
        this.#updateDerived(row.project_id, row.id, this.#getLines(row.id), row.deleted === 1);
      }
      return { pages: rows.length };
    });
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
