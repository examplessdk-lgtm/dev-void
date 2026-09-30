CREATE TABLE "project_zero_trust" (
	"project_id" text PRIMARY KEY NOT NULL,
	"desired_protected" boolean DEFAULT false NOT NULL,
	"effective_protected" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'public' NOT NULL,
	"bypass_application_id" text,
	"bypass_application_name" text,
	"protected_application_id" text,
	"protected_application_name" text,
	"protected_application_audience" text,
	"routing_cursor" text,
	"reconciled_operation" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_zero_trust_state_check" CHECK ("project_zero_trust"."state" IN ('public', 'protected', 'reconciling', 'error')),
	CONSTRAINT "project_zero_trust_public_check" CHECK ("project_zero_trust"."state" <> 'public' OR ("project_zero_trust"."desired_protected" = false AND "project_zero_trust"."effective_protected" = false)),
	CONSTRAINT "project_zero_trust_protected_check" CHECK ("project_zero_trust"."state" <> 'protected' OR ("project_zero_trust"."desired_protected" = true AND "project_zero_trust"."effective_protected" = true))
);
--> statement-breakpoint
ALTER TABLE "project_zero_trust" ADD CONSTRAINT "project_zero_trust_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_zero_trust_state" ON "project_zero_trust" USING btree ("state","updated_at");