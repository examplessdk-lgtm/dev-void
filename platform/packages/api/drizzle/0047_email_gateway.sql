CREATE TABLE "email_cache_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload" jsonb,
	"published_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"managed_by" text NOT NULL,
	"manager_user_id" text,
	"kind" text NOT NULL,
	"account_id" text NOT NULL,
	"zone_id" text NOT NULL,
	"ciphertext" text,
	"iv" text,
	"key_version" text,
	"token_id" text,
	"expires_on" timestamp,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'healthy' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_credentials_material_check" CHECK (("email_credentials"."kind" = 'platform' AND "email_credentials"."ciphertext" IS NULL AND "email_credentials"."iv" IS NULL AND "email_credentials"."key_version" IS NULL) OR ("email_credentials"."kind" = 'api_token' AND "email_credentials"."ciphertext" IS NOT NULL AND "email_credentials"."iv" IS NOT NULL AND "email_credentials"."key_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "email_domain_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"connection_id" text NOT NULL,
	"project_id" text,
	"addressing" text NOT NULL,
	"managed_by" text NOT NULL,
	"assigned_by_user_id" text,
	"desired_state" text DEFAULT 'active' NOT NULL,
	"inbound_status" text DEFAULT 'pending' NOT NULL,
	"inbound_reason" text,
	"inbound_observed_at" timestamp,
	"outbound_status" text DEFAULT 'pending' NOT NULL,
	"outbound_reason" text,
	"outbound_observed_at" timestamp,
	"desired_generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_domain_routes_assignment_check" CHECK (("email_domain_routes"."addressing" = 'custom' AND "email_domain_routes"."project_id" IS NOT NULL) OR ("email_domain_routes"."addressing" = 'shared' AND "email_domain_routes"."project_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "email_operation_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"operation_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" text NOT NULL,
	"resource_identity" text NOT NULL,
	"request_digest" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"outcome" jsonb,
	"failure_code" text,
	"failure_detail" text,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "email_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"route_id" text,
	"actor_kind" text NOT NULL,
	"actor_user_id" text,
	"actor_scope" text NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_digest" text NOT NULL,
	"desired_generation" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"current_step" text,
	"failure_code" text,
	"failure_detail" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_zone_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"account_id" text NOT NULL,
	"zone_id" text NOT NULL,
	"zone_name" text NOT NULL,
	"managed_by" text NOT NULL,
	"manager_user_id" text,
	"credential_id" text,
	"ingress_worker_name" text NOT NULL,
	"ingress_version" integer,
	"desired_generation" integer DEFAULT 1 NOT NULL,
	"active_secret_generation" integer DEFAULT 0 NOT NULL,
	"staged_secret_generation" integer,
	"secret_ciphertext" text NOT NULL,
	"secret_iv" text NOT NULL,
	"secret_key_version" text NOT NULL,
	"staged_secret_ciphertext" text,
	"staged_secret_iv" text,
	"staged_secret_key_version" text,
	"previous_secret_hash" text,
	"previous_secret_until" timestamp,
	"inbound_status" text DEFAULT 'pending' NOT NULL,
	"inbound_reason" text,
	"inbound_observed_at" timestamp,
	"management_status" text DEFAULT 'probe_failed' NOT NULL,
	"management_reason" text,
	"management_observed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "email_zone_connections_manager_check" CHECK (("email_zone_connections"."managed_by" = 'owner' AND "email_zone_connections"."manager_user_id" IS NOT NULL) OR ("email_zone_connections"."managed_by" = 'admin'))
);
--> statement-breakpoint
CREATE TABLE "email_action_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"project_id" text NOT NULL,
	"recipient" text NOT NULL,
	"state" text NOT NULL,
	"error_code" text,
	"provider_reference" text,
	"reserved_at" timestamp with time zone,
	"attempt_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "email_action_recipients_action_recipient_uq" UNIQUE("action_id","recipient"),
	CONSTRAINT "email_action_recipients_state_check" CHECK ("email_action_recipients"."state" IN ('rejected', 'reserved', 'attempt_started', 'provider_accepted', 'failed', 'outcome_unknown', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "email_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sender_domain" text NOT NULL,
	"receipt_id" text,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"transport" text NOT NULL,
	"policy_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_actions_project_key_uq" UNIQUE("project_id","idempotency_key"),
	CONSTRAINT "email_actions_kind_check" CHECK ("email_actions"."kind" IN ('direct', 'forward', 'reply'))
);
--> statement-breakpoint
CREATE TABLE "email_monthly_usage" (
	"project_id" text NOT NULL,
	"month" text NOT NULL,
	"recipient_attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "email_monthly_usage_project_month_uq" UNIQUE("project_id","month"),
	CONSTRAINT "email_monthly_usage_nonnegative_check" CHECK ("email_monthly_usage"."recipient_attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "email_project_controls" (
	"project_id" text PRIMARY KEY NOT NULL,
	"monthly_limit" integer DEFAULT 200 NOT NULL,
	"burst_limit" integer DEFAULT 10 NOT NULL,
	"suspended_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"payload_digest" text,
	"final_reject" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_unresolved_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"sender_domain" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_domain_routes" ADD CONSTRAINT "email_domain_routes_connection_id_email_zone_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."email_zone_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_operation_steps" ADD CONSTRAINT "email_operation_steps_operation_id_email_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."email_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_operations" ADD CONSTRAINT "email_operations_connection_id_email_zone_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."email_zone_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_operations" ADD CONSTRAINT "email_operations_route_id_email_domain_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."email_domain_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_action_recipients" ADD CONSTRAINT "email_action_recipients_action_id_email_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."email_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_actions" ADD CONSTRAINT "email_actions_receipt_id_email_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."email_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_project_controls" ADD CONSTRAINT "email_project_controls_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_cache_outbox_version_uq" ON "email_cache_outbox" USING btree ("resource_kind","resource_id","version");--> statement-breakpoint
CREATE INDEX "email_cache_outbox_pending_idx" ON "email_cache_outbox" USING btree ("published_at","created_at");--> statement-breakpoint
CREATE INDEX "email_credentials_scope_idx" ON "email_credentials" USING btree ("installation_id","account_id","zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_domain_routes_domain_uq" ON "email_domain_routes" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "email_domain_routes_connection_idx" ON "email_domain_routes" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "email_domain_routes_project_idx" ON "email_domain_routes" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_operation_steps_order_uq" ON "email_operation_steps" USING btree ("operation_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "email_operations_key_uq" ON "email_operations" USING btree ("installation_id","actor_scope","idempotency_key");--> statement-breakpoint
CREATE INDEX "email_operations_work_idx" ON "email_operations" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "email_operations_connection_idx" ON "email_operations" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_zone_connections_zone_uq" ON "email_zone_connections" USING btree ("installation_id","account_id","zone_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_zone_connections_ingress_uq" ON "email_zone_connections" USING btree ("account_id","ingress_worker_name");--> statement-breakpoint
CREATE INDEX "email_zone_connections_manager_idx" ON "email_zone_connections" USING btree ("manager_user_id");--> statement-breakpoint
CREATE INDEX "idx_email_action_recipients_project_reserved" ON "email_action_recipients" USING btree ("project_id","reserved_at");--> statement-breakpoint
CREATE INDEX "idx_email_actions_project_created" ON "email_actions" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_email_receipts_project_created" ON "email_receipts" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_email_unresolved_attempts_project" ON "email_unresolved_attempts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_email_unresolved_attempts_domain" ON "email_unresolved_attempts" USING btree ("sender_domain");
--> statement-breakpoint
CREATE TABLE "email_destination_cleanups" (
	"cf_destination_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_destination_cleanups_status_check" CHECK ("email_destination_cleanups"."status" IN ('pending', 'deleting', 'completed')),
	CONSTRAINT "email_destination_cleanups_attempts_check" CHECK ("email_destination_cleanups"."attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX "idx_email_destination_cleanups_due" ON "email_destination_cleanups" USING btree ("status","next_attempt_at","updated_at");
