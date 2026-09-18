CREATE TABLE "platform_auth_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"revision" integer NOT NULL,
	"generation" integer NOT NULL,
	"purpose" text NOT NULL,
	"browser_hash" text NOT NULL,
	"context" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_auth_bootstrap" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"installation_id" text NOT NULL,
	"credential_hash" text NOT NULL,
	"connection_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	CONSTRAINT "platform_auth_bootstrap_singleton" CHECK ("platform_auth_bootstrap"."singleton" = true)
);
--> statement-breakpoint
CREATE TABLE "platform_auth_settings" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"admission" jsonb NOT NULL,
	"protection" jsonb,
	"session_seconds" integer DEFAULT 2592000 NOT NULL,
	"sessions_required" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_auth_settings_singleton" CHECK ("platform_auth_settings"."singleton" = true),
	CONSTRAINT "platform_auth_settings_revision" CHECK ("platform_auth_settings"."revision" > 0),
	CONSTRAINT "platform_auth_settings_session_seconds" CHECK ("platform_auth_settings"."session_seconds" BETWEEN 300 AND 2592000)
);
--> statement-breakpoint
CREATE TABLE "platform_company_identities" (
	"user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	CONSTRAINT "platform_company_identities_issuer_subject_pk" PRIMARY KEY("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "platform_human_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"generation" integer NOT NULL,
	"audience" text NOT NULL,
	"access_issuer" text,
	"access_subject" text,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_human_sessions_audience" CHECK ("platform_human_sessions"."audience" IN ('api', 'admin')),
	CONSTRAINT "platform_human_sessions_access_identity" CHECK (("platform_human_sessions"."access_issuer" IS NULL) = ("platform_human_sessions"."access_subject" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "platform_login_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"active_revision" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_login_connections_kind" CHECK ("platform_login_connections"."kind" IN ('github', 'google', 'oidc', 'cloudflare-access')),
	CONSTRAINT "platform_login_connections_revision" CHECK ("platform_login_connections"."revision" > 0 AND "platform_login_connections"."generation" > 0),
	CONSTRAINT "platform_login_connections_active_revision" CHECK ("platform_login_connections"."active_revision" IS NULL OR "platform_login_connections"."active_revision" BETWEEN 1 AND "platform_login_connections"."revision"),
	CONSTRAINT "platform_login_connections_enabled" CHECK (NOT "platform_login_connections"."enabled" OR "platform_login_connections"."active_revision" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "platform_login_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"last_authenticated_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_login_revisions" (
	"connection_id" text NOT NULL,
	"revision" integer NOT NULL,
	"configuration" jsonb NOT NULL,
	"secret" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_login_revisions_connection_id_revision_pk" PRIMARY KEY("connection_id","revision")
);
--> statement-breakpoint
CREATE TABLE "platform_login_tests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"revision" integer NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_sessions" ADD COLUMN "human_session_id" text;--> statement-breakpoint
ALTER TABLE "platform_auth_attempts" ADD CONSTRAINT "platform_auth_attempts_connection_id_platform_login_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_login_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_auth_bootstrap" ADD CONSTRAINT "platform_auth_bootstrap_connection_id_platform_login_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_login_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_company_identities" ADD CONSTRAINT "platform_company_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_human_sessions" ADD CONSTRAINT "platform_human_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_human_sessions" ADD CONSTRAINT "platform_human_sessions_connection_id_platform_login_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_login_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_login_identities" ADD CONSTRAINT "platform_login_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_login_identities" ADD CONSTRAINT "platform_login_identities_connection_id_platform_login_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_login_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_login_revisions" ADD CONSTRAINT "platform_login_revisions_connection_id_platform_login_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_login_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_login_tests" ADD CONSTRAINT "platform_login_tests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_login_tests" ADD CONSTRAINT "platform_login_tests_connection_id_platform_login_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."platform_login_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_auth_attempts_expiry" ON "platform_auth_attempts" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_company_identity_user" ON "platform_company_identities" USING btree ("issuer","user_id");--> statement-breakpoint
CREATE INDEX "platform_human_sessions_connection" ON "platform_human_sessions" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "platform_human_sessions_user" ON "platform_human_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "platform_human_sessions_expiry" ON "platform_human_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_login_identity_subject" ON "platform_login_identities" USING btree ("connection_id","issuer","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_login_identity_user" ON "platform_login_identities" USING btree ("connection_id","user_id");--> statement-breakpoint
CREATE INDEX "platform_login_tests_expiry" ON "platform_login_tests" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_human_session_id_platform_human_sessions_id_fk" FOREIGN KEY ("human_session_id") REFERENCES "public"."platform_human_sessions"("id") ON DELETE cascade ON UPDATE no action;