CREATE TABLE "platform_events" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text,
	"action" text NOT NULL,
	"worker_name" text NOT NULL,
	"environment" text NOT NULL,
	"version_id" text NOT NULL,
	"script_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"admin_user_id" text NOT NULL,
	"admin_login" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_platform_events_batch_id" ON "platform_events" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "idx_platform_events_env_created" ON "platform_events" USING btree ("environment","created_at");