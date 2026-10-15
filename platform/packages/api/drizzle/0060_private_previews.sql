CREATE TABLE "preview_tickets" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD COLUMN "scopes" jsonb DEFAULT '["profile"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "preview_client_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "preview_workspace_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "preview_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "preview_tickets" ADD CONSTRAINT "preview_tickets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_tickets" ADD CONSTRAINT "preview_tickets_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_preview_client_id_oauth_clients_id_fk" FOREIGN KEY ("preview_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_preview_workspace" ON "projects" USING btree ("preview_client_id","user_id","preview_workspace_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_preview_identity" CHECK (("projects"."preview_client_id" IS NULL AND "projects"."preview_workspace_id" IS NULL AND "projects"."preview_expires_at" IS NULL) OR ("projects"."preview_client_id" IS NOT NULL AND "projects"."preview_workspace_id" IS NOT NULL AND "projects"."preview_expires_at" IS NOT NULL AND "projects"."slug" LIKE 'preview-%'));