ALTER TABLE "deployments" ADD COLUMN "proxy_token_gen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "proxy_token_gen" integer DEFAULT 0 NOT NULL;