-- Auto-accept rules (owner decision 19): history guarantees.
-- Hand-written (drizzle-kit generate --custom); drizzle-kit does not model triggers.
--
-- A rule's head row and its revisions are append-only like the other history
-- tables (0001, 0005, 0007): an edit, an enable and a disable each add a
-- revision, and a rule is disabled, never deleted, so every decision that
-- names a rule revision keeps resolving it.
CREATE TRIGGER "auto_accept_rule_append_only" BEFORE UPDATE OR DELETE ON "auto_accept_rule"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "auto_accept_rule_no_truncate" BEFORE TRUNCATE ON "auto_accept_rule"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "auto_accept_rule_revision_append_only" BEFORE UPDATE OR DELETE ON "auto_accept_rule_revision"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "auto_accept_rule_revision_no_truncate" BEFORE TRUNCATE ON "auto_accept_rule_revision"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
