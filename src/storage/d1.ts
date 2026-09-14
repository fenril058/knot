import { ulid } from '../core/id.ts';
import type { Line } from '../core/ops.ts';
import type { SearchQuery } from '../core/searchQuery.ts';
import {
  StorageError,
  UnsupportedStorageOperationError,
  type Account,
  type Actor,
  type AddAccountResult,
  type ApiToken,
  type Attachment,
  type CommitInput,
  type CommitResult,
  type CreateAttachmentResult,
  type CreateProjectResult,
  type DeleteInput,
  type DeleteResult,
  type ImportPageInput,
  type ImportPageResult,
  type ListPageSummariesOptions,
  type NewAccount,
  type PageMeta,
  type PageSnapshot,
  type PageSummary,
  type PageVisitMetrics,
  type Project,
  type RelatedPage,
  type RelatedPages,
  type RenameInput,
  type RenameResult,
  type ReplacePageTextInput,
  type ReplacePageTextResult,
  type SearchHit,
  type Session,
  type Storage,
  type TitleEntry,
  type Visit,
} from './types.ts';

type QueryResult<T> = { results: T[]; meta: { changes?: number } };

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<QueryResult<T>>;
  run<T = Record<string, unknown>>(): Promise<QueryResult<T>>;
}

export interface D1Binding {
  prepare(query: string): D1Statement;
  batch<T = unknown>(statements: D1Statement[]): Promise<QueryResult<T>[]>;
}

const PROJECT_NAME_RE = /^[a-z0-9-]+$/;
const MAX_PROJECT_NAME_LENGTH = 64;
const RESERVED_PROJECT_NAMES = new Set(['api', 'login', 'files', 'assets']);

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

function escapeLike(value: string): string {
  return value.replaceAll(/[\\%_]/g, (match) => `\\${match}`);
}

function isD1ConstraintError(error: unknown): boolean {
  return error instanceof Error && /(?:SQLITE_CONSTRAINT|UNIQUE constraint failed)/u.test(error.message);
}

function pageMeta(row: PageRow): PageMeta {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    titleLc: row.title_lc,
    version: row.version,
    pinned: row.pinned,
    deleted: row.deleted === 1,
    image: row.image,
    created: row.created,
    updated: row.updated,
  };
}

function accountFromRow(row: AccountRow): Account {
  return {
    id: row.id,
    actorId: row.actor_id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    isAdmin: row.is_admin === 1,
    created: row.created,
  };
}

export class D1Storage implements Storage {
  readonly #db: D1Binding;

  constructor(db: D1Binding) {
    this.#db = db;
  }

