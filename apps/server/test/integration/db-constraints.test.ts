/**
 * Database-level guarantees that back the domain (CONCEPT §1, §2): append-only
 * history, "agents never decide", one open analysis task per model, and
 * composite foreign keys that keep rows inside their project.
 */
import { readFile } from 'node:fs/promises';

import { newId, type PrincipalId, type ProjectId, type RelationId } from '@proa/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStore } from '../../src/db/store.ts';

import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn } from '../support/fake-analysis.ts';

let database: TestDatabase;
let t: TestApp;
let projectId: string;
let otherProjectId: string;

/** The Postgres error message of a failed statement (Drizzle wraps it in `cause`). */
async function failure(statement: ReturnType<typeof sql.raw>): Promise<string> {
  try {
    await database.db.execute(statement);
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause;
    return cause?.message ?? String(err);
  }
  throw new Error('statement succeeded');
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
  projectId = (await t.createProject('db')).id;
  otherProjectId = (await t.createProject('db-other')).id;
  await t.putModel(
    'db',
    'a/caller',
    fakeBpmn({
      processes: [{ id: 'P_A', elements: [{ kind: 'call', id: 'Call_B', name: 'B', ref: 'P_B' }] }],
    }),
  );
  await t.putModel('db', 'b/callee', fakeBpmn({ processes: [{ id: 'P_B', name: 'B' }] }));
});

afterAll(async () => {
  await database.drop();
});

describe('append-only tables (trigger)', () => {
  it.each(['UPDATE event SET type = type', 'DELETE FROM event', 'TRUNCATE event CASCADE'])(
    'event: %s fails',
    async (statement) => {
      expect(await failure(sql.raw(statement))).toMatch(/event is append-only/);
    },
  );

  it('relation_assertion: UPDATE and DELETE fail', async () => {
    expect(await failure(sql.raw('UPDATE relation_assertion SET rationale = 1::text'))).toMatch(
      /relation_assertion is append-only: UPDATE/,
    );
    expect(await failure(sql.raw('DELETE FROM relation_assertion'))).toMatch(/append-only: DELETE/);
  });

  it('keeps the event history dense: seq 1..last_seq without gaps', async () => {
    const r = await database.db.execute<{ n: string; max: string; last: string }>(
      sql.raw(
        `SELECT count(*) AS n, max(e.seq) AS max, (SELECT last_seq FROM project WHERE id = '${projectId}') AS last
         FROM event e WHERE e.project_id = '${projectId}'`,
      ),
    );
    const row = r.rows[0];
    expect(Number(row?.n)).toBeGreaterThan(3);
    expect(Number(row?.n)).toBe(Number(row?.max));
    expect(Number(row?.max)).toBe(Number(row?.last));
  });
});

describe('agents never decide (check constraint)', () => {
  it('rejects a decision with source_kind agent', async () => {
    const message = await failure(
      sql.raw(
        `INSERT INTO relation_assertion (id, project_id, relation_id, seq, kind, verdict, source_kind, principal_id)
         SELECT 'asr_x', r.project_id, r.id, 999, 'decision', 'accept', 'agent', a.principal_id
         FROM relation r JOIN relation_assertion a ON a.relation_id = r.id
         WHERE r.project_id = '${projectId}' LIMIT 1`,
      ),
    );
    expect(message).toMatch(/relation_assertion_agents_never_decide/);
  });

  it('rejects a decision without verdict and a proposal with one', async () => {
    const insert = (kind: string, verdict: string) =>
      sql.raw(
        `INSERT INTO relation_assertion (id, project_id, relation_id, seq, kind, verdict, source_kind, principal_id)
         SELECT 'asr_y', r.project_id, r.id, 999, '${kind}', ${verdict}, 'human', a.principal_id
         FROM relation r JOIN relation_assertion a ON a.relation_id = r.id
         WHERE r.project_id = '${projectId}' LIMIT 1`,
      );
    expect(await failure(insert('decision', 'NULL'))).toMatch(/relation_assertion_verdict_check/);
    expect(await failure(insert('proposal', "'accept'"))).toMatch(
      /relation_assertion_verdict_check/,
    );
  });
});

describe('analysis_task', () => {
  it('allows one open task per model and kind (partial unique index)', async () => {
    const message = await failure(
      sql.raw(
        `INSERT INTO analysis_task (id, project_id, model_id, revision_id, kind, facts_hash, state, seq)
         SELECT 'ana_dup', project_id, model_id, revision_id, kind, facts_hash, 'claimed', seq
         FROM analysis_task WHERE project_id = '${projectId}' AND state = 'queued' LIMIT 1`,
      ),
    );
    expect(message).toMatch(/analysis_task_open_unique/);
  });

  it('allows any number of finished tasks', async () => {
    await database.db.execute(
      sql.raw(
        `INSERT INTO analysis_task (id, project_id, model_id, revision_id, kind, facts_hash, state, seq)
         SELECT 'ana_done' || n, project_id, model_id, revision_id, kind, facts_hash, 'done', seq
         FROM analysis_task, generate_series(1, 2) n WHERE project_id = '${projectId}' AND state = 'queued' LIMIT 2`,
      ),
    );
  });
});

describe('composite foreign keys keep rows in their project', () => {
  it('rejects a revision pointing to a model of another project', async () => {
    const message = await failure(
      sql.raw(
        `INSERT INTO model_revision (id, project_id, model_id, rev, xml, content_hash, facts_hash, facts_version,
                                     processes, message_flows, source, principal_id, seq)
         SELECT 'rev_x', '${otherProjectId}', m.id, 99, '\\x00', 'h', 'h', '1', '[]', '[]', '{}', r.principal_id, 1
         FROM model m JOIN model_revision r ON r.id = m.head_revision_id WHERE m.project_id = '${projectId}' LIMIT 1`,
      ),
    );
    expect(message).toMatch(/model_revision_model_fk/);
  });

  it('rejects an assertion pointing to a relation of another project', async () => {
    const message = await failure(
      sql.raw(
        `INSERT INTO relation_assertion (id, project_id, relation_id, seq, kind, source_kind, principal_id)
         SELECT 'asr_z', '${otherProjectId}', r.id, 999, 'proposal', 'human', a.principal_id
         FROM relation r JOIN relation_assertion a ON a.relation_id = r.id
         WHERE r.project_id = '${projectId}' LIMIT 1`,
      ),
    );
    expect(message).toMatch(/relation_assertion_relation_fk/);
  });

  it('rejects agent tokens with proa:review', async () => {
    await t.createToken('db', ['proa:read']);
    const message = await failure(
      sql.raw(
        `UPDATE agent_token SET scopes = array['proa:review'] WHERE project_id = '${projectId}'`,
      ),
    );
    expect(message).toMatch(/agent_token_scopes_check/);
  });
});

describe('M2: notes, submissions, engine', () => {
  it('rejects a note that is not from a human', async () => {
    const message = await failure(
      sql.raw(
        `INSERT INTO relation_assertion (id, project_id, relation_id, seq, kind, source_kind, principal_id, rationale)
         SELECT 'asr_note', r.project_id, r.id, 999, 'note', 'agent', a.principal_id, 'agent note'
         FROM relation r JOIN relation_assertion a ON a.relation_id = r.id
         WHERE r.project_id = '${projectId}' LIMIT 1`,
      ),
    );
    expect(message).toMatch(/relation_assertion_notes_by_humans/);
  });

  it('refuses an agent decision even through the store, bypassing the policy', async () => {
    const store = createStore(database.db);
    const [row] = (
      await database.db.execute<{ relation_id: string; principal_id: string }>(
        sql.raw(
          `SELECT relation_id, principal_id FROM relation_assertion WHERE project_id = '${projectId}' LIMIT 1`,
        ),
      )
    ).rows;
    await expect(
      store.write((tx) =>
        tx.assertions.insert({
          id: newId('assertion'),
          projectId: projectId as ProjectId,
          relationId: row?.relation_id as RelationId,
          seq: 1000,
          kind: 'decision',
          verdict: 'accept',
          sourceKind: 'agent',
          principalId: row?.principal_id as PrincipalId,
          clientId: 'agt_x',
          declared: null,
          submissionId: null,
          tier: null,
          confidence: null,
          rationale: null,
          evidence: null,
          question: null,
          label: null,
          linkedRelationId: null,
          fromFp: null,
          toFp: null,
        }),
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'relation_assertion_agents_never_decide' } });
  });

  it('checks the submission reference of an assertion at commit (deferred)', async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query('BEGIN');
      // Accepted inside the transaction (the submission row would follow) …
      await client.query(
        `INSERT INTO relation_assertion (id, project_id, relation_id, seq, kind, source_kind, principal_id, submission_id)
         SELECT 'asr_deferred', r.project_id, r.id, 998, 'proposal', 'agent', a.principal_id, 'sbm_missing'
         FROM relation r JOIN relation_assertion a ON a.relation_id = r.id
         WHERE r.project_id = '${projectId}' LIMIT 1`,
      );
      // … but refused at commit without it.
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        constraint: 'relation_assertion_submission_fk',
      });
    } finally {
      await client.end();
    }
  });

  it('backfills the engine of older revisions like @proa/bpmn-facts (migration 0003)', async () => {
    const statements = (
      await readFile(new URL('../../drizzle/0003_pipeline_notify.sql', import.meta.url), 'utf8')
    )
      .split('--> statement-breakpoint')
      .map((s) => s.trim());
    const backfill = statements.find((s) => s.includes('UPDATE "model_revision"'));
    expect(backfill).toBeDefined();
    const head = (attrs: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>\n<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ${attrs} id="D">\n<bpmn:process id="P" xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"/>\n</bpmn:definitions>`;
    const MODELER = 'xmlns:modeler="http://camunda.org/schema/modeler/1.0"';
    const C7 = 'xmlns:camunda="http://camunda.org/schema/1.0/bpmn"';
    const C8 = 'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0"';
    const cases: [string, string | null][] = [
      [`${MODELER} modeler:executionPlatform="Camunda Cloud"`, 'c8'],
      [`${MODELER} modeler:executionPlatform="Camunda Platform" ${C8}`, 'c7'],
      [C8, 'c8'],
      [C7, 'c7'],
      [`${C7} ${C8}`, null],
      ['', null],
    ];
    const [rev] = (
      await database.db.execute<{ id: string }>(
        sql.raw(`SELECT id FROM model_revision WHERE project_id = '${projectId}' LIMIT 1`),
      )
    ).rows;
    for (const [attrs, engine] of cases) {
      await database.db.execute(
        sql`UPDATE model_revision SET engine = NULL, xml = convert_to(${head(attrs)}, 'UTF8') WHERE id = ${rev?.id}`,
      );
      await database.db.execute(sql.raw(backfill ?? ''));
      const [after] = (
        await database.db.execute<{ engine: string | null }>(
          sql`SELECT engine FROM model_revision WHERE id = ${rev?.id}`,
        )
      ).rows;
      // The zeebe namespace on an inner element does not count: only the <definitions> tag.
      expect(after?.engine ?? null, attrs).toBe(engine);
    }
  });
});
