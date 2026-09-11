CREATE TABLE "migration_renames" (
	"project_id" text NOT NULL,
	"from_name" text NOT NULL,
	"to_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "migration_renames_project_id_from_name_to_name_pk" PRIMARY KEY("project_id","from_name","to_name")
);
--> statement-breakpoint
ALTER TABLE "migration_renames" ADD CONSTRAINT "migration_renames_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_migration_renames_project_id" ON "migration_renames" USING btree ("project_id");