ALTER TABLE "deployments" ADD COLUMN "retained" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "applied_migrations" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "active_deployment_id" text;