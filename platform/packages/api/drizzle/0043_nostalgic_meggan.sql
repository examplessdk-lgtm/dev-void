ALTER TABLE "platform_auth_attempts" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_auth_bootstrap" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_auth_bootstrap" ALTER COLUMN "consumed_at" SET DATA TYPE timestamp with time zone USING "consumed_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_auth_settings" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_auth_settings" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "platform_human_sessions" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_human_sessions" ALTER COLUMN "revoked_at" SET DATA TYPE timestamp with time zone USING "revoked_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_human_sessions" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_human_sessions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "platform_login_connections" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_login_connections" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "platform_login_identities" ALTER COLUMN "last_authenticated_at" SET DATA TYPE timestamp with time zone USING "last_authenticated_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_login_identities" ALTER COLUMN "last_authenticated_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "platform_login_identities" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_login_identities" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "platform_login_revisions" ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone USING "created_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_login_revisions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "platform_login_tests" ALTER COLUMN "expires_at" SET DATA TYPE timestamp with time zone USING "expires_at" AT TIME ZONE 'UTC';--> statement-breakpoint
ALTER TABLE "platform_auth_bootstrap" ADD COLUMN "request_hash" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_auth_bootstrap" ADD COLUMN "claim_hash" text;--> statement-breakpoint
ALTER TABLE "platform_auth_bootstrap" ADD COLUMN "pending_identity" jsonb;
