CREATE TABLE "email_shared_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"project_id" text NOT NULL,
	"route_id" text NOT NULL,
	"recipient" text NOT NULL,
	"rule_name" text NOT NULL,
	"rule_id" text,
	"create_started_at" timestamp with time zone,
	"removing" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_started_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_shared_recipients_project_address_uq" ON "email_shared_recipients" USING btree ("installation_id","project_id","recipient");--> statement-breakpoint
CREATE UNIQUE INDEX "email_shared_recipients_rule_name_uq" ON "email_shared_recipients" USING btree ("rule_name");--> statement-breakpoint
CREATE INDEX "email_shared_recipients_reconcile_idx" ON "email_shared_recipients" USING btree ("status","updated_at");
--> statement-breakpoint
-- Keep older runtimes from releasing a reusable slug while a provider rule
-- or uncertain creation remains. Current cleanup marks rows removed only
-- after exact provider absence readback. The ledger intentionally has no FK
-- cascade: its ownership history must survive project deletion.
CREATE FUNCTION "void_shared_email_recipient_teardown_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.slug IS NOT DISTINCT FROM OLD.slug THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "email_shared_recipients"
    WHERE "project_id" = OLD.id AND "status" <> 'removed'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'Shared email recipient cleanup is not complete; use a current Void Platform runtime to reconcile cleanup before deleting or renaming this project';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "void_shared_email_recipient_teardown_guard"
BEFORE DELETE OR UPDATE OF "slug" ON "projects"
FOR EACH ROW EXECUTE FUNCTION "void_shared_email_recipient_teardown_guard"();
