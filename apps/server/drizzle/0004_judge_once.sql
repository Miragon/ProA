CREATE TABLE "no_link" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" text NOT NULL,
	"from_ref" text NOT NULL,
	"to_ref" text NOT NULL,
	"from_model" text NOT NULL,
	"to_model" text NOT NULL,
	"from_hash" text NOT NULL,
	"to_hash" text NOT NULL,
	"reason" text NOT NULL,
	"source_kind" text NOT NULL,
	"principal_id" text NOT NULL,
	"client_id" text,
	"declared" jsonb NOT NULL,
	"submission_id" text NOT NULL,
	"model_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "no_link_project_id_unique" UNIQUE("project_id","id"),
	CONSTRAINT "no_link_submission_pair_unique" UNIQUE("submission_id","type","from_ref","to_ref"),
	CONSTRAINT "no_link_type_check" CHECK ("no_link"."type" in ('call', 'message', 'signal', 'trigger')),
	CONSTRAINT "no_link_source_kind_check" CHECK ("no_link"."source_kind" in ('agent', 'human'))
);
--> statement-breakpoint
CREATE TABLE "no_link_withdrawal" (
	"no_link_id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"principal_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_task" ADD COLUMN "claimed_seq" bigint;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD COLUMN "assignment" jsonb;--> statement-breakpoint
ALTER TABLE "analysis_task" ADD COLUMN "requeue_after" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD COLUMN "from_hash" text;--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD COLUMN "to_hash" text;--> statement-breakpoint
ALTER TABLE "no_link" ADD CONSTRAINT "no_link_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_link" ADD CONSTRAINT "no_link_submission_fk" FOREIGN KEY ("project_id","submission_id") REFERENCES "public"."analysis_submission"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_link" ADD CONSTRAINT "no_link_model_fk" FOREIGN KEY ("project_id","model_id") REFERENCES "public"."model"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_link_withdrawal" ADD CONSTRAINT "no_link_withdrawal_no_link_id_no_link_id_fk" FOREIGN KEY ("no_link_id") REFERENCES "public"."no_link"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_link_withdrawal" ADD CONSTRAINT "no_link_withdrawal_principal_id_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "no_link_withdrawal" ADD CONSTRAINT "no_link_withdrawal_project_fk" FOREIGN KEY ("project_id","no_link_id") REFERENCES "public"."no_link"("project_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "no_link_from_model_idx" ON "no_link" USING btree ("project_id","from_model");--> statement-breakpoint
CREATE INDEX "no_link_to_model_idx" ON "no_link" USING btree ("project_id","to_model");--> statement-breakpoint
CREATE INDEX "no_link_pair_idx" ON "no_link" USING btree ("project_id","from_ref","to_ref");--> statement-breakpoint
CREATE INDEX "no_link_principal_idx" ON "no_link" USING btree ("project_id","principal_id");