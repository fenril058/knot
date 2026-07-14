import { DatabaseSync } from 'node:sqlite';
import { OpsError, type Line, type LineOp } from '../core/ops.ts';
import { applyOps } from '../core/apply.ts';
import { extractRefs } from '../core/links.ts';
import { titleLc } from '../core/title.ts';
import { ulid } from '../core/id.ts';
import { opsHash } from './hash.ts';
import {
  BadCommitError,
  StorageError,
  type AddUserResult,
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
  type SearchHit,
  type Session,
  type Storage,
  type TitleEntry,
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

  async setProjectDisplayName(projectId: string, displayName: string, now: number): Promise<void> {
    this.#db
      .prepare('UPDATE projects SET display_name = ?, updated = ? WHERE id = ?')
      .run(displayName, now, projectId);
  }

  async upsertDisplayUser(user: DisplayUser, now: number): Promise<string> {
    this.#db
      .prepare('INSERT OR IGNORE INTO users (id, name, display_name, created) VALUES (?, ?, ?, ?)')
      .run(user.id, user.name, user.displayName, now);
    const row = this.#db.prepare('SELECT id FROM users WHERE name = ?').get(user.name) as
      | { id: string }
      | undefined;
    return row ? row.id : user.id;
  }

  async listUsersForProject(projectId: string): Promise<DisplayUser[]> {
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
    const r = this.#db.prepare('SELECT * FROM users WHERE name = ?').get(name) as UserRow | undefined;
    return r ? this.#userRowToAuthUser(r) : null;
  }

  async getUserById(id: string): Promise<AuthUser | null> {
    const r = this.#db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? this.#userRowToAuthUser(r) : null;
  }

  async createSession(session: Session): Promise<void> {
    this.#db
      .prepare('INSERT INTO sessions (id, user_id, expires, created) VALUES (?, ?, ?, ?)')
      .run(session.id, session.userId, session.expires, session.created);
  }

  async getSession(id: string, now: number): Promise<Session | null> {
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
    const row = this.#db
      .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0')
      .get(projectId, titleLcValue) as PageRow | undefined;
    return row ? this.#snapshot(row) : null;
  }

  async getPageById(pageId: string): Promise<PageSnapshot | null> {
    const row = this.#db.prepare('SELECT * FROM pages WHERE id = ?').get(pageId) as PageRow | undefined;
    return row ? this.#snapshot(row) : null;
  }

  async listPages(projectId: string): Promise<PageMeta[]> {
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
    const count = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM pages WHERE project_id = ? AND deleted = 0').get(projectId) as { n: number }
    ).n;
    const rows = this.#db
      .prepare(
        `SELECT p.*, (
           SELECT COUNT(*) FROM links l WHERE l.project_id = p.project_id AND l.target_title_lc = p.title_lc
         ) AS linked
         FROM pages p WHERE p.project_id = ? AND p.deleted = 0
         ORDER BY ${orderBy[opts.sort]}
         LIMIT ? OFFSET ?`,
      )
      .all(projectId, opts.limit, opts.skip) as (PageRow & { linked: number })[];
    const descriptions = this.#db.prepare(
      "SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5",
    );
    const pages = rows.map((r) => ({
      ...this.#pageRowToMeta(r),
      linked: r.linked,
      descriptions: (descriptions.all(r.id) as { text: string }[]).map((d) => d.text),
    }));
    return { count, pages };
  }

  #relatedDescriptions(pageId: string): string[] {
    return (
      this.#db
        .prepare("SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5")
        .all(pageId) as { text: string }[]
    ).map((r) => r.text);
  }

  #linkedCount(projectId: string, titleLcValue: string): number {
    return (
      this.#db
        .prepare('SELECT COUNT(*) AS n FROM links WHERE project_id = ? AND target_title_lc = ?')
        .get(projectId, titleLcValue) as { n: number }
    ).n;
  }

  #outboundLc(pageId: string): string[] {
    return (
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
        : (this.#db
            .prepare(
              `SELECT * FROM pages WHERE project_id = ? AND deleted = 0 AND id != ? AND title_lc IN (${placeholders})`,
            )
            .all(projectId, pageId, ...targets) as PageRow[]);

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
    const rows = this.#db
      .prepare('SELECT * FROM pages WHERE project_id = ? AND deleted = 0 ORDER BY updated DESC, id')
      .all(projectId) as PageRow[];
    const linksStmt = this.#db.prepare('SELECT target_title FROM links WHERE source_page_id = ?');
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      hasIcon: r.image !== null,
      updated: r.updated,
      links: (linksStmt.all(r.id) as { target_title: string }[]).map((l) => l.target_title),
    }));
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    return this.#tx(() => this.#applyCommit(input));
  }

  #applyCommit(input: CommitInput): CommitResult {
    const { projectId, pageId, commitId, baseVersion, ops, userId, now } = input;

    const prior = this.#db
      .prepare('SELECT version, ops_hash FROM commits WHERE id = ?')
      .get(commitId) as { version: number; ops_hash: string } | undefined;
    if (prior) {
      if (prior.ops_hash !== opsHash(pageId, baseVersion, ops)) {
        throw new BadCommitError(`commit ${commitId} was already applied with different content`);
      }
      return { kind: 'applied', version: prior.version };
    }

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
    const newTitle = deleted ? (row ? row.title : '') : newLines[0].text;
    const newTitleLc = titleLc(newTitle);

    if (!deleted && (!row || newTitleLc !== row.title_lc)) {
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
      if (lines.length === 0) throw new StorageError(`page "${page.title}" has no lines`);
      const seen = new Set<string>();
      for (const line of lines) {
        if (seen.has(line.id)) throw new StorageError(`duplicate line id in page "${page.title}": ${line.id}`);
        seen.add(line.id);
      }
      const lcValue = titleLc(page.title);
      const existing = this.#db
        .prepare('SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0')
        .get(projectId, lcValue) as PageRow | undefined;

      if (existing && onConflict === 'skip') return { kind: 'skipped' as const, pageId: existing.id };

      const insertOps: LineOp[] = lines.map((l, i) => ({
        type: 'insert' as const,
        id: l.id,
        after: i === 0 ? '_head' : lines[i - 1].id,
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
      return { kind: 'created' as const, pageId };
    });
  }

  #writeImportedLines(pageId: string, lines: ImportLine[], version: number): void {
    this.#db.prepare('DELETE FROM lines WHERE page_id = ?').run(pageId);
    const st = this.#db.prepare(
      `INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    lines.forEach((l, ord) => st.run(l.id, pageId, ord, l.text, l.created, l.updated, version, l.userId));
  }

  async search(projectId: string, query: string): Promise<SearchHit[]> {
    if (query === '') return [];
    const pages =
      [...query].length >= 3 ? this.#searchFts(projectId, query) : this.#searchLike(projectId, query);
    const likePattern = `%${escapeLike(query)}%`;
    const matchedLines = this.#db.prepare(
      `SELECT text FROM lines WHERE page_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY ord`,
    );
    return pages.map((p) => ({
      pageId: p.id,
      title: p.title,
      lines: (matchedLines.all(p.id, likePattern) as { text: string }[]).map((r) => r.text),
    }));
  }

  #searchFts(projectId: string, query: string): { id: string; title: string }[] {
    const phrase = `"${query.replaceAll('"', '""')}"`;
    return this.#db
      .prepare(
        `SELECT p.id, p.title FROM pages_fts JOIN pages p ON p.id = pages_fts.page_id
         WHERE pages_fts MATCH ? AND pages_fts.project_id = ? AND p.deleted = 0
         ORDER BY pages_fts.rank`,
      )
      .all(phrase, projectId) as { id: string; title: string }[];
  }

  #searchLike(projectId: string, query: string): { id: string; title: string }[] {
    const pattern = `%${escapeLike(query)}%`;
    return this.#db
      .prepare(
        `SELECT DISTINCT p.id, p.title, p.updated FROM pages p JOIN lines l ON l.page_id = p.id
         WHERE p.project_id = ? AND p.deleted = 0 AND l.text LIKE ? ESCAPE '\\'
         ORDER BY p.updated DESC`,
      )
      .all(projectId, pattern) as { id: string; title: string }[];
  }

  async reindex(projectId?: string): Promise<{ pages: number }> {
    return this.#tx(() => {
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
