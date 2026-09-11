CREATE TABLE "github_webhook_redeliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"guid" text NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text,
	"status_code" integer,
	"redelivered_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_github_webhook_redeliveries_guid" ON "github_webhook_redeliveries" USING btree ("guid");