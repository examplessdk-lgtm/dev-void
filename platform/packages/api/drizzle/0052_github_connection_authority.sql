UPDATE "github_installations"
SET "user_id" = NULL
WHERE "account_type" = 'Organization' AND "user_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "github_connections"
SET "authorized_by_user_id" = "projects"."user_id"
FROM "projects", "github_installations"
WHERE
	"github_connections"."authorized_by_user_id" IS NULL
	AND "projects"."id" = "github_connections"."project_id"
	AND "github_installations"."installation_id" = "github_connections"."installation_id"
	AND "github_installations"."account_type" = 'User'
	AND "github_installations"."user_id" = "projects"."user_id";
--> statement-breakpoint
UPDATE "builds"
SET
	"status" = 'cancelled',
	"error" = COALESCE("builds"."error", 'github repository authorization is no longer valid; reconnect the repository'),
	"completed_at" = COALESCE("builds"."completed_at", now())
FROM "github_connections", "projects"
WHERE
	"github_connections"."project_id" = "builds"."project_id"
	AND "projects"."id" = "github_connections"."project_id"
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
	AND "builds"."status" IN ('queued', 'starting', 'building', 'deploying');
--> statement-breakpoint
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
	);
--> statement-breakpoint
DELETE FROM "github_installation_members"
USING "github_installations"
WHERE
	"github_installations"."installation_id" = "github_installation_members"."installation_id"
	AND "github_installations"."account_type" = 'User';
