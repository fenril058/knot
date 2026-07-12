CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);

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
  user_id TEXT NOT NULL,
  PRIMARY KEY (page_id, id)
);
CREATE INDEX lines_page_ord ON lines(page_id, ord);

CREATE TABLE commits (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id),
  base_version INTEGER NOT NULL,
  version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
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

CREATE TABLE page_visits (
  user_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  visited INTEGER NOT NULL,
  last_seen_version INTEGER NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

CREATE TABLE links (
  project_id TEXT NOT NULL,
  source_page_id TEXT NOT NULL,
  target_title_lc TEXT NOT NULL,
  PRIMARY KEY (source_page_id, target_title_lc)
);
CREATE INDEX links_target ON links(project_id, target_title_lc);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires INTEGER NOT NULL,
  created INTEGER NOT NULL
);

CREATE VIRTUAL TABLE pages_fts USING fts5(
  page_id UNINDEXED,
  project_id UNINDEXED,
  content,
  tokenize='trigram'
);
