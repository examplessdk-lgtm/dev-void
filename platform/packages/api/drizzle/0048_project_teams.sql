CREATE TABLE "project_access_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"subject_user_id" text,
	"invitation_email_snapshot" text,
	"previous_role" text,
	"new_role" text,
	"action" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_events_previous_role_check" CHECK ("project_access_events"."previous_role" IS NULL OR "project_access_events"."previous_role" IN ('reader', 'collaborator', 'admin')),
	CONSTRAINT "project_access_events_new_role_check" CHECK ("project_access_events"."new_role" IS NULL OR "project_access_events"."new_role" IN ('reader', 'collaborator', 'admin')),
	CONSTRAINT "project_access_events_action_check" CHECK ("project_access_events"."action" IN ('invited', 'invitation_resent', 'accepted', 'declined', 'invitation_revoked', 'role_changed', 'member_removed', 'left'))
);
--> statement-breakpoint
CREATE TABLE "project_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"target_user_id" text NOT NULL,
	"target_email_snapshot" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text NOT NULL,
	"accepted_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by_user_id" text,
	CONSTRAINT "project_invitations_role_check" CHECK ("project_invitations"."role" IN ('reader', 'collaborator', 'admin')),
	CONSTRAINT "project_invitations_status_check" CHECK ("project_invitations"."status" IN ('pending', 'accepted', 'declined', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"added_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id"),
	CONSTRAINT "project_members_role_check" CHECK ("project_members"."role" IN ('reader', 'collaborator', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "project_ownership_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp,
	"changed_by_user_id" text,
	CONSTRAINT "project_ownership_periods_time_check" CHECK ("project_ownership_periods"."ends_at" IS NULL OR "project_ownership_periods"."ends_at" >= "project_ownership_periods"."starts_at")
);
--> statement-breakpoint
ALTER TABLE "builds" ADD COLUMN "triggered_by_user_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "billing_user_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "initiated_by_user_id" text;--> statement-breakpoint
UPDATE "deployments" AS "deployment"
SET "billing_user_id" = "project"."user_id"
FROM "projects" AS "project"
WHERE "deployment"."project_id" = "project"."id"
	AND "deployment"."billing_user_id" IS NULL;--> statement-breakpoint
INSERT INTO "project_ownership_periods" (
	"id",
	"project_id",
	"owner_user_id",
	"starts_at"
)
SELECT
	'pown_' || "project"."id",
	"project"."id",
	"project"."user_id",
	"project"."created_at"
FROM "projects" AS "project"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "project_access_events" ADD CONSTRAINT "project_access_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_invitations" ADD CONSTRAINT "project_invitations_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_ownership_periods" ADD CONSTRAINT "project_ownership_periods_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_access_events_project_created" ON "project_access_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_project_access_events_subject_created" ON "project_access_events" USING btree ("subject_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_project_invitations_project_status" ON "project_invitations" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "idx_project_invitations_target_status" ON "project_invitations" USING btree ("target_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_invitations_pending_target" ON "project_invitations" USING btree ("project_id","target_user_id") WHERE "project_invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "idx_project_members_user_project" ON "project_members" USING btree ("user_id","project_id");--> statement-breakpoint
CREATE INDEX "idx_project_ownership_periods_owner_time" ON "project_ownership_periods" USING btree ("owner_user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "idx_project_ownership_periods_project_time" ON "project_ownership_periods" USING btree ("project_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_ownership_periods_open" ON "project_ownership_periods" USING btree ("project_id") WHERE "project_ownership_periods"."ends_at" IS NULL;
