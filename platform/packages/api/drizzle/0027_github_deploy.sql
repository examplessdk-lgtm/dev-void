CREATE TABLE IF NOT EXISTS "builds" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"executor" text DEFAULT 'container' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"commit_sha" text,
	"branch" text,
	"deployment_id" text,
	"github_run_id" text,
	"github_run_attempt" text,
	"logs_url" text,
	"error" text,
	"exit_code" integer,
	"instance_type" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"installation_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"repository_id" text,
	"branch" text DEFAULT 'main' NOT NULL,
	"build_executor" text DEFAULT 'container' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_connections_project_id_unique" UNIQUE("project_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"user_id" text,
	"account_login" text NOT NULL,
	"account_id" text NOT NULL,
	"account_type" text NOT NULL,
	"repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repository_selection" text DEFAULT 'selected' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "builds" ADD CONSTRAINT "builds_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "builds" ADD CONSTRAINT "builds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "builds" ADD CONSTRAINT "builds_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_builds_project_created" ON "builds" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_builds_status" ON "builds" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_builds_user_status" ON "builds" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_builds_project_github_run_id" ON "builds" USING btree ("project_id","github_run_id","github_run_attempt") WHERE "builds"."github_run_id" IS NOT NULL AND "builds"."github_run_attempt" IS NOT NULL AND "builds"."status" IN ('starting', 'building', 'deploying');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_connections_installation_id" ON "github_connections" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_connections_repo_full_name" ON "github_connections" USING btree ("repo_full_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_connections_installation_repo_id" ON "github_connections" USING btree ("installation_id","repository_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_installations_user_id" ON "github_installations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_github_installations_account_id" ON "github_installations" USING btree ("account_id");