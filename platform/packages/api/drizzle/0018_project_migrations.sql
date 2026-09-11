CREATE TABLE "project_migrations" (
  "project_id" text NOT NULL,
  "name" text NOT NULL,
  "applied_at" timestamp DEFAULT now() NOT NULL,
  "source_deployment_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "project_migrations_project_id_name_pk" PRIMARY KEY("project_id","name")
);
--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_migrations" ADD CONSTRAINT "project_migrations_source_deployment_id_deployments_id_fk" FOREIGN KEY ("source_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_project_migrations_project_id" ON "project_migrations" USING btree ("project_id","applied_at");
--> statement-breakpoint
INSERT INTO "project_migrations" ("project_id", "name", "source_deployment_id")
SELECT DISTINCT d."project_id", migration.name, d."id"
FROM "deployments" d
CROSS JOIN LATERAL jsonb_array_elements_text((d."applied_migrations")::jsonb) AS migration(name)
WHERE d."applied_migrations" IS NOT NULL
ON CONFLICT DO NOTHING;
