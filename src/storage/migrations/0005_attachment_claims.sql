ALTER TABLE attachments ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0 CHECK (provisional IN (0, 1));

CREATE TABLE attachment_claims (
  attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  PRIMARY KEY (attachment_id, owner)
);

CREATE INDEX attachment_claims_owner ON attachment_claims(owner);
