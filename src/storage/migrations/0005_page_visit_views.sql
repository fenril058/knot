ALTER TABLE page_visits ADD COLUMN views INTEGER NOT NULL DEFAULT 1;
CREATE INDEX page_visits_page_id ON page_visits(page_id);
