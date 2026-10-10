CREATE TABLE "placement_input" (
	"project_id" text NOT NULL,
	"value_chain_id" text NOT NULL,
	"process_ref" text NOT NULL,
	"input_hash" text NOT NULL,
	"task_id" text,
	"principal_id" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "placement_input_value_chain_id_process_ref_pk" PRIMARY KEY("value_chain_id","process_ref"),
	CONSTRAINT "placement_input_outcome_check" CHECK ("placement_input"."outcome" in ('proposed', 'unsure', 'skipped')),
	CONSTRAINT "placement_input_reason_check" CHECK (("placement_input"."outcome" = 'unsure') = ("placement_input"."reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "analysis_task" DROP CONSTRAINT "analysis_task_kind_check";--> statement-breakpoint
DROP INDEX "analysis_task_open_unique";--> statement-breakpoint
ALTER TABLE "analysis_task" ALTER COLUMN "model_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_task" ALTER COLUMN "revision_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_task" ALTER COLUMN "facts_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD COLUMN "subject_kind" text DEFAULT 'model' NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD COLUMN "value_chain_id" text;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD COLUMN "value_chain_revision_id" text;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD COLUMN "placement_claim" jsonb;--> statement-breakpoint
ALTER TABLE "placement_input" ADD CONSTRAINT "placement_input_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_input" ADD CONSTRAINT "placement_input_chain_fk" FOREIGN KEY ("project_id","value_chain_id") REFERENCES "public"."value_chain"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_input" ADD CONSTRAINT "placement_input_task_fk" FOREIGN KEY ("project_id","task_id") REFERENCES "public"."analysis_task"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_value_chain_fk" FOREIGN KEY ("project_id","value_chain_id") REFERENCES "public"."value_chain"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_value_chain_revision_fk" FOREIGN KEY ("project_id","value_chain_id","value_chain_revision_id") REFERENCES "public"."value_chain_revision"("project_id","value_chain_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_task_open_chain_unique" ON "analysis_task" USING btree ("value_chain_id","kind") WHERE "analysis_task"."state" in ('queued', 'claimed') and "analysis_task"."subject_kind" = 'value_chain';--> statement-breakpoint
CREATE INDEX "analysis_task_chain_idx" ON "analysis_task" USING btree ("project_id","value_chain_id","kind","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_task_open_unique" ON "analysis_task" USING btree ("model_id","kind") WHERE "analysis_task"."state" in ('queued', 'claimed') and "analysis_task"."subject_kind" = 'model';--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_subject_kind_check" CHECK ("analysis_task"."subject_kind" in ('model', 'value_chain'));--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_subject_check" CHECK (("analysis_task"."subject_kind" = 'model' and "analysis_task"."model_id" is not null and "analysis_task"."revision_id" is not null and "analysis_task"."facts_hash" is not null and "analysis_task"."value_chain_id" is null and "analysis_task"."value_chain_revision_id" is null and "analysis_task"."input_hash" is null and "analysis_task"."placement_claim" is null) or ("analysis_task"."subject_kind" = 'value_chain' and "analysis_task"."value_chain_id" is not null and "analysis_task"."value_chain_revision_id" is not null and "analysis_task"."input_hash" is not null and "analysis_task"."model_id" is null and "analysis_task"."revision_id" is null and "analysis_task"."facts_hash" is null and "analysis_task"."assignment" is null));--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_kind_subject_check" CHECK (("analysis_task"."kind" = 'relations') = ("analysis_task"."subject_kind" = 'model'));--> statement-breakpoint
ALTER TABLE "analysis_task" ADD CONSTRAINT "analysis_task_kind_check" CHECK ("analysis_task"."kind" in ('relations', 'placement'));--> statement-breakpoint
CREATE VIEW "public"."value_chain_pipeline" AS (
  select c.project_id, c.id as value_chain_id, t.id as task_id, t.state as task_state,
         i.review_items, i.held_items,
         case
           when t.state = 'claimed' then 'agent_working'
           when t.state = 'failed' then 'agent_failed'
           when t.state = 'queued' then 'waiting_for_agent'
           when i.review_items > 0 then 'waiting_for_review'
           when i.held_items > 0 then 'waiting_for_clarification'
           else 'incorporated'
         end as stage
  from value_chain c
  left join lateral (
    select a.id, a.state from analysis_task a
    where a.project_id = c.project_id and a.value_chain_id = c.id
      and a.kind = 'placement' and a.state <> 'cancelled'
    order by a.seq desc
    limit 1
  ) t on true
  cross join lateral (
    select
      (count(*) filter (where (x.status = 'proposed' and s.deleted_seq is null)
        or (x.status = 'accepted' and x.endpoint_state <> 'ok')))::int as review_items,
      (count(*) filter (where x.status = 'held'))::int as held_items
    from placement x
    join value_chain_step s on s.value_chain_id = x.value_chain_id
      and s.element_id = x.element_id and s.generation = x.generation
    where x.project_id = c.project_id and x.value_chain_id = c.id
  ) i
  where c.deleted_seq is null
);