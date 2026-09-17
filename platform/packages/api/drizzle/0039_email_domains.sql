CREATE TABLE "email_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"domain" text NOT NULL,
	"zone_id" text,
	"account_id" text,
	"mode" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"credential_kind" text NOT NULL,
	"token_ciphertext" text NOT NULL,
	"token_iv" text NOT NULL,
	"token_key_version" text NOT NULL,
	"relay_ciphertext" text NOT NULL,
	"relay_iv" text NOT NULL,
	"relay_key_version" text NOT NULL,
	"relay_worker_name" text,
	"relay_version" integer,
	"token_id" text,
	"token_expires_on" timestamp,
	"setup_state" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_domains_domain_uq" UNIQUE("domain"),
	CONSTRAINT "email_domains_mode_check" CHECK ("email_domains"."mode" IN ('apex', 'subdomain')),
	CONSTRAINT "email_domains_status_check" CHECK ("email_domains"."status" IN ('pending', 'active', 'token_revoked', 'token_expired', 'failed')),
	CONSTRAINT "email_domains_credential_kind_check" CHECK ("email_domains"."credential_kind" IN ('oauth_grant', 'api_token'))
);
--> statement-breakpoint
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_email_domains_project_id" ON "email_domains" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_domains_zone_uq" ON "email_domains" USING btree ("zone_id") WHERE "email_domains"."zone_id" IS NOT NULL AND "email_domains"."status" IN ('active', 'pending');--> statement-breakpoint
CREATE UNIQUE INDEX "email_domains_relay_uq" ON "email_domains" USING btree ("account_id","relay_worker_name") WHERE "email_domains"."relay_worker_name" IS NOT NULL;