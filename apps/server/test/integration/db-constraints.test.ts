/**
 * Database-level guarantees that back the domain (CONCEPT §1, §2): append-only
 * history, "agents never decide", one open analysis task per model, and
 * composite foreign keys that keep rows inside their project.
 */
import { readFile } from 'node:fs/promises';

import {
  newId,
  type PlacementId,
  type PrincipalId,
  type ProjectId,
  type RelationId,
  type ValueChainId,
} from '@proa/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStore } from '../../src/db/store.ts';
import {
  placementEndpoints,
  processFingerprints,
} from '../../src/domain/value-chain/placement-state.ts';
import {
  applyPlacementProposal,
  recordPlacementDecision,
} from '../../src/domain/value-chain/placements.ts';
import {
  createValueChain,
  saveValueChainRevision,
} from '../../src/domain/value-chain/revisions.ts';
import { OUTSIDE, liveGenerations } from '../../src/domain/value-chain/steps.ts';

import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn } from '../support/fake-analysis.ts';
import { claim, submission, submit } from '../support/pipeline.ts';
import { chainDoc, prepare } from '../support/value-chain.ts';

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
          fromHash: null,
          toHash: null,
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

describe('judge each pair once: no-links (migrations 0004, 0005)', () => {
  let noLinkId: string;

  beforeAll(async () => {
    // The owner works the caller's task and judges the call pair unrelated.
    const owner = (path: string, init?: RequestInit) => t.asOwner(path, init);
    const [c] = await claim(owner, { projectId: 'db', modelKey: 'a/caller' });
    if (!c) throw new Error('no task for a/caller');
    const result = await submit(owner, c.taskId, {
      ...submission(c, []),
      noLinks: [{ type: 'call', from: 'a/caller#Call_B', to: 'b/callee#P_B', reason: 'x: y' }],
    });
    expect(result.noLinks?.counts.stored).toBe(1);
    const [row] = (
      await database.db.execute<{ id: string }>(
        sql.raw(`SELECT id FROM no_link WHERE project_id = '${projectId}'`),
      )
    ).rows;
    noLinkId = row?.id ?? '';
    expect(noLinkId).toMatch(/^nlk_/);
  });

  it.each([
    ['UPDATE no_link SET reason = reason', /no_link is append-only: UPDATE/],
    ['DELETE FROM no_link', /no_link is append-only: DELETE/],
    ['TRUNCATE no_link CASCADE', /is append-only: TRUNCATE/],
  ])('no_link: %s fails', async (statement, message) => {
    expect(await failure(sql.raw(statement))).toMatch(message);
  });

  it('ends a no-link with one withdrawal row, itself append-only', async () => {
    const withdraw = (project: string) =>
      sql.raw(
        `INSERT INTO no_link_withdrawal (no_link_id, project_id, seq, principal_id, reason)
         SELECT n.id, '${project}', n.seq, n.principal_id, 'test' FROM no_link n WHERE n.id = '${noLinkId}'`,
      );
    // Never into another project (composite foreign key).
    expect(await failure(withdraw(otherProjectId))).toMatch(/no_link_withdrawal_project_fk/);
    await database.db.execute(withdraw(projectId));
    expect(await failure(withdraw(projectId))).toMatch(/no_link_withdrawal_pkey/);
    expect(await failure(sql.raw('UPDATE no_link_withdrawal SET reason = reason'))).toMatch(
      /no_link_withdrawal is append-only: UPDATE/,
    );
    expect(await failure(sql.raw('DELETE FROM no_link_withdrawal'))).toMatch(
      /no_link_withdrawal is append-only: DELETE/,
    );
  });

  it('backfills claimed_seq from the latest analysis.claimed event (migration 0005)', async () => {
    const statements = (
      await readFile(new URL('../../drizzle/0005_judge_once_triggers.sql', import.meta.url), 'utf8')
    )
      .split('--> statement-breakpoint')
      .map((s) => s.trim());
    const backfill = statements.find((s) => s.includes('UPDATE "analysis_task"'));
    expect(backfill).toBeDefined();
    const claimedSeq = async () =>
      (
        await database.db.execute<{ claimed_seq: string | null; latest: string }>(
          sql.raw(
            `SELECT t.claimed_seq, (SELECT max(e.seq) FROM event e WHERE e.project_id = t.project_id
               AND e.type = 'analysis.claimed' AND e.payload->>'taskId' = t.id) AS latest
             FROM analysis_task t JOIN model m ON m.id = t.model_id
             WHERE t.project_id = '${projectId}' AND m.key = 'a/caller'`,
          ),
        )
      ).rows[0];
    const before = await claimedSeq();
    expect(before?.claimed_seq).toBe(before?.latest);
    await database.db.execute(
      sql.raw(`UPDATE analysis_task SET claimed_seq = NULL WHERE project_id = '${projectId}'`),
    );
    await database.db.execute(sql.raw(backfill ?? ''));
    expect((await claimedSeq())?.claimed_seq).toBe(before?.latest);
  });

  it('refuses a no-link without its submission or with another relation type', async () => {
    const insert = (type: string, submissionId: string) =>
      sql.raw(
        `INSERT INTO no_link (id, project_id, type, from_ref, to_ref, from_model, to_model, from_hash,
           to_hash, reason, source_kind, principal_id, declared, submission_id, model_id, seq)
         SELECT 'nlk_x', n.project_id, '${type}', n.from_ref, n.to_ref, n.from_model, n.to_model,
           n.from_hash, n.to_hash, n.reason, n.source_kind, n.principal_id, n.declared,
           ${submissionId}, n.model_id, n.seq
         FROM no_link n WHERE n.id = '${noLinkId}'`,
      );
    expect(await failure(insert('manual', 'n.submission_id'))).toMatch(/no_link_type_check/);
    expect(await failure(insert('call', "'sbm_missing'"))).toMatch(/no_link_submission_fk/);
  });
});

