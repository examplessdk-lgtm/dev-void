CREATE TABLE "auth_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"jwt" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
