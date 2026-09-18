ALTER TABLE "email_domains" DROP CONSTRAINT "email_domains_credential_kind_check";--> statement-breakpoint
ALTER TABLE "email_domains" ALTER COLUMN "token_ciphertext" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_domains" ALTER COLUMN "token_iv" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_domains" ALTER COLUMN "token_key_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_domains" ADD COLUMN "managed_by" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_platform_token_check" CHECK (("email_domains"."credential_kind" = 'platform') = ("email_domains"."token_ciphertext" IS NULL AND "email_domains"."token_iv" IS NULL AND "email_domains"."token_key_version" IS NULL));--> statement-breakpoint
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_managed_by_check" CHECK ("email_domains"."managed_by" IN ('owner', 'admin'));--> statement-breakpoint
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_credential_kind_check" CHECK ("email_domains"."credential_kind" IN ('oauth_grant', 'api_token', 'platform'));