describe('value chain and placements (migrations 0006, 0007)', () => {
  let chainId: ValueChainId;
  let revisionId: string;
  let placementId: PlacementId;
  let ownerId: PrincipalId;

  beforeAll(async () => {
    const store = createStore(database.db);
    const owner = await t.useCases.localOwnerActor('proa-web');
    ownerId = owner.principalId;
    const token = await t.createToken('db', ['proa:read', 'proa:propose']);
    const agent = await t.useCases.authenticateAgentToken(token.secret);
    if (!agent) throw new Error('agent token not accepted');
    const P = projectId as ProjectId;
    const rev1 = prepare(
      chainDoc('Kette', [
        ['step-a', 'Auftrag'],
        ['step-b', 'Versand'],
      ]),
    );
    const rev2 = prepare(chainDoc('Kette', [['step-a', 'Auftrag']]));
    ({ chainId, placementId } = await store.write(async (tx) => {
      await tx.projects.lockForWrite(P);
      const created = await createValueChain(tx, owner, P, { key: 'main' }, rev1);
      // rev 2 tombstones step-b.
      await saveValueChainRevision(tx, owner, P, created.chain.id, rev2, { baseRevisionId: null });
      const endpoints = placementEndpoints(
        liveGenerations(await tx.valueChainSteps.list(P, created.chain.id)),
        rev2.stepFingerprints,
        processFingerprints(await tx.facts.head(P, { kinds: ['process'] })),
      );
      const { placement } = await applyPlacementProposal(
        {
          tx,
          projectId: P,
          actor: agent,
          valueChainId: created.chain.id,
          endpoints,
          placements: new Map(),
          histories: new Map(),
          declared: null,
          submissionId: null,
        },
        {
          elementId: 'step-a',
          generation: 1,
          processRef: 'a/caller#P_A',
          tier: 'semantic',
          confidence: 0.8,
          rationale: 'r',
          evidence: [],
          question: null,
        },
      );
      const history = await tx.placementAssertions.listForPlacements(P, [placement.id]);
      await recordPlacementDecision(tx, P, owner, placement, history, endpoints, {
        verdict: 'accept',
        rationale: null,
        question: null,
        label: null,
        linkedPlacementId: null,
        tier: null,
        confidence: null,
      });
      return { chainId: created.chain.id, placementId: placement.id };
    }));
    const [rev] = (
      await database.db.execute<{ id: string }>(
        sql.raw(
          `SELECT id FROM value_chain_revision WHERE value_chain_id = '${chainId}' AND rev = 1`,
        ),
      )
    ).rows;
    revisionId = rev?.id ?? '';
    // A second chain in the same project, which the schema allows (the domain allows only `main`).
    await database.db.execute(
      sql.raw(
        `INSERT INTO value_chain (id, project_id, key, name) VALUES ('vch_second', '${projectId}', 'second', 'Zweite');
         INSERT INTO value_chain_revision (id, project_id, value_chain_id, rev, content, content_hash,
           structure_hash, schema_version, principal_id, source_kind, seq)
         SELECT 'vcr_second', project_id, 'vch_second', 1, content, content_hash, structure_hash,
           schema_version, principal_id, source_kind, seq FROM value_chain_revision WHERE id = '${revisionId}';
         INSERT INTO value_chain_step (project_id, value_chain_id, element_id, generation, created_rev)
         VALUES ('${projectId}', 'vch_second', 'only-second', 1, 1);`,
      ),
    );
  });

  it.each([
    [
      'UPDATE value_chain_revision SET structure_hash = structure_hash',
      /value_chain_revision is append-only: UPDATE/,
    ],
    ['DELETE FROM value_chain_revision', /value_chain_revision is append-only: DELETE/],
    ['TRUNCATE value_chain_revision CASCADE', /is append-only: TRUNCATE/],
    [
      'UPDATE placement_assertion SET rationale = rationale',
      /placement_assertion is append-only: UPDATE/,
    ],
    ['DELETE FROM placement_assertion', /placement_assertion is append-only: DELETE/],
    ['TRUNCATE placement_assertion', /placement_assertion is append-only: TRUNCATE/],
  ])('%s fails', async (statement, message) => {
    expect(await failure(sql.raw(statement))).toMatch(message);
  });

  it('value_chain_step only takes a tombstone', async () => {
    const live = `value_chain_id = '${chainId}' AND element_id = 'step-a'`;
    const dead = `value_chain_id = '${chainId}' AND element_id = 'step-b'`;
    const refused = /value_chain_step only takes a tombstone: (UPDATE|DELETE)/;
    expect(await failure(sql.raw(`DELETE FROM value_chain_step WHERE ${live}`))).toMatch(refused);
    for (const change of [
      `element_id = 'step-x'`,
      `element_id = 'step-x', deleted_seq = 99`,
      `generation = 2, deleted_seq = 99`,
      `created_rev = 2, deleted_seq = 99`,
      `project_id = '${otherProjectId}', deleted_seq = 99`,
    ]) {
      expect(
        await failure(sql.raw(`UPDATE value_chain_step SET ${change} WHERE ${live}`)),
        change,
      ).toMatch(refused);
    }
    // A tombstone is final: neither changed nor cleared.
    expect(
      await failure(
        sql.raw(`UPDATE value_chain_step SET deleted_seq = deleted_seq + 1 WHERE ${dead}`),
      ),
    ).toMatch(refused);
    expect(
      await failure(
        sql.raw(`UPDATE value_chain_step SET deleted_seq = NULL, deleted_rev = NULL WHERE ${dead}`),
      ),
    ).toMatch(refused);
    expect(await failure(sql.raw('TRUNCATE value_chain_step CASCADE'))).toMatch(
      /is append-only: TRUNCATE/,
    );
    // Setting the tombstone on a live row works (rolled back here).
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `UPDATE value_chain_step SET deleted_seq = 99, deleted_rev = 2 WHERE ${live} AND deleted_seq IS NULL`,
      );
      expect(r.rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
    // The tombstone check: a deleted_rev needs a deleted_seq and follows created_rev.
    expect(
      await failure(
        sql.raw(`UPDATE value_chain_step SET deleted_seq = 99, deleted_rev = 1 WHERE ${live}`),
      ),
    ).toMatch(/value_chain_step_tombstone_check/);
  });

  it('allows one live generation per element id', async () => {
    expect(
      await failure(
        sql.raw(
          `INSERT INTO value_chain_step (project_id, value_chain_id, element_id, generation, created_rev)
           VALUES ('${projectId}', '${chainId}', 'step-a', 2, 2)`,
        ),
      ),
    ).toMatch(/value_chain_step_live_unique/);
    expect(
      await failure(
        sql.raw(
          `INSERT INTO value_chain_step (project_id, value_chain_id, element_id, generation, created_rev)
           VALUES ('${projectId}', '${chainId}', 'step-z', 1, 99)`,
        ),
      ),
    ).toMatch(/value_chain_step_created_rev_fk/);
  });

  it('saves revisions from humans only', async () => {
    const insert = (rev: number, sourceKind: string, base = 'NULL') =>
      sql.raw(
        `INSERT INTO value_chain_revision (id, project_id, value_chain_id, rev, content, content_hash,
           structure_hash, schema_version, base_revision_id, principal_id, source_kind, seq)
         SELECT 'vcr_x', project_id, value_chain_id, ${rev}, content, content_hash, structure_hash,
           schema_version, ${base}, principal_id, '${sourceKind}', seq
         FROM value_chain_revision WHERE id = '${revisionId}'`,
      );
    expect(await failure(insert(90, 'agent'))).toMatch(/value_chain_revision_humans_only/);
    expect(await failure(insert(90, 'rule'))).toMatch(/value_chain_revision_humans_only/);
    expect(await failure(insert(0, 'human'))).toMatch(/value_chain_revision_rev_check/);
    expect(await failure(insert(1, 'human'))).toMatch(/value_chain_revision_chain_rev_unique/);
    // The base revision belongs to the same chain.
    expect(await failure(insert(91, 'human', "'vcr_second'"))).toMatch(
      /value_chain_revision_base_fk/,
    );
  });

  it('points the head at a revision of the same chain', async () => {
    expect(
      await failure(
        sql.raw(`UPDATE value_chain SET head_revision_id = 'vcr_second' WHERE id = '${chainId}'`),
      ),
    ).toMatch(/value_chain_head_revision_fk/);
  });

  it('checks placement assertions: humans decide, nothing is auto-accepted, notes by humans', async () => {
    const insert = (cols: {
      kind: string;
      verdict?: string;
      sourceKind: string;
      tier?: string;
      stepHash?: string;
      processHash?: string;
      linked?: string;
    }) =>
      sql.raw(
        `INSERT INTO placement_assertion (id, project_id, placement_id, seq, kind, verdict, source_kind,
           principal_id, tier, step_hash, process_hash, linked_placement_id)
         SELECT 'pas_x', project_id, placement_id, 999, '${cols.kind}', ${cols.verdict ? `'${cols.verdict}'` : 'NULL'},
           '${cols.sourceKind}', principal_id, ${cols.tier ? `'${cols.tier}'` : 'NULL'},
           ${cols.stepHash ? `'${cols.stepHash}'` : 'NULL'}, ${cols.processHash ? `'${cols.processHash}'` : 'NULL'},
           ${cols.linked ? `'${cols.linked}'` : 'NULL'}
         FROM placement_assertion WHERE placement_id = '${placementId}' LIMIT 1`,
      );
    const cases: [Parameters<typeof insert>[0], RegExp][] = [
      [
        { kind: 'decision', verdict: 'accept', sourceKind: 'agent' },
        /placement_assertion_agents_never_decide/,
      ],
      [
        { kind: 'decision', verdict: 'accept', sourceKind: 'rule' },
        /placement_assertion_rules_never_decide/,
      ],
      [{ kind: 'note', sourceKind: 'agent' }, /placement_assertion_notes_by_humans/],
      [{ kind: 'decision', sourceKind: 'human' }, /placement_assertion_verdict_check/],
      [
        { kind: 'proposal', verdict: 'accept', sourceKind: 'agent' },
        /placement_assertion_verdict_check/,
      ],
      [{ kind: 'proposal', sourceKind: 'agent', stepHash: 'h' }, /placement_assertion_basis_check/],
      [
        { kind: 'proposal', sourceKind: 'agent', processHash: 'h' },
        /placement_assertion_basis_check/,
      ],
      [
        { kind: 'decision', verdict: 'hold', sourceKind: 'human', stepHash: 'h', processHash: 'h' },
        /placement_assertion_basis_check/,
      ],
      [{ kind: 'proposal', sourceKind: 'rule', tier: 'rule' }, /placement_assertion_tier_check/],
      [
        { kind: 'proposal', sourceKind: 'agent', linked: 'plc_missing' },
        /placement_assertion_linked_fk/,
      ],
    ];
    for (const [cols, message] of cases) {
      expect(await failure(insert(cols)), JSON.stringify(cols)).toMatch(message);
    }
    // A basis with both hashes on a proposal is allowed.
    await database.db.execute(
      insert({
        kind: 'proposal',
        sourceKind: 'agent',
        tier: 'semantic',
        stepHash: 'h1',
        processHash: 'h2',
      }),
    );
  });

  it('refuses an agent decision even through the store', async () => {
    const store = createStore(database.db);
    await expect(
      store.write((tx) =>
        tx.placementAssertions.insert({
          id: newId('placementAssertion'),
          projectId: projectId as ProjectId,
          placementId,
          seq: 1001,
          kind: 'decision',
          verdict: 'accept',
          sourceKind: 'agent',
          principalId: ownerId,
          clientId: 'agt_x',
          declared: null,
          submissionId: null,
          tier: null,
          confidence: null,
          rationale: null,
          evidence: null,
          question: null,
          label: null,
          linkedPlacementId: null,
          stepFp: null,
          processFp: null,
          stepHash: null,
          processHash: null,
        }),
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'placement_assertion_agents_never_decide' } });
  });

  it('keeps placements on a step generation of their chain and project', async () => {
    const insert = (
      project: string,
      chain: string,
      elementId: string,
      generation: number,
      tier = 'semantic',
    ) =>
      sql.raw(
        `INSERT INTO placement (id, project_id, value_chain_id, element_id, generation, process_ref, status,
           endpoint_state, tier)
         VALUES ('plc_x', '${project}', '${chain}', '${elementId}', ${generation}, 'a/caller#P_A', 'proposed',
           'ok', '${tier}')`,
      );
    // Another chain's generation, a generation that never existed, another project.
    expect(await failure(insert(projectId, chainId, 'only-second', 1))).toMatch(
      /placement_step_fk/,
    );
    expect(await failure(insert(projectId, chainId, OUTSIDE, 99))).toMatch(/placement_step_fk/);
    expect(await failure(insert(otherProjectId, chainId, OUTSIDE, 1))).toMatch(/placement_step_fk/);
    expect(await failure(insert(projectId, chainId, OUTSIDE, 1, 'rule'))).toMatch(
      /placement_tier_check/,
    );
    // The generated model key column.
    const [row] = (
      await database.db.execute<{ process_model: string }>(
        sql.raw(`SELECT process_model FROM placement WHERE id = '${placementId}'`),
      )
    ).rows;
    expect(row?.process_model).toBe('a/caller');
  });

  it('checks the submission reference of a placement assertion at commit (deferred)', async () => {
    const client = new pg.Client({ connectionString: database.url });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO placement_assertion (id, project_id, placement_id, seq, kind, source_kind, principal_id, submission_id)
         SELECT 'pas_deferred', project_id, id, 998, 'proposal', 'agent', '${ownerId}', 'sbm_missing'
         FROM placement WHERE id = '${placementId}'`,
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({
        constraint: 'placement_assertion_submission_fk',
      });
    } finally {
      await client.end();
    }
  });
});
