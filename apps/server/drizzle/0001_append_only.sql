-- Append-only history (CONCEPT §1 principle 5, §2): events, relation
-- assertions and analysis submissions are never updated or deleted.
-- Hand-written (drizzle-kit generate --custom); drizzle-kit does not model triggers.
CREATE FUNCTION "proa_forbid_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "event_append_only" BEFORE UPDATE OR DELETE ON "event"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "event_no_truncate" BEFORE TRUNCATE ON "event"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "relation_assertion_append_only" BEFORE UPDATE OR DELETE ON "relation_assertion"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "relation_assertion_no_truncate" BEFORE TRUNCATE ON "relation_assertion"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "analysis_submission_append_only" BEFORE UPDATE OR DELETE ON "analysis_submission"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "analysis_submission_no_truncate" BEFORE TRUNCATE ON "analysis_submission"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
