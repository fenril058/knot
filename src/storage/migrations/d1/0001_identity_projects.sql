CREATE TABLE actors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL UNIQUE REFERENCES actors(id) ON DELETE RESTRICT,
  name TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  created INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
