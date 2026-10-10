-- Pipeline wake-ups, the model engine of older revisions, and a deferred
-- submission reference (M2).
-- Hand-written (drizzle-kit generate --custom); drizzle-kit does not model triggers.
--
-- 1. `GET /analyses/pending?wait=` long-polls on LISTEN "proa_analysis": every
--    task that becomes `queued` (new revision, requeue, release) notifies its
--    project id when the writing transaction commits.
CREATE FUNCTION "proa_notify_analysis"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('proa_analysis', NEW.project_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "analysis_task_notify" AFTER INSERT OR UPDATE OF "state" ON "analysis_task"
  FOR EACH ROW WHEN (NEW.state = 'queued') EXECUTE FUNCTION "proa_notify_analysis"();
--> statement-breakpoint
-- 2. Revisions stored before the engine column: the rule of @proa/bpmn-facts
--    (`modeler:executionPlatform` "Camunda Cloud" → c8, "Camunda Platform" →
--    c7, else exactly one of the zeebe/camunda namespaces), applied to the
--    start tag of <definitions>. Ingest only stores UTF-8.
UPDATE "model_revision" AS r SET "engine" = x.engine
FROM (
  SELECT h.id, CASE
    WHEN h.root ~ 'executionPlatform\s*=\s*"Camunda Cloud"' THEN 'c8'
    WHEN h.root ~ 'executionPlatform\s*=\s*"Camunda Platform"' THEN 'c7'
    WHEN h.root ~ 'http://camunda\.org/schema/zeebe/1\.0' AND h.root !~ 'http://camunda\.org/schema/1\.0/bpmn' THEN 'c8'
    WHEN h.root ~ 'http://camunda\.org/schema/1\.0/bpmn' AND h.root !~ 'http://camunda\.org/schema/zeebe/1\.0' THEN 'c7'
  END AS engine
  FROM (
    SELECT id, substring(convert_from(xml, 'UTF8') from '<(?:[A-Za-z_][-A-Za-z0-9_.]*:)?definitions[^>]*>') AS root
    FROM "model_revision" WHERE "engine" IS NULL
  ) AS h
) AS x
WHERE r.id = x.id AND x.engine IS NOT NULL;
--> statement-breakpoint
-- 3. A submission's assertions are written before the submission row, which
--    stores their final per-item result (both append-only, one transaction):
--    check the reference at commit.
ALTER TABLE "relation_assertion" DROP CONSTRAINT "relation_assertion_submission_fk";
--> statement-breakpoint
ALTER TABLE "relation_assertion" ADD CONSTRAINT "relation_assertion_submission_fk"
  FOREIGN KEY ("project_id","submission_id") REFERENCES "public"."analysis_submission"("project_id","id")
  DEFERRABLE INITIALLY DEFERRED;
