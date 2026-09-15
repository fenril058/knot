-- A guarded batch inserts the only valid value and removes it before commit.
-- A stale snapshot inserts 0, making the CHECK fail and rolling back the full batch.
CREATE TABLE page_mutation_guard (
  locked INTEGER PRIMARY KEY CHECK (locked = 1)
);
