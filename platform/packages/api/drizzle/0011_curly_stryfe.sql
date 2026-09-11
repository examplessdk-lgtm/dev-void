ALTER TABLE "projects" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;