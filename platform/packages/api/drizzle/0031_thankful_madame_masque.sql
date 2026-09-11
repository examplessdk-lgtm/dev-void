CREATE TABLE "github_installation_revocations" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"github_account_id" text NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_installation_revocations_install_account" ON "github_installation_revocations" USING btree ("installation_id","github_account_id");