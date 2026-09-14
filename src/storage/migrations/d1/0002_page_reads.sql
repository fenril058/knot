CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  title_lc TEXT NOT NULL,
  version INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE UNIQUE INDEX pages_title_lc ON pages(project_id, title_lc) WHERE deleted = 0;

CREATE TABLE lines (
  id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id),
  ord INTEGER NOT NULL,
  text TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  updated_version INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  PRIMARY KEY (page_id, id)
);
CREATE INDEX lines_page_ord ON lines(page_id, ord);

CREATE TABLE commits (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  base_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  created INTEGER NOT NULL,
  ops TEXT NOT NULL,
  ops_hash TEXT NOT NULL,
  UNIQUE (page_id, version)
);

CREATE TABLE title_history (
  page_id TEXT NOT NULL REFERENCES pages(id),
  old_title TEXT NOT NULL,
  old_title_lc TEXT NOT NULL,
  started INTEGER NOT NULL,
  ended INTEGER NOT NULL
);

CREATE TABLE links (
  project_id TEXT NOT NULL,
  source_page_id TEXT NOT NULL REFERENCES pages(id),
  target_title_lc TEXT NOT NULL,
  target_title TEXT NOT NULL,
  PRIMARY KEY (source_page_id, target_title_lc)
);
CREATE INDEX links_target ON links(project_id, target_title_lc);

CREATE TABLE page_visits (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  visited INTEGER NOT NULL,
  last_seen_version INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, page_id)
);
CREATE INDEX page_visits_page_id ON page_visits(page_id);

-- D1 の tokenizer 差に依存せず、日本語の部分一致を SQLite と同じ LIKE 契約で提供する。
CREATE TABLE page_search (
  page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX page_search_project ON page_search(project_id);
