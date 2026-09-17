CREATE TABLE "sandbox_drain_checkpoints" (
	"singleton" boolean PRIMARY KEY NOT NULL,
	"generation" text NOT NULL,
	"state" text NOT NULL,
	"phase" text NOT NULL,
	"cursor" jsonb,
	"lease_owner" text,
	"lease_expires_at" timestamp,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "idx_deployments_created_id" ON "deployments" USING btree ("created_at","id");