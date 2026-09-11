ALTER TABLE "auth_codes" ADD COLUMN "cli_state" text;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "code_challenge" text;--> statement-breakpoint
ALTER TABLE "auth_codes" ADD COLUMN "code_challenge_method" text;