CREATE TABLE "github_installation_members" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"github_account_id" text,
	"verified_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installation_members" ADD CONSTRAINT "github_installation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_installation_members_install_user" ON "github_installation_members" USING btree ("installation_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_github_installation_members_user_id" ON "github_installation_members" USING btree ("user_id");