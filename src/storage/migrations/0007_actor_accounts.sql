CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created INTEGER NOT NULL
);

INSERT INTO actors (id, name, display_name, created)
SELECT id, name, display_name, created FROM users;

INSERT OR IGNORE INTO actors (id, name, display_name, created)
SELECT user_id, user_id, user_id, MIN(created) FROM lines GROUP BY user_id;
INSERT OR IGNORE INTO actors (id, name, display_name, created)
SELECT user_id, user_id, user_id, MIN(created) FROM commits GROUP BY user_id;
INSERT OR IGNORE INTO actors (id, name, display_name, created)
SELECT user_id, user_id, user_id, MIN(created) FROM attachments GROUP BY user_id;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id) ON DELETE RESTRICT,
  name TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created INTEGER NOT NULL
);

INSERT INTO accounts (id, actor_id, name, email, password_hash, is_admin, created)
SELECT id, id, name, email, password_hash, is_admin, created
FROM users
WHERE password_hash IS NOT NULL;

ALTER TABLE lines RENAME TO lines_identity_legacy;
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
INSERT INTO lines (id, page_id, ord, text, created, updated, updated_version, actor_id)
SELECT id, page_id, ord, text, created, updated, updated_version, user_id
FROM lines_identity_legacy;
DROP TABLE lines_identity_legacy;
CREATE INDEX lines_page_ord ON lines(page_id, ord);

ALTER TABLE commits RENAME TO commits_identity_legacy;
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
INSERT INTO commits (id, page_id, base_version, version, actor_id, created, ops, ops_hash)
SELECT id, page_id, base_version, version, user_id, created, ops, ops_hash
FROM commits_identity_legacy;
DROP TABLE commits_identity_legacy;

CREATE TABLE attachment_claims_identity_backup AS
SELECT attachment_id, owner FROM attachment_claims;
DROP TABLE attachment_claims;
ALTER TABLE attachments RENAME TO attachments_identity_legacy;
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
  created INTEGER NOT NULL,
  provisional INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0, 1))
);
INSERT INTO attachments
  (id, project_id, filename, content_type, size, sha256, actor_id, created, provisional)
SELECT id, project_id, filename, content_type, size, sha256, user_id, created, provisional
FROM attachments_identity_legacy;
DROP TABLE attachments_identity_legacy;
CREATE UNIQUE INDEX attachments_project_sha ON attachments(project_id, sha256);
CREATE TABLE attachment_claims (
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  PRIMARY KEY (attachment_id, owner)
);
INSERT INTO attachment_claims (attachment_id, owner)
SELECT attachment_id, owner FROM attachment_claims_identity_backup;
DROP TABLE attachment_claims_identity_backup;
CREATE INDEX attachment_claims_owner ON attachment_claims(owner);

ALTER TABLE sessions RENAME TO sessions_identity_legacy;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL,
  created INTEGER NOT NULL
);
INSERT INTO sessions (id, account_id, expires, created)
SELECT id, user_id, expires, created FROM sessions_identity_legacy;
DROP TABLE sessions_identity_legacy;

ALTER TABLE api_tokens RENAME TO api_tokens_identity_legacy;
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created INTEGER NOT NULL
);
INSERT INTO api_tokens (id, account_id, label, token_hash, created)
SELECT id, user_id, label, token_hash, created FROM api_tokens_identity_legacy;
DROP TABLE api_tokens_identity_legacy;

ALTER TABLE page_visits RENAME TO page_visits_identity_legacy;
CREATE TABLE page_visits (
  account_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  visited INTEGER NOT NULL,
  last_seen_version INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, page_id)
);
INSERT INTO page_visits (account_id, page_id, visited, last_seen_version, views)
SELECT user_id, page_id, visited, last_seen_version, views
FROM page_visits_identity_legacy;
DROP TABLE page_visits_identity_legacy;
CREATE INDEX page_visits_page_id ON page_visits(page_id);

DROP TABLE users;
