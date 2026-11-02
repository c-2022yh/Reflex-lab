CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY NOT NULL,
  nickname TEXT NOT NULL,
  samples TEXT NOT NULL,
  average INTEGER NOT NULL,
  fastest INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_ranking_idx ON scores (average, created_at, id);
