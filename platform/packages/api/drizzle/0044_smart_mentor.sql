CREATE TABLE "project_deploy_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"issued_by" text NOT NULL,
	"name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_deploy_credentials_name" CHECK (length("project_deploy_credentials"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
ALTER TABLE "project_deploy_credentials" ADD CONSTRAINT "project_deploy_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_deploy_credentials" ADD CONSTRAINT "project_deploy_credentials_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_deploy_credentials_project" ON "project_deploy_credentials" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_deploy_credentials_expiry" ON "project_deploy_credentials" USING btree ("expires_at");