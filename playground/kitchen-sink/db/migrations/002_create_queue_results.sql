CREATE TABLE IF NOT EXISTS queue_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
