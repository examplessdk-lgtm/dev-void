INSERT INTO users (name, email) VALUES
  ('Alice', 'alice@example.com'),
  ('Bob', 'bob@example.com'),
  ('Charlie', 'charlie@example.com');

INSERT INTO posts (title, body, author_id) VALUES
  ('Hello World', 'First post from Alice', 1),
  ('PostgreSQL Tips', 'Hyperdrive is fast', 2),
  ('Drizzle ORM', 'Type-safe queries are great', 1);
