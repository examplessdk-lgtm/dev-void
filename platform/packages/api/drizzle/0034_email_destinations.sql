CREATE TABLE "email_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"cf_destination_id" text,
	"verified_at" timestamp,
	"verification_source" text DEFAULT 'cf' NOT NULL,
	"verified_by_user_id" text,
	"verified_by_email_snapshot" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_destinations_project_address_uq" UNIQUE("project_id","address"),
	CONSTRAINT "email_destinations_status_check" CHECK ("email_destinations"."status" IN ('pending', 'verified')),
	CONSTRAINT "email_destinations_verification_source_check" CHECK ("email_destinations"."verification_source" IN ('cf', 'platform'))
);
--> statement-breakpoint
ALTER TABLE "email_destinations" ADD CONSTRAINT "email_destinations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_destinations" ADD CONSTRAINT "email_destinations_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_email_destinations_project_id" ON "email_destinations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_email_destinations_cf_destination_id" ON "email_destinations" USING btree ("cf_destination_id");--> statement-breakpoint
CREATE INDEX "idx_email_destinations_verified_by_user_id" ON "email_destinations" USING btree ("verified_by_user_id","verified_by_email_snapshot");