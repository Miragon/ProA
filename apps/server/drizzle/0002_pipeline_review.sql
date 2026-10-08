ALTER TABLE "relation_assertion" DROP CONSTRAINT "relation_assertion_kind_check";--> statement-breakpoint
ALTER TABLE "analysis_submission" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "model_revision" ADD COLUMN "engine" text;--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD COLUMN "linked_relation_id" text;--> statement-breakpoint
ALTER TABLE "model_revision" ADD CONSTRAINT "model_revision_engine_check" CHECK ("model_revision"."engine" is null or "model_revision"."engine" in ('c7', 'c8'));--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD CONSTRAINT "relation_assertion_notes_by_humans" CHECK ("relation_assertion"."kind" <> 'note' or "relation_assertion"."source_kind" = 'human');--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD CONSTRAINT "relation_assertion_kind_check" CHECK ("relation_assertion"."kind" in ('proposal', 'withdrawal', 'decision', 'note'));