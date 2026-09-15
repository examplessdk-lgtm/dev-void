CREATE TABLE "operator_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"login" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"status" text NOT NULL,
	"http_status" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operator_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "operator_sessions" ADD CONSTRAINT "operator_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_operator_events_created" ON "operator_events" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "idx_operator_sessions_expiry" ON "operator_sessions" USING btree ("expires_at");