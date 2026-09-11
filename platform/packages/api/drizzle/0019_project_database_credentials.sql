CREATE TABLE "project_database_credentials" (
  "project_id" text PRIMARY KEY NOT NULL,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "key_version" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_database_credentials" ADD CONSTRAINT "project_database_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
