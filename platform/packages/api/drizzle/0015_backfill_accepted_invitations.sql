UPDATE "invitations"
SET
	"status" = 'accepted',
	"accepted_by" = "users"."id",
	"accepted_at" = COALESCE(
		"invitations"."accepted_at",
		GREATEST("invitations"."created_at", "users"."created_at"),
		now()
	)
FROM "users"
WHERE
	"invitations"."status" = 'pending'
	AND "users"."email" IS NOT NULL
	AND lower("invitations"."email") = lower("users"."email");
