CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);
--> statement-breakpoint
INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com');
--> statement-breakpoint
INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com');
--> statement-breakpoint
INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com');
