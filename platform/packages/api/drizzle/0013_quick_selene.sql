ALTER TABLE "deployments" ADD COLUMN "repository_url" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "commit_url" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "git_ref" text;