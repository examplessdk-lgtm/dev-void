WITH "removed_connections" AS (
	DELETE FROM "github_connections"
	USING "projects"
	WHERE
		"projects"."id" = "github_connections"."project_id"
		AND (
			"github_connections"."authorized_by_user_id" IS NULL
			OR "github_connections"."repository_id" IS NULL
			OR NOT (
				"github_connections"."authorized_by_user_id" = "projects"."user_id"
				OR EXISTS (
					SELECT 1
					FROM "project_members"
					WHERE
						"project_members"."project_id" = "projects"."id"
						AND "project_members"."user_id" = "github_connections"."authorized_by_user_id"
						AND "project_members"."role" = 'admin'
				)
			)
		)
	RETURNING "github_connections"."project_id"
)
UPDATE "builds"
SET
	"status" = 'cancelled',
	"error" = COALESCE("builds"."error", 'github repository authorization is no longer valid; reconnect the repository'),
	"completed_at" = COALESCE("builds"."completed_at", now())
FROM "removed_connections"
WHERE
	"builds"."project_id" = "removed_connections"."project_id"
	AND "builds"."status" IN ('queued', 'starting', 'building', 'deploying');
--> statement-breakpoint
UPDATE "github_installations"
SET "user_id" = NULL
WHERE "account_type" = 'Organization' AND "user_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "github_connections" DROP CONSTRAINT "github_connections_authorized_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "github_connections" ALTER COLUMN "repository_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "github_connections" ALTER COLUMN "authorized_by_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;