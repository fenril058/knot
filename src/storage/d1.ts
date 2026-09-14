import { ulid } from '../core/id.ts';
import { derivePageData } from '../application/pageDerivedData.ts';
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

function isD1ConstraintError(error: unknown): boolean {
  return error instanceof Error && /(?:SQLITE_CONSTRAINT_UNIQUE|UNIQUE constraint failed)/u.test(error.message);
}

function textArray(json: string): string[] {
  // JSON1 aggregate output crosses the D1 binding as text.
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new StorageError('D1 returned an invalid text array');
  }
  return value;
}

function usesFts(term: string): boolean {
  // oxlint-disable-next-line typescript/no-misused-spread
  return [...term].length >= 3;
}

function ftsPhrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
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
    try {
      await this.#db.batch([
        this.#db.prepare('INSERT INTO actors (id, name, display_name, created) VALUES (?, ?, ?, ?)')
          .bind(account.actor.id, account.actor.name, account.actor.displayName, now),
        this.#db.prepare(
          `INSERT INTO accounts (id, actor_id, name, email, password_hash, is_admin, created)
           VALUES (?, ?, ?, ?, NULL, 1, ?)`,
        ).bind(account.id, account.actor.id, account.name, account.email, now),
      ]);
    } catch (error) {
      if (isD1ConstraintError(error)) {
        throw new StorageError(`Access account mapping conflicts with existing identity: ${account.name}`);
      }
      throw error;
    }
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
           COALESCE((SELECT MAX(pv.visited) FROM page_visits pv WHERE pv.page_id = p.id), 0) AS accessed,
           (SELECT json_group_array(text) FROM (
             SELECT text FROM lines WHERE page_id = p.id AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5
           )) AS descriptions_json
         FROM pages p WHERE p.project_id = ? AND p.deleted = 0
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      ).bind(projectId, opts.limit, opts.skip).all<
        PageRow & PageVisitMetrics & { linked: number; descriptions_json: string }
      >(),
    ]);
    const pages = rowsResult.results.map((row): PageSummary => ({
      ...pageMeta(row),
      linked: row.linked,
      views: row.views,
      accessed: row.accessed,
      descriptions: textArray(row.descriptions_json),
    }));
    return { count: countRow?.n ?? 0, pages };
  }

  async getRelatedPages(projectId: string, pageId: string, titleLcValue: string): Promise<RelatedPages> {
    type RelatedRow = PageRow & {
      hop: number;
      shared_json: string | null;
      descriptions_json: string;
      links_json: string;
      linked: number;
      accessed: number;
    };
    const [rowsResult, stats] = await Promise.all([
      this.#db.prepare(
        `WITH targets AS (
           SELECT target_title_lc FROM links WHERE project_id = ? AND source_page_id = ?
         ), one_hop AS (
           SELECT p.id FROM targets t JOIN pages p
             ON p.project_id = ? AND p.title_lc = t.target_title_lc
           WHERE p.deleted = 0 AND p.id != ?
           UNION
           SELECT p.id FROM links l JOIN pages p ON p.id = l.source_page_id
           WHERE l.project_id = ? AND l.target_title_lc = ? AND p.deleted = 0 AND p.id != ?
         ), two_hop AS (
           SELECT p.id, json_group_array(candidate.target_title_lc) AS shared_json
           FROM targets t JOIN links candidate
             ON candidate.project_id = ? AND candidate.target_title_lc = t.target_title_lc
           JOIN pages p ON p.id = candidate.source_page_id
           WHERE p.deleted = 0 AND p.id != ? AND NOT EXISTS (SELECT 1 FROM one_hop o WHERE o.id = p.id)
           GROUP BY p.id
         ), candidates AS (
           SELECT id, 1 AS hop, NULL AS shared_json FROM one_hop
           UNION ALL
           SELECT id, 2 AS hop, shared_json FROM two_hop
         )
         SELECT p.*, candidates.hop, candidates.shared_json,
           (SELECT json_group_array(text) FROM (
             SELECT text FROM lines WHERE page_id = p.id AND ord > 0 AND text <> '' ORDER BY ord LIMIT 5
           )) AS descriptions_json,
           (SELECT json_group_array(target_title_lc) FROM links outbound WHERE outbound.source_page_id = p.id)
             AS links_json,
           (SELECT COUNT(*) FROM links inbound
             WHERE inbound.project_id = p.project_id AND inbound.target_title_lc = p.title_lc) AS linked,
           COALESCE((SELECT MAX(visited) FROM page_visits WHERE page_id = p.id), 0) AS accessed
         FROM candidates JOIN pages p ON p.id = candidates.id
         ORDER BY candidates.hop, p.updated DESC, p.id`,
      ).bind(
        projectId,
        pageId,
        projectId,
        pageId,
        projectId,
        titleLcValue,
        pageId,
        projectId,
        pageId,
      ).all<RelatedRow>(),
      this.#db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM links WHERE project_id = ? AND target_title_lc = ?) AS linked,
           EXISTS(
             SELECT 1 FROM links l JOIN pages p ON p.id = l.source_page_id
             WHERE l.project_id = ? AND l.target_title_lc = ? AND p.id != ? AND p.deleted = 0
           ) AS has_back_links`,
      ).bind(projectId, titleLcValue, projectId, titleLcValue, pageId)
        .first<{ linked: number; has_back_links: number }>(),
    ]);
    const relatedPage = (row: RelatedRow): RelatedPage => ({
      id: row.id,
      title: row.title,
      titleLc: row.title_lc,
      image: row.image,
      descriptions: textArray(row.descriptions_json),
      linksLc: textArray(row.shared_json ?? row.links_json),
      linked: row.linked,
      updated: row.updated,
      accessed: row.accessed,
    });
    return {
      links1hop: rowsResult.results.filter((row) => row.hop === 1).map(relatedPage),
      links2hop: rowsResult.results.filter((row) => row.hop === 2).map(relatedPage),
      hasBackLinks: stats?.has_back_links === 1,
      linked: stats?.linked ?? 0,
    };
  }

  async listPageTitles(projectId: string): Promise<TitleEntry[]> {
    const rows = (await this.#db.prepare(
      `SELECT p.*,
         (SELECT json_group_array(target_title) FROM links l WHERE l.source_page_id = p.id) AS links_json
       FROM pages p WHERE p.project_id = ? AND p.deleted = 0 ORDER BY p.updated DESC, p.id`,
    ).bind(projectId).all<PageRow & { links_json: string }>()).results;
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      hasIcon: row.image !== null,
      updated: row.updated,
      links: textArray(row.links_json),
      image: row.image,
    }));
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
    const conditionValues: unknown[] = [];
    let from: string;
    let order: string;
    if (usesFts(firstWord)) {
      from = 'pages_fts JOIN pages p ON p.id = pages_fts.page_id';
      order = 'pages_fts.rank, p.id, matched_line.ord';
      conditionValues.push(ftsPhrase(firstWord), projectId);
    } else {
      from = 'pages p';
      order = 'p.updated DESC, p.id, matched_line.ord';
      conditionValues.push(projectId, firstWord);
    }
    const firstCondition = usesFts(firstWord)
      ? 'pages_fts MATCH ? AND pages_fts.project_id = ?'
      : `p.project_id = ? AND EXISTS (
          SELECT 1 FROM lines first_line
          WHERE first_line.page_id = p.id AND instr(lower(first_line.text), lower(?)) > 0
        )`;
    const conditions = [firstCondition, 'p.deleted = 0'];
    for (const word of words.slice(1)) {
      if (usesFts(word)) {
        conditions.push('p.id IN (SELECT page_id FROM pages_fts WHERE pages_fts MATCH ?)');
        conditionValues.push(ftsPhrase(word));
      } else {
        conditions.push(`EXISTS (
          SELECT 1 FROM lines required_line
          WHERE required_line.page_id = p.id AND instr(lower(required_line.text), lower(?)) > 0
        )`);
        conditionValues.push(word);
      }
    }
    for (const word of excludes) {
      if (usesFts(word)) {
        conditions.push('p.id NOT IN (SELECT page_id FROM pages_fts WHERE pages_fts MATCH ?)');
        conditionValues.push(ftsPhrase(word));
      } else {
        conditions.push(`NOT EXISTS (
          SELECT 1 FROM lines excluded_line
          WHERE excluded_line.page_id = p.id AND instr(lower(excluded_line.text), lower(?)) > 0
        )`);
        conditionValues.push(word);
      }
    }
    const lineConditions = words.map(() => 'instr(lower(matched_line.text), lower(?)) > 0').join(' OR ');
    const rows = (await this.#db.prepare(
      `SELECT p.id, p.title, p.image, matched_line.text
       FROM ${from} LEFT JOIN lines matched_line ON matched_line.page_id = p.id AND (${lineConditions})
       WHERE ${conditions.join(' AND ')}
       ORDER BY ${order}`,
    ).bind(...words, ...conditionValues).all<{ id: string; title: string; image: string | null; text: string | null }>()).results;
    const hits = new Map<string, SearchHit>();
    for (const row of rows) {
      const hit = hits.get(row.id) ?? { pageId: row.id, title: row.title, image: row.image, lines: [] };
      if (row.text !== null) hit.lines.push(row.text);
      hits.set(row.id, hit);
    }
    return [...hits.values()];
  }

  async reindex(projectId?: string): Promise<{ pages: number }> {
    const [pageResult, lineResult] = await Promise.all([
      projectId === undefined
        ? this.#db.prepare('SELECT * FROM pages ORDER BY id').all<PageRow>()
        : this.#db.prepare('SELECT * FROM pages WHERE project_id = ? ORDER BY id').bind(projectId).all<PageRow>(),
      projectId === undefined
        ? this.#db.prepare(
          `SELECT l.* FROM lines l JOIN pages p ON p.id = l.page_id ORDER BY l.page_id, l.ord`,
        ).all<LineRow & { page_id: string }>()
        : this.#db.prepare(
          `SELECT l.* FROM lines l JOIN pages p ON p.id = l.page_id
           WHERE p.project_id = ? ORDER BY l.page_id, l.ord`,
        ).bind(projectId).all<LineRow & { page_id: string }>(),
    ]);
    const linesByPage = new Map<string, { text: string }[]>();
    for (const line of lineResult.results) {
      const lines = linesByPage.get(line.page_id) ?? [];
      lines.push({ text: line.text });
      linesByPage.set(line.page_id, lines);
    }
    for (const page of pageResult.results) {
      const derived = derivePageData(linesByPage.get(page.id) ?? [], page.deleted === 1);
      const statements: D1Statement[] = [
        this.#db.prepare('DELETE FROM links WHERE source_page_id = ?').bind(page.id),
        this.#db.prepare('DELETE FROM pages_fts WHERE page_id = ?').bind(page.id),
        this.#db.prepare('UPDATE pages SET image = ? WHERE id = ?').bind(derived.image, page.id),
      ];
      for (const target of derived.links) {
        statements.push(this.#db.prepare(
          'INSERT OR IGNORE INTO links (project_id, source_page_id, target_title_lc, target_title) VALUES (?, ?, ?, ?)',
        ).bind(page.project_id, page.id, target.titleLc, target.title));
      }
      if (derived.searchText !== null) {
        statements.push(this.#db.prepare(
          'INSERT INTO pages_fts (page_id, project_id, content) VALUES (?, ?, ?)',
        ).bind(page.id, page.project_id, derived.searchText));
      }
      await this.#db.batch(statements);
    }
    return { pages: pageResult.results.length };
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
