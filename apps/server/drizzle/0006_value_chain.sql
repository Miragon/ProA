CREATE TABLE "placement" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"value_chain_id" text NOT NULL,
	"element_id" text NOT NULL,
	"generation" integer NOT NULL,
	"process_ref" text NOT NULL,
	"process_model" text GENERATED ALWAYS AS (split_part(process_ref, '#', 1)) STORED NOT NULL,
	"status" text NOT NULL,
	"endpoint_state" text NOT NULL,
	"tier" text NOT NULL,
	"confidence" double precision,
	"version" integer DEFAULT 1 NOT NULL,
	"step_fp" text,
	"process_fp" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placement_natural_key_unique" UNIQUE("project_id","value_chain_id","element_id","generation","process_ref"),
	CONSTRAINT "placement_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "placement_status_check" CHECK ("placement"."status" in ('proposed', 'accepted', 'rejected', 'held', 'obsolete')),
	CONSTRAINT "placement_endpoint_state_check" CHECK ("placement"."endpoint_state" in ('ok', 'changed', 'missing')),
	CONSTRAINT "placement_tier_check" CHECK ("placement"."tier" in ('key', 'lexical', 'semantic', 'manual')),
	CONSTRAINT "placement_confidence_check" CHECK ("placement"."confidence" is null or "placement"."confidence" between 0 and 1),
	CONSTRAINT "placement_generation_check" CHECK ("placement"."generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "placement_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"placement_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"verdict" text,
	"source_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"client_id" text,
	"declared" jsonb,
	"submission_id" text,
	"tier" text,
	"confidence" double precision,
	"rationale" text,
	"evidence" jsonb,
	"question" text,
	"label" text,
	"linked_placement_id" text,
	"step_fp" text,
	"process_fp" text,
	"step_hash" text,
	"process_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placement_assertion_agents_never_decide" CHECK (not ("placement_assertion"."kind" = 'decision' and "placement_assertion"."source_kind" = 'agent')),
	CONSTRAINT "placement_assertion_rules_never_decide" CHECK (not ("placement_assertion"."kind" = 'decision' and "placement_assertion"."source_kind" = 'rule')),
	CONSTRAINT "placement_assertion_notes_by_humans" CHECK ("placement_assertion"."kind" <> 'note' or "placement_assertion"."source_kind" = 'human'),
	CONSTRAINT "placement_assertion_verdict_check" CHECK (("placement_assertion"."kind" = 'decision') = ("placement_assertion"."verdict" is not null) and ("placement_assertion"."verdict" is null or "placement_assertion"."verdict" in ('accept', 'reject', 'hold'))),
	CONSTRAINT "placement_assertion_kind_check" CHECK ("placement_assertion"."kind" in ('proposal', 'withdrawal', 'decision', 'note')),
	CONSTRAINT "placement_assertion_source_kind_check" CHECK ("placement_assertion"."source_kind" in ('human', 'agent', 'rule')),
	CONSTRAINT "placement_assertion_tier_check" CHECK ("placement_assertion"."tier" is null or "placement_assertion"."tier" in ('key', 'lexical', 'semantic', 'manual')),
	CONSTRAINT "placement_assertion_confidence_check" CHECK ("placement_assertion"."confidence" is null or "placement_assertion"."confidence" between 0 and 1),
	CONSTRAINT "placement_assertion_basis_check" CHECK (("placement_assertion"."step_hash" is null) = ("placement_assertion"."process_hash" is null) and ("placement_assertion"."step_hash" is null or "placement_assertion"."kind" = 'proposal'))
);
--> statement-breakpoint
CREATE TABLE "value_chain" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"head_revision_id" text,
	"deleted_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "value_chain_project_key_unique" UNIQUE("project_id","key"),
	CONSTRAINT "value_chain_project_id_unique" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "value_chain_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"value_chain_id" text NOT NULL,
	"rev" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"content_hash" text NOT NULL,
	"structure_hash" text NOT NULL,
	"schema_version" integer NOT NULL,
	"base_revision_id" text,
	"principal_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "value_chain_revision_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "value_chain_revision_chain_id_unique" UNIQUE("project_id","value_chain_id","id"),
	CONSTRAINT "value_chain_revision_chain_rev_unique" UNIQUE("value_chain_id","rev"),
	CONSTRAINT "value_chain_revision_humans_only" CHECK ("value_chain_revision"."source_kind" = 'human'),
	CONSTRAINT "value_chain_revision_rev_check" CHECK ("value_chain_revision"."rev" >= 1),
	CONSTRAINT "value_chain_revision_schema_version_check" CHECK ("value_chain_revision"."schema_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "value_chain_step" (
	"project_id" text NOT NULL,
	"value_chain_id" text NOT NULL,
	"element_id" text NOT NULL,
	"generation" integer NOT NULL,
	"created_rev" integer NOT NULL,
	"deleted_rev" integer,
	"deleted_seq" bigint,
	CONSTRAINT "value_chain_step_value_chain_id_element_id_generation_pk" PRIMARY KEY("value_chain_id","element_id","generation"),
	CONSTRAINT "value_chain_step_project_key_unique" UNIQUE("project_id","value_chain_id","element_id","generation"),
	CONSTRAINT "value_chain_step_generation_check" CHECK ("value_chain_step"."generation" >= 1),
	CONSTRAINT "value_chain_step_tombstone_check" CHECK (("value_chain_step"."deleted_rev" is null or "value_chain_step"."deleted_seq" is not null) and ("value_chain_step"."deleted_rev" is null or "value_chain_step"."deleted_rev" > "value_chain_step"."created_rev"))
);
--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement" ADD CONSTRAINT "placement_step_fk" FOREIGN KEY ("project_id","value_chain_id","element_id","generation") REFERENCES "public"."value_chain_step"("project_id","value_chain_id","element_id","generation") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_assertion" ADD CONSTRAINT "placement_assertion_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_assertion" ADD CONSTRAINT "placement_assertion_placement_fk" FOREIGN KEY ("project_id","placement_id") REFERENCES "public"."placement"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_assertion" ADD CONSTRAINT "placement_assertion_linked_fk" FOREIGN KEY ("project_id","linked_placement_id") REFERENCES "public"."placement"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_assertion" ADD CONSTRAINT "placement_assertion_submission_fk" FOREIGN KEY ("project_id","submission_id") REFERENCES "public"."analysis_submission"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_chain" ADD CONSTRAINT "value_chain_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_chain" ADD CONSTRAINT "value_chain_head_revision_fk" FOREIGN KEY ("project_id","id","head_revision_id") REFERENCES "public"."value_chain_revision"("project_id","value_chain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_chain_revision" ADD CONSTRAINT "value_chain_revision_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_chain_revision" ADD CONSTRAINT "value_chain_revision_chain_fk" FOREIGN KEY ("project_id","value_chain_id") REFERENCES "public"."value_chain"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_chain_revision" ADD CONSTRAINT "value_chain_revision_base_fk" FOREIGN KEY ("project_id","value_chain_id","base_revision_id") REFERENCES "public"."value_chain_revision"("project_id","value_chain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_chain_step" ADD CONSTRAINT "value_chain_step_chain_fk" FOREIGN KEY ("project_id","value_chain_id") REFERENCES "public"."value_chain"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_chain_step" ADD CONSTRAINT "value_chain_step_created_rev_fk" FOREIGN KEY ("value_chain_id","created_rev") REFERENCES "public"."value_chain_revision"("value_chain_id","rev") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "value_chain_step" ADD CONSTRAINT "value_chain_step_deleted_rev_fk" FOREIGN KEY ("value_chain_id","deleted_rev") REFERENCES "public"."value_chain_revision"("value_chain_id","rev") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "placement_process_model_idx" ON "placement" USING btree ("project_id","process_model");--> statement-breakpoint
CREATE INDEX "placement_process_idx" ON "placement" USING btree ("project_id","value_chain_id","process_ref");--> statement-breakpoint
CREATE INDEX "placement_assertion_placement_idx" ON "placement_assertion" USING btree ("project_id","placement_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "value_chain_step_live_unique" ON "value_chain_step" USING btree ("value_chain_id","element_id") WHERE "value_chain_step"."deleted_seq" is null;