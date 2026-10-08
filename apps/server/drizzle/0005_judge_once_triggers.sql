-- Judge each pair once (procedure proa-relations@0.2.0).
-- Hand-written (drizzle-kit generate --custom); drizzle-kit does not model triggers.
--
-- 1. No-links and their withdrawals are append-only like the other history
--    tables (0001): a no-link is live while it has no withdrawal row.
CREATE TRIGGER "no_link_append_only" BEFORE UPDATE OR DELETE ON "no_link"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "no_link_no_truncate" BEFORE TRUNCATE ON "no_link"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "no_link_withdrawal_append_only" BEFORE UPDATE OR DELETE ON "no_link_withdrawal"
  FOR EACH ROW EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
CREATE TRIGGER "no_link_withdrawal_no_truncate" BEFORE TRUNCATE ON "no_link_withdrawal"
  FOR EACH STATEMENT EXECUTE FUNCTION "proa_forbid_change"();
--> statement-breakpoint
-- 2. Tasks claimed before this migration: the seq of their latest
--    `analysis.claimed` event, so a late submission resolves the partner
--    models as its claim saw them.
UPDATE "analysis_task" AS t SET "claimed_seq" = c.seq
FROM (
  SELECT e.project_id, e.payload->>'taskId' AS task_id, max(e.seq) AS seq
  FROM "event" AS e
  WHERE e.type = 'analysis.claimed'
  GROUP BY e.project_id, e.payload->>'taskId'
) AS c
WHERE t.project_id = c.project_id AND t.id = c.task_id;
