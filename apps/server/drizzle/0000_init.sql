CREATE TABLE "agent_token" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_token_principal_unique" UNIQUE("principal_id"),
	CONSTRAINT "agent_token_secret_hash_unique" UNIQUE("secret_hash"),
	CONSTRAINT "agent_token_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "agent_token_scopes_check" CHECK (cardinality("agent_token"."scopes") > 0 and "agent_token"."scopes" <@ array['proa:read', 'proa:propose', 'proa:write']::text[])
);
--> statement-breakpoint
CREATE TABLE "analysis_submission" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"client_submission_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"declared" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_submission_task_unique" UNIQUE("task_id"),
	CONSTRAINT "analysis_submission_project_id_unique" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "analysis_task" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"model_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"kind" text NOT NULL,
	"facts_hash" text NOT NULL,
	"state" text NOT NULL,
	"lease_token_hash" text,
	"claimed_by" text,
	"lease_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_task_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "analysis_task_kind_check" CHECK ("analysis_task"."kind" in ('relations')),
	CONSTRAINT "analysis_task_state_check" CHECK ("analysis_task"."state" in ('queued', 'claimed', 'done', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "event" (
	"project_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"principal_id" text NOT NULL,
	"client_id" text,
	"subject_ref" text,
	"payload" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_project_id_seq_pk" PRIMARY KEY("project_id","seq")
);
--> statement-breakpoint
CREATE TABLE "fact" (
	"revision_id" text NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"element_id" text NOT NULL,
	"process_id" text,
	"scope" text NOT NULL,
	"event_def" text,
	"label" text NOT NULL,
	"key_raw" text NOT NULL,
	"key_norm" text NOT NULL,
	"fingerprint" text NOT NULL,
	"attrs" jsonb NOT NULL,
	CONSTRAINT "fact_revision_id_kind_element_id_pk" PRIMARY KEY("revision_id","kind","element_id"),
	CONSTRAINT "fact_kind_check" CHECK ("fact"."kind" in ('process', 'call', 'msg_throw', 'msg_catch', 'sig_throw', 'sig_catch', 'evt_start', 'evt_end', 'data_store', 'message_flow', 'lane', 'task')),
	CONSTRAINT "fact_scope_check" CHECK ("fact"."scope" in ('process', 'subprocess', 'event_subprocess')),
	CONSTRAINT "fact_event_def_check" CHECK ("fact"."event_def" is null or "fact"."event_def" in ('none', 'message', 'signal', 'timer', 'conditional', 'error', 'escalation', 'terminate', 'link', 'compensate', 'multiple'))
);
--> statement-breakpoint
CREATE TABLE "finding" (
	"project_id" text NOT NULL,
	"ord" integer NOT NULL,
	"kind" text NOT NULL,
	"refs" text[] NOT NULL,
	"detail" text NOT NULL,
	CONSTRAINT "finding_project_id_ord_pk" PRIMARY KEY("project_id","ord"),
	CONSTRAINT "finding_kind_check" CHECK ("finding"."kind" in ('unresolved-call', 'dynamic-call', 'duplicate-process-id', 'dangling-throw', 'unmatched-catch'))
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"email_norm" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "invitation_role_check" CHECK ("invitation"."role" in ('viewer', 'editor', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"project_id" text NOT NULL,
	"principal_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_project_id_principal_id_pk" PRIMARY KEY("project_id","principal_id"),
	CONSTRAINT "membership_role_check" CHECK ("membership"."role" in ('viewer', 'editor', 'owner'))
);
--> statement-breakpoint
CREATE TABLE "model" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text,
	"head_revision_id" text,
	"deleted_seq" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_project_key_unique" UNIQUE("project_id","key"),
	CONSTRAINT "model_project_id_unique" UNIQUE("project_id","id")
);
--> statement-breakpoint
CREATE TABLE "model_revision" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"model_id" text NOT NULL,
	"rev" integer NOT NULL,
	"xml" "bytea" NOT NULL,
	"content_hash" text NOT NULL,
	"facts_hash" text NOT NULL,
	"facts_version" text NOT NULL,
	"processes" jsonb NOT NULL,
	"message_flows" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"principal_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_revision_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "model_revision_model_rev_unique" UNIQUE("model_id","rev")
);
--> statement-breakpoint
CREATE TABLE "principal" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"iss" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"handle" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_identity_unique" UNIQUE("iss","kind","subject"),
	CONSTRAINT "principal_kind_check" CHECK ("principal"."kind" in ('user', 'service', 'system'))
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "relation" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" text NOT NULL,
	"from_ref" text NOT NULL,
	"to_ref" text NOT NULL,
	"from_model" text GENERATED ALWAYS AS (split_part(from_ref, '#', 1)) STORED NOT NULL,
	"to_model" text GENERATED ALWAYS AS (split_part(to_ref, '#', 1)) STORED NOT NULL,
	"status" text NOT NULL,
	"endpoint_state" text NOT NULL,
	"tier" text NOT NULL,
	"confidence" double precision,
	"version" integer DEFAULT 1 NOT NULL,
	"attrs" jsonb NOT NULL,
	"from_fp" text,
	"to_fp" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_natural_key_unique" UNIQUE("project_id","type","from_ref","to_ref"),
	CONSTRAINT "relation_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "relation_type_check" CHECK ("relation"."type" in ('call', 'message', 'signal', 'trigger', 'manual')),
	CONSTRAINT "relation_status_check" CHECK ("relation"."status" in ('proposed', 'accepted', 'rejected', 'held', 'obsolete')),
	CONSTRAINT "relation_endpoint_state_check" CHECK ("relation"."endpoint_state" in ('ok', 'changed', 'missing')),
	CONSTRAINT "relation_tier_check" CHECK ("relation"."tier" in ('key', 'lexical', 'semantic', 'manual', 'rule')),
	CONSTRAINT "relation_confidence_check" CHECK ("relation"."confidence" is null or "relation"."confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "relation_assertion" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"relation_id" text NOT NULL,
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
	"from_fp" text,
	"to_fp" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_assertion_agents_never_decide" CHECK (not ("relation_assertion"."kind" = 'decision' and "relation_assertion"."source_kind" = 'agent')),
	CONSTRAINT "relation_assertion_verdict_check" CHECK (("relation_assertion"."kind" = 'decision') = ("relation_assertion"."verdict" is not null) and ("relation_assertion"."verdict" is null or "relation_assertion"."verdict" in ('accept', 'reject', 'hold'))),
	CONSTRAINT "relation_assertion_kind_check" CHECK ("relation_assertion"."kind" in ('proposal', 'withdrawal', 'decision')),
	CONSTRAINT "relation_assertion_source_kind_check" CHECK ("relation_assertion"."source_kind" in ('human', 'agent', 'rule')),
	CONSTRAINT "relation_assertion_tier_check" CHECK ("relation_assertion"."tier" is null or "relation_assertion"."tier" in ('key', 'lexical', 'semantic', 'manual', 'rule')),
	CONSTRAINT "relation_assertion_confidence_check" CHECK ("relation_assertion"."confidence" is null or "relation_assertion"."confidence" between 0 and 1)
);
--> statement-breakpoint
ALTER TABLE "agent_token" ADD CONSTRAINT "agent_token_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_token" ADD CONSTRAINT "agent_token_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_token" ADD CONSTRAINT "agent_token_created_by_principal_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_submission" ADD CONSTRAINT "analysis_submission_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_submission" ADD CONSTRAINT "analysis_submission_task_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."analysis_task"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_claimed_by_principal_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_model_fk" FOREIGN KEY ("project_id","model_id") REFERENCES "public"."model"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_revision_fk" FOREIGN KEY ("project_id","revision_id") REFERENCES "public"."model_revision"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event" ADD CONSTRAINT "event_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact" ADD CONSTRAINT "fact_revision_fk" FOREIGN KEY ("project_id","revision_id") REFERENCES "public"."model_revision"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding" ADD CONSTRAINT "finding_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_principal_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_accepted_by_principal_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model" ADD CONSTRAINT "model_head_revision_fk" FOREIGN KEY ("project_id","head_revision_id") REFERENCES "public"."model_revision"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_revision" ADD CONSTRAINT "model_revision_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_revision" ADD CONSTRAINT "model_revision_model_fk" FOREIGN KEY ("project_id","model_id") REFERENCES "public"."model"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation" ADD CONSTRAINT "relation_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD CONSTRAINT "relation_assertion_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD CONSTRAINT "relation_assertion_relation_fk" FOREIGN KEY ("project_id","relation_id") REFERENCES "public"."relation"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD CONSTRAINT "relation_assertion_submission_fk" FOREIGN KEY ("project_id","submission_id") REFERENCES "public"."analysis_submission"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_task_open_unique" ON "analysis_task" USING btree ("model_id","kind") WHERE "analysis_task"."state" in ('queued', 'claimed');--> statement-breakpoint
CREATE INDEX "analysis_task_model_idx" ON "analysis_task" USING btree ("project_id","model_id","kind","seq");--> statement-breakpoint
CREATE INDEX "analysis_task_state_idx" ON "analysis_task" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "fact_project_kind_key_idx" ON "fact" USING btree ("project_id","kind","key_norm");--> statement-breakpoint
CREATE INDEX "invitation_project_email_idx" ON "invitation" USING btree ("project_id","email_norm");--> statement-breakpoint
CREATE INDEX "relation_from_model_idx" ON "relation" USING btree ("project_id","from_model");--> statement-breakpoint
CREATE INDEX "relation_to_model_idx" ON "relation" USING btree ("project_id","to_model");--> statement-breakpoint
CREATE INDEX "relation_assertion_relation_idx" ON "relation_assertion" USING btree ("project_id","relation_id","seq");--> statement-breakpoint
CREATE VIEW "public"."model_pipeline" AS (
  select m.project_id, m.id as model_id, m.key as model_key, t.state as task_state,
         r.review_items, r.held_items, r.review_items + r.held_items as open_items,
         case
           when t.state = 'claimed' then 'agent_working'
           when t.state = 'failed' then 'agent_failed'
           when t.state = 'done' then case
             when r.review_items > 0 then 'waiting_for_review'
             when r.held_items > 0 then 'waiting_for_clarification'
             else 'incorporated' end
           else 'waiting_for_agent'
         end as stage
  from model m
  left join lateral (
    select a.state from analysis_task a
    where a.project_id = m.project_id and a.model_id = m.id
      and a.kind = 'relations' and a.state <> 'cancelled'
    order by a.seq desc
    limit 1
  ) t on true
  cross join lateral (
    select
      (count(*) filter (where x.status = 'proposed'
        or (x.status = 'accepted' and x.endpoint_state <> 'ok')))::int as review_items,
      (count(*) filter (where x.status = 'held'))::int as held_items
    from relation x
    where x.project_id = m.project_id and (x.from_model = m.key or x.to_model = m.key)
  ) r
  where m.deleted_seq is null
);