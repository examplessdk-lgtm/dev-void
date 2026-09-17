ALTER TABLE "deployments" ADD COLUMN "admission_protocol" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_drain_checkpoints" ADD COLUMN "admission_protocol" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
INSERT INTO "sandbox_drain_checkpoints" (
	"singleton", "admission_protocol", "generation", "state", "phase", "cursor"
) VALUES (
	true, 0, 'deployment-admission-bootstrap', 'draining', 'deployments', '{"pass":"1"}'::jsonb
) ON CONFLICT ("singleton") DO NOTHING;--> statement-breakpoint
CREATE FUNCTION "void_enforce_deployment_admission_protocol"() RETURNS trigger AS $$
DECLARE
	"required_protocol" integer;
BEGIN
	SELECT "admission_protocol" INTO "required_protocol"
	FROM "sandbox_drain_checkpoints"
	WHERE "singleton" = true
	FOR SHARE;
	IF COALESCE("required_protocol", 0) > NEW."admission_protocol" THEN
		RAISE EXCEPTION 'deployment admission protocol % is below required protocol %', NEW."admission_protocol", "required_protocol"
			USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "deployments_admission_protocol"
	BEFORE INSERT ON "deployments"
	FOR EACH ROW EXECUTE FUNCTION "void_enforce_deployment_admission_protocol"();
