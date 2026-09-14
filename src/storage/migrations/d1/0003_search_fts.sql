-- D1 が trigram FTS5 を受理することを確認し、SQLite と同じ検索順序と index を使う。
-- 0002 適用済みの DB を forward-only で移行するため、0002 の page_search を移送後に削除する。
CREATE VIRTUAL TABLE pages_fts USING fts5(
  page_id UNINDEXED,
  project_id UNINDEXED,
  content,
  tokenize='trigram'
);

INSERT INTO pages_fts (page_id, project_id, content)
SELECT page_id, project_id, content FROM page_search;

DROP TABLE page_search;
