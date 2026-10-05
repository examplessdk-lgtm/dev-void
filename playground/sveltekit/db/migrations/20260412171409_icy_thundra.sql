CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL
);
--> statement-breakpoint
INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com');
--> statement-breakpoint
INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com');
--> statement-breakpoint
INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com');
