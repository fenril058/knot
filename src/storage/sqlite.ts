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
  type CommitInput,
  type CommitResult,
  type DisplayUser,
  type ImportPageInput,
  type ImportPageResult,
  type PageMeta,
  type PageSnapshot,
  type Project,
  type SearchHit,
  type Storage,
} from './types.ts';

const PROJECT_NAME_RE = /^[a-z0-9-]+$/;
const RESERVED_PROJECT_NAMES = new Set(['api', 'login', 'files', 'assets']);

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
        `SELECT DISTINCT u.id, u.name, u.display_name FROM users u
         JOIN lines l ON l.user_id = u.id
         JOIN pages p ON p.id = l.page_id
         WHERE p.project_id = ?
         ORDER BY u.name`,
      )
      .all(projectId) as { id: string; name: string; display_name: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, displayName: r.display_name }));
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
      'INSERT OR IGNORE INTO links (project_id, source_page_id, target_title_lc) VALUES (?, ?, ?)',
    );
    for (const target of refs.linkTargets) insertLink.run(projectId, pageId, target);
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

  async importPage(_input: ImportPageInput): Promise<ImportPageResult> {
    throw new Error('not implemented: importPage (Task 8)');
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

  async reindex(_projectId?: string): Promise<{ pages: number }> {
    throw new Error('not implemented: reindex (Task 7)');
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
