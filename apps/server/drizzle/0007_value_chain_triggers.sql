-- Value chain (M4 S1): history guarantees and a deferred submission reference.
-- Hand-written (drizzle-kit generate --custom); drizzle-kit does not model triggers.
--
-- 1. Value chain revisions and placement assertions are append-only like the
--    other history tables (0001, 0005).
CREATE TRIGGER "value_chain_revision_append_only" BEFORE UPDATE OR DELETE ON "value_chain_revision"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "value_chain_revision_no_truncate" BEFORE TRUNCATE ON "value_chain_revision"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "placement_assertion_append_only" BEFORE UPDATE OR DELETE ON "placement_assertion"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "placement_assertion_no_truncate" BEFORE TRUNCATE ON "placement_assertion"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
-- 2. A step generation only ever takes its tombstone: one UPDATE that sets
--    `deleted_seq` (and `deleted_rev`, if a revision removed it) on a live row
--    and changes nothing else. A tombstone is final (a reappearing id is a new
--    generation), and rows are never deleted.
CREATE FUNCTION "proa_value_chain_step_tombstone_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.deleted_seq IS NULL AND NEW.deleted_seq IS NOT NULL
     AND OLD.deleted_rev IS NULL
     AND NEW.project_id = OLD.project_id
     AND NEW.value_chain_id = OLD.value_chain_id
     AND NEW.element_id = OLD.element_id
     AND NEW.generation = OLD.generation
     AND NEW.created_rev = OLD.created_rev THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'value_chain_step only takes a tombstone: % is not allowed', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "value_chain_step_tombstone_only" BEFORE UPDATE OR DELETE ON "value_chain_step"
  FOR EACH ROW EXECUTE FUNCTION "proa_value_chain_step_tombstone_only"();
--> statement-breakpoint
CREATE TRIGGER "value_chain_step_no_truncate" BEFORE TRUNCATE ON "value_chain_step"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
-- 3. A submission's placement assertions will be written before the
--    submission row (M4b, as for relation assertions in 0003): check the
--    reference at commit.
ALTER TABLE "placement_assertion" DROP CONSTRAINT "placement_assertion_submission_fk";
--> statement-breakpoint
ALTER TABLE "placement_assertion" ADD CONSTRAINT "placement_assertion_submission_fk"
  FOREIGN KEY ("project_id","submission_id") REFERENCES "public"."analysis_submission"("project_id","id")
  DEFERRABLE INITIALLY DEFERRED;
