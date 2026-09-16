-- Every successful D1 page mutation advances its project's optimistic concurrency token.
-- Rename guards this token so a backlink snapshot cannot miss an intervening page commit.
CREATE TABLE page_mutation_revisions (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 0)
);