  async createProject(name: string, now: number): Promise<CreateProjectResult> {
    if (!PROJECT_NAME_RE.test(name) || RESERVED_PROJECT_NAMES.has(name)) {
      throw new StorageError(`invalid project name: ${name}`);
    }
    const existing = await this.getProject(name);
    if (existing !== null) return { kind: 'existing', project: existing };
    if (name.length > MAX_PROJECT_NAME_LENGTH) throw new StorageError(`invalid project name: ${name}`);
    const id = ulid(now * 1000);
    const result = await this.#db.prepare(
      'INSERT OR IGNORE INTO projects (id, name, display_name, created, updated) VALUES (?, ?, ?, ?, ?)',
    ).bind(id, name, name, now, now).run();
    const project = await this.getProject(name);
    if (project === null) throw new StorageError(`could not create project: ${name}`);
    return { kind: result.meta.changes === 1 ? 'created' : 'existing', project };
  }

  async ensureProject(name: string, now: number): Promise<Project> {
    return (await this.createProject(name, now)).project;
  }

  async getProject(name: string): Promise<Project | null> {
    const row = await this.#db.prepare(
      'SELECT id, name, display_name, created, updated FROM projects WHERE name = ?',
    ).bind(name).first<{ id: string; name: string; display_name: string; created: number; updated: number }>();
    return row === null
      ? null
      : { id: row.id, name: row.name, displayName: row.display_name, created: row.created, updated: row.updated };
  }

  async listProjects(): Promise<Project[]> {
    const { results } = await this.#db.prepare(
      'SELECT id, name, display_name, created, updated FROM projects ORDER BY name',
    ).all<{ id: string; name: string; display_name: string; created: number; updated: number }>();
    return results.map((row) => ({
      id: row.id,
      name: row.name,
      displayName: row.display_name,
      created: row.created,
      updated: row.updated,
    }));
  }

  async setProjectDisplayName(projectId: string, displayName: string, now: number): Promise<void> {
    await this.#db.prepare('UPDATE projects SET display_name = ?, updated = ? WHERE id = ?')
      .bind(displayName, now, projectId).run();
  }

  async upsertActor(actor: Actor, now: number): Promise<string> {
    await this.#db.prepare(
      'INSERT INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
    ).bind(actor.id, actor.name, actor.displayName, now).run();
    return actor.id;
  }

  async getActorById(id: string): Promise<Actor | null> {
    const row = await this.#db.prepare('SELECT id, name, display_name FROM actors WHERE id = ?')
      .bind(id).first<{ id: string; name: string; display_name: string }>();
    return row === null ? null : { id: row.id, name: row.name, displayName: row.display_name };
  }

  async listActorsForProject(projectId: string): Promise<Actor[]> {
    const { results } = await this.#db.prepare(
      `SELECT a.id, a.name, a.display_name FROM actors a
       WHERE a.id IN (
         SELECT l.actor_id FROM lines l JOIN pages p ON p.id = l.page_id WHERE p.project_id = ?
         UNION
         SELECT c.actor_id FROM commits c JOIN pages p ON p.id = c.page_id WHERE p.project_id = ?
       ) ORDER BY a.name, a.id`,
    ).bind(projectId, projectId).all<{ id: string; name: string; display_name: string }>();
    return results.map((row) => ({ id: row.id, name: row.name, displayName: row.display_name }));
  }

  async addAccount(account: NewAccount, now: number): Promise<AddAccountResult> {
    try {
      await this.#db.batch([
        this.#db.prepare('INSERT INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?)')
          .bind(account.actor.id, account.actor.name, account.actor.displayName, now),
        this.#db.prepare(
          `INSERT INTO accounts (id, actor_id, name, email, password_hash, is_admin, created)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          account.id,
          account.actor.id,
          account.name,
          account.email ?? null,
          account.passwordHash,
          account.isAdmin ? 1 : 0,
          now,
        ),
      ]);
    } catch (error) {
      if (isD1ConstraintError(error)) throw new StorageError(`account already exists: ${account.name}`);
      throw error;
    }
    return { accountId: account.id, actorId: account.actor.id };
  }

  async addAccessAccount(
    account: { id: string; actor: Actor; name: string; email: string },
    now: number,
  ): Promise<AddAccountResult> {
    const [byId, byName, actor] = await Promise.all([
      this.getAccountById(account.id),
      this.getAccountByName(account.name),
      this.getActorById(account.actor.id),
    ]);
    if (byId !== null || byName !== null || actor !== null) {
      if (
        actor !== null
        && byId?.actorId === account.actor.id
        && byId.name === account.name
        && byId.email === account.email
      ) {
        return { accountId: byId.id, actorId: byId.actorId };
      }
      throw new StorageError(`Access account mapping conflicts with existing identity: ${account.name}`);
    }
    await this.#db.batch([
      this.#db.prepare('INSERT INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?)')
        .bind(account.actor.id, account.actor.name, account.actor.displayName, now),
      this.#db.prepare(
        `INSERT INTO accounts (id, actor_id, name, email, password_hash, is_admin, created)
         VALUES (?, ?, ?, ?, NULL, 1, ?)`,
      ).bind(account.id, account.actor.id, account.name, account.email, now),
    ]);
    return { accountId: account.id, actorId: account.actor.id };
  }

  async getAccountByName(name: string): Promise<Account | null> {
    const row = await this.#db.prepare('SELECT * FROM accounts WHERE name = ?').bind(name).first<AccountRow>();
    return row === null ? null : accountFromRow(row);
  }

  async getAccountById(id: string): Promise<Account | null> {
    const row = await this.#db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<AccountRow>();
    return row === null ? null : accountFromRow(row);
  }

  async getPageAuthors(pageId: string): Promise<{ user: Actor | null; lastUpdateUser: Actor | null }> {
    const row = await this.#db.prepare(
      `WITH first_commit AS (SELECT actor_id FROM commits WHERE page_id = ? ORDER BY version ASC LIMIT 1),
       last_commit AS (SELECT actor_id FROM commits WHERE page_id = ? ORDER BY version DESC LIMIT 1)
       SELECT first_user.id AS first_id, first_user.name AS first_name,
         first_user.display_name AS first_display_name, last_user.id AS last_id,
         last_user.name AS last_name, last_user.display_name AS last_display_name
       FROM first_commit CROSS JOIN last_commit
       LEFT JOIN actors first_user ON first_user.id = first_commit.actor_id
       LEFT JOIN actors last_user ON last_user.id = last_commit.actor_id`,
    ).bind(pageId, pageId).first<{
      first_id: string | null; first_name: string | null; first_display_name: string | null;
      last_id: string | null; last_name: string | null; last_display_name: string | null;
    }>();
    const user = row?.first_id && row.first_name !== null && row.first_display_name !== null
      ? { id: row.first_id, name: row.first_name, displayName: row.first_display_name }
      : null;
    const lastUpdateUser = row?.last_id && row.last_name !== null && row.last_display_name !== null
      ? { id: row.last_id, name: row.last_name, displayName: row.last_display_name }
      : null;
    return { user, lastUpdateUser };
  }

  async #lines(pageId: string): Promise<Line[]> {
    const { results } = await this.#db.prepare(
      'SELECT id, text, created, updated, updated_version, actor_id FROM lines WHERE page_id = ? ORDER BY ord',
    ).bind(pageId).all<LineRow>();
    return results.map((row) => ({
      id: row.id,
      text: row.text,
      created: row.created,
      updated: row.updated,
      updatedVersion: row.updated_version,
      userId: row.actor_id,
    }));
  }

  async #snapshot(row: PageRow): Promise<PageSnapshot> {
    return { ...pageMeta(row), lines: await this.#lines(row.id) };
  }

  async getPageByTitle(projectId: string, titleLcValue: string): Promise<PageSnapshot | null> {
    const row = await this.#db.prepare(
      'SELECT * FROM pages WHERE project_id = ? AND title_lc = ? AND deleted = 0',
    ).bind(projectId, titleLcValue).first<PageRow>();
    return row === null ? null : this.#snapshot(row);
  }

  async getPageById(pageId: string): Promise<PageSnapshot | null> {
    const row = await this.#db.prepare('SELECT * FROM pages WHERE id = ?').bind(pageId).first<PageRow>();
    return row === null ? null : this.#snapshot(row);
  }

  async listPages(projectId: string): Promise<PageMeta[]> {
    const { results } = await this.#db.prepare(
      'SELECT * FROM pages WHERE project_id = ? AND deleted = 0 ORDER BY updated DESC, id',
    ).bind(projectId).all<PageRow>();
    return results.map(pageMeta);
  }

  async listPageSummaries(
    projectId: string,
    opts: ListPageSummariesOptions,
  ): Promise<{ count: number; pages: PageSummary[] }> {
    const orderBy = {
      updated: 'p.updated DESC, p.id',
      created: 'p.created DESC, p.id',
      linked: 'linked DESC, p.updated DESC, p.id',
      title: 'p.title_lc ASC',
      views: 'views DESC, p.updated DESC, p.id',
      accessed: 'accessed DESC, p.updated DESC, p.id',
    } satisfies Record<ListPageSummariesOptions['sort'], string>;
    const order = `${opts.pinnedFirst ? 'p.pinned DESC, ' : ''}${orderBy[opts.sort]}`;
    const [countRow, rowsResult] = await Promise.all([
      this.#db.prepare('SELECT COUNT(*) AS n FROM pages WHERE project_id = ? AND deleted = 0')
        .bind(projectId).first<{ n: number }>(),
      this.#db.prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM links l WHERE l.project_id = p.project_id AND l.target_title_lc = p.title_lc) AS linked,
           COALESCE((SELECT SUM(pv.views) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS views,
           COALESCE((SELECT MAX(pv.visited) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS accessed
         FROM pages p WHERE p.project_id = ? AND p.deleted = 0
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      ).bind(projectId, opts.limit, opts.skip).all<PageRow & PageVisitMetrics & { linked: number }>(),
    ]);
    const pages = await Promise.all(rowsResult.results.map(async (row): Promise<PageSummary> => ({
      ...pageMeta(row),
      linked: row.linked,
      views: row.views,
      accessed: row.accessed,
      descriptions: (await this.#db.prepare(
        "SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5",
      ).bind(row.id).all<{ text: string }>()).results.map((line) => line.text),
    })));
    return { count: countRow?.n ?? 0, pages };
  }

  async #outbound(pageId: string): Promise<{ titleLc: string; title: string }[]> {
    const { results } = await this.#db.prepare(
      'SELECT target_title_lc, target_title FROM links WHERE source_page_id = ?',
    ).bind(pageId).all<{ target_title_lc: string; target_title: string }>();
    return results.map((row) => ({ titleLc: row.target_title_lc, title: row.target_title }));
  }

  async #relatedPage(row: PageRow, linksLc: string[]): Promise<RelatedPage> {
    const [descriptionRows, linkedRow, metrics] = await Promise.all([
      this.#db.prepare("SELECT text FROM lines WHERE page_id = ? AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5")
        .bind(row.id).all<{ text: string }>(),
      this.#db.prepare('SELECT COUNT(*) AS n FROM links WHERE project_id = ? AND target_title_lc = ?')
        .bind(row.project_id, row.title_lc).first<{ n: number }>(),
      this.getPageVisitMetrics(row.id),
    ]);
    return {
      id: row.id,
      title: row.title,
      titleLc: row.title_lc,
      image: row.image,
      descriptions: descriptionRows.results.map((description) => description.text),
      linksLc,
      linked: linkedRow?.n ?? 0,
      updated: row.updated,
      accessed: metrics.accessed,
    };
  }

  async getRelatedPages(projectId: string, pageId: string, titleLcValue: string): Promise<RelatedPages> {
    const targets = await this.#outbound(pageId);
    const targetValues = targets.map((target) => target.titleLc);
    const placeholders = targetValues.map(() => '?').join(', ');
    const forward = targetValues.length === 0
      ? []
      : (await this.#db.prepare(
        `SELECT * FROM pages WHERE project_id = ? AND deleted = 0 AND id != ? AND title_lc IN (${placeholders})`,
      ).bind(projectId, pageId, ...targetValues).all<PageRow>()).results;
    const back = (await this.#db.prepare(
      `SELECT p.* FROM pages p JOIN links l ON l.source_page_id = p.id
       WHERE l.project_id = ? AND l.target_title_lc = ? AND p.id != ? AND p.deleted = 0`,
    ).bind(projectId, titleLcValue, pageId).all<PageRow>()).results;
    const oneHop = new Map<string, PageRow>();
    for (const row of [...forward, ...back]) oneHop.set(row.id, row);
    const links1hop = await Promise.all([...oneHop.values()].map(async (row) =>
      this.#relatedPage(row, (await this.#outbound(row.id)).map((target) => target.titleLc))));

    const byPage = new Map<string, { row: PageRow; shared: string[] }>();
    if (targetValues.length > 0) {
      const rows = (await this.#db.prepare(
        `SELECT p.*, l.target_title_lc AS shared FROM pages p JOIN links l ON l.source_page_id = p.id
         WHERE l.project_id = ? AND l.target_title_lc IN (${placeholders}) AND p.deleted = 0`,
      ).bind(projectId, ...targetValues).all<PageRow & { shared: string }>()).results;
      for (const row of rows) {
        if (row.id === pageId || oneHop.has(row.id)) continue;
        const entry = byPage.get(row.id) ?? { row, shared: [] };
        entry.shared.push(row.shared);
        byPage.set(row.id, entry);
      }
    }
    const [links2hop, linkedRow] = await Promise.all([
      Promise.all([...byPage.values()].map(({ row, shared }) => this.#relatedPage(row, shared))),
      this.#db.prepare('SELECT COUNT(*) AS n FROM links WHERE project_id = ? AND target_title_lc = ?')
        .bind(projectId, titleLcValue).first<{ n: number }>(),
    ]);
    return { links1hop, links2hop, hasBackLinks: back.length > 0, linked: linkedRow?.n ?? 0 };
  }

  async listPageTitles(projectId: string): Promise<TitleEntry[]> {
    const rows = (await this.#db.prepare(
      'SELECT * FROM pages WHERE project_id = ? AND deleted = 0 ORDER BY updated DESC, id',
    ).bind(projectId).all<PageRow>()).results;
    return Promise.all(rows.map(async (row) => ({
      id: row.id,
      title: row.title,
      hasIcon: row.image !== null,
      updated: row.updated,
      links: (await this.#outbound(row.id)).map((target) => target.title),
      image: row.image,
    })));
  }

  async listKnownPages(projectId: string): Promise<{ titleLc: string; title: string; image: string | null }[]> {
    const { results } = await this.#db.prepare(
      'SELECT title_lc, title, image FROM pages WHERE project_id = ? AND deleted = 0',
    ).bind(projectId).all<{ title_lc: string; title: string; image: string | null }>();
    return results.map((row) => ({ titleLc: row.title_lc, title: row.title, image: row.image }));
  }

  async setPinned(pageId: string, pinned: boolean): Promise<void> {
    await this.#db.prepare('UPDATE pages SET pinned = ? WHERE id = ?').bind(pinned ? 1 : 0, pageId).run();
  }

  async getVisit(accountId: string, pageId: string): Promise<Visit | null> {
    const row = await this.#db.prepare(
      'SELECT visited, last_seen_version FROM page_visits WHERE account_id = ? AND page_id = ?',
    ).bind(accountId, pageId).first<{ visited: number; last_seen_version: number }>();
    return row === null ? null : { visited: row.visited, lastSeenVersion: row.last_seen_version };
  }

  async getPageVisitMetrics(pageId: string): Promise<PageVisitMetrics> {
    const row = await this.#db.prepare(
      'SELECT COALESCE(SUM(views), 0) AS views, COALESCE(MAX(visited), 0) AS accessed FROM page_visits WHERE page_id = ?',
    ).bind(pageId).first<PageVisitMetrics>();
    return row ?? { views: 0, accessed: 0 };
  }

  async recordVisit(accountId: string, pageId: string, visitedAt: number, lastSeenVersion: number): Promise<void> {
    await this.#db.prepare(
      `INSERT INTO page_visits (account_id, page_id, visited, last_seen_version) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, page_id) DO UPDATE SET
         visited = MAX(page_visits.visited, excluded.visited),
         last_seen_version = MAX(page_visits.last_seen_version, excluded.last_seen_version),
         views = page_visits.views + 1`,
    ).bind(accountId, pageId, visitedAt, lastSeenVersion).run();
  }

  async search(projectId: string, query: SearchQuery): Promise<SearchHit[]> {
    if (query.words.includes('')) return [];
    const words = [...new Set(query.words)];
    const firstWord = words[0];
    if (firstWord === undefined) return [];
    const excludes = [...new Set(query.excludes)];
    const clauses = [
      ...words.map(() => "s.content LIKE ? ESCAPE '\\'"),
      ...excludes.map(() => "s.content NOT LIKE ? ESCAPE '\\'"),
    ];
    const values = [...words, ...excludes].map((word) => `%${escapeLike(word)}%`);
    const pages = (await this.#db.prepare(
      `SELECT p.id, p.title, p.image FROM page_search s JOIN pages p ON p.id = s.page_id
       WHERE s.project_id = ? AND p.deleted = 0 AND ${clauses.join(' AND ')}
       ORDER BY p.updated DESC, p.id`,
    ).bind(projectId, ...values).all<{ id: string; title: string; image: string | null }>()).results;
    const lineClauses = words.map(() => "text LIKE ? ESCAPE '\\'").join(' OR ');
    const patterns = words.map((word) => `%${escapeLike(word)}%`);
    return Promise.all(pages.map(async (page): Promise<SearchHit> => ({
      pageId: page.id,
      title: page.title,
      image: page.image,
      lines: (await this.#db.prepare(
        `SELECT text FROM lines WHERE page_id = ? AND (${lineClauses}) ORDER BY ord`,
      ).bind(page.id, ...patterns).all<{ text: string }>()).results.map((row) => row.text),
    })));
  }

  async reindex(projectId?: string): Promise<{ pages: number }> {
    const countRow = projectId === undefined
      ? await this.#db.prepare('SELECT COUNT(*) AS n FROM pages').first<{ n: number }>()
      : await this.#db.prepare('SELECT COUNT(*) AS n FROM pages WHERE project_id = ?')
        .bind(projectId).first<{ n: number }>();
    const deleteStatement = projectId === undefined
      ? this.#db.prepare('DELETE FROM page_search')
      : this.#db.prepare('DELETE FROM page_search WHERE project_id = ?').bind(projectId);
    const insertStatement = projectId === undefined
      ? this.#db.prepare(
        `INSERT INTO page_search (page_id, project_id, content)
         SELECT p.id, p.project_id, GROUP_CONCAT(l.text, char(10))
         FROM pages p JOIN lines l ON l.page_id = p.id
         WHERE p.deleted = 0 GROUP BY p.id, p.project_id`,
      )
      : this.#db.prepare(
        `INSERT INTO page_search (page_id, project_id, content)
         SELECT p.id, p.project_id, GROUP_CONCAT(l.text, char(10))
         FROM pages p JOIN lines l ON l.page_id = p.id
         WHERE p.project_id = ? AND p.deleted = 0 GROUP BY p.id, p.project_id`,
      ).bind(projectId);
    await this.#db.batch([deleteStatement, insertStatement]);
    return { pages: countRow?.n ?? 0 };
  }

  async createApiToken(): Promise<void> { throw new UnsupportedStorageOperationError('createApiToken'); }
  async getAccountByApiTokenHash(): Promise<Account | null> { throw new UnsupportedStorageOperationError('getAccountByApiTokenHash'); }
  async listApiTokens(): Promise<ApiToken[]> { throw new UnsupportedStorageOperationError('listApiTokens'); }
  async deleteApiToken(): Promise<boolean> { throw new UnsupportedStorageOperationError('deleteApiToken'); }
  async createSession(): Promise<void> { throw new UnsupportedStorageOperationError('createSession'); }
  async getSession(): Promise<Session | null> { throw new UnsupportedStorageOperationError('getSession'); }
  async refreshSession(): Promise<void> { throw new UnsupportedStorageOperationError('refreshSession'); }
  async deleteSession(): Promise<void> { throw new UnsupportedStorageOperationError('deleteSession'); }
  async createAttachment(): Promise<void> { throw new UnsupportedStorageOperationError('createAttachment'); }
  async tryCreateAttachment(): Promise<CreateAttachmentResult> { throw new UnsupportedStorageOperationError('tryCreateAttachment'); }
  async updateAttachmentMetadata(): Promise<void> { throw new UnsupportedStorageOperationError('updateAttachmentMetadata'); }
  async releaseAttachmentClaims(): Promise<string[]> { throw new UnsupportedStorageOperationError('releaseAttachmentClaims'); }
  async finalizeAttachmentClaims(): Promise<void> { throw new UnsupportedStorageOperationError('finalizeAttachmentClaims'); }
  async reuseAttachmentBySha256(): Promise<Attachment | null> { throw new UnsupportedStorageOperationError('reuseAttachmentBySha256'); }
  async listAttachments(): Promise<Attachment[]> { throw new UnsupportedStorageOperationError('listAttachments'); }
  async getAttachment(): Promise<Attachment | null> { throw new UnsupportedStorageOperationError('getAttachment'); }
  async commit(_input: CommitInput): Promise<CommitResult> { throw new UnsupportedStorageOperationError('commit'); }
  async replacePageText(_input: ReplacePageTextInput): Promise<ReplacePageTextResult> {
    throw new UnsupportedStorageOperationError('replacePageText');
  }
  async deletePage(_input: DeleteInput): Promise<DeleteResult> { throw new UnsupportedStorageOperationError('deletePage'); }
  async renamePage(_input: RenameInput): Promise<RenameResult> { throw new UnsupportedStorageOperationError('renamePage'); }
  async importPage(_input: ImportPageInput): Promise<ImportPageResult> { throw new UnsupportedStorageOperationError('importPage'); }
  async close(): Promise<void> {}
}
