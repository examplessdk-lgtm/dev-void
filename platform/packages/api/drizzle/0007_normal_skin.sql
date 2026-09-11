CREATE TABLE "oauth_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL
);
