-- Bind a multi-page mutation plan once, then let every statement in the batch read it here.
ALTER TABLE page_mutation_guard ADD COLUMN payload TEXT;
