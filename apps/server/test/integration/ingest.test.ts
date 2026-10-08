import type {
  FindingList,
  ImportResult,
  Landscape,
  ModelPage,
  PutModelResult,
  RelationPage,
  RevisionFacts,
  RevisionPage,
} from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn, type FakeModelSpec } from '../support/fake-analysis.ts';

let database: TestDatabase;
let t: TestApp;

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database);
});

afterAll(async () => {
  await database.drop();
});

// A small landscape: order calls billing; order throws "Ware versandbereit",
// billing catches it; billing calls a process nobody defines.
const order: FakeModelSpec = {
  processes: [
    {
      id: 'Process_Order',
      name: 'Auftragsabwicklung',
      elements: [
        { kind: 'call', id: 'Call_Billing', name: 'Rechnung stellen', ref: 'Process_Billing' },
        {
          kind: 'msg_throw',
          id: 'Event_Shipped',
          name: 'Ware versandbereit',
          ref: 'WareVersandbereit',
        },
      ],
    },
  ],
};
const billing: FakeModelSpec = {
  processes: [
    {
      id: 'Process_Billing',
      name: 'Rechnungsstellung',
      elements: [
        {
          kind: 'msg_catch',
          id: 'Start_Shipped',
          name: 'Ware versandbereit',
          ref: 'WareVersandbereit',
          elementType: 'bpmn:StartEvent',
        },
        { kind: 'call', id: 'Call_Dunning', name: 'Mahnwesen', ref: 'Process_Dunning' },
      ],
    },
  ],
};

async function put(project: string, key: string, spec: FakeModelSpec | string) {
  const res = await t.putModel(project, key, typeof spec === 'string' ? spec : fakeBpmn(spec));
  return { status: res.status, body: (await res.json()) as PutModelResult };
}

async function count(table: string, projectId: string, where = 'true'): Promise<number> {
  const r = await database.db.execute<{ n: string }>(
    sql.raw(`SELECT count(*) AS n FROM ${table} WHERE project_id = '${projectId}' AND ${where}`),
  );
  return Number(r.rows[0]?.n);
}

async function relations(project: string, query = ''): Promise<RelationPage> {
  const res = await t.asOwner(`/api/v1/projects/${project}/relations${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as RelationPage;
}

describe('ingest (PUT …/models/by-key/{key})', () => {
  let projectId: string;

  beforeAll(async () => {
    projectId = (await t.createProject('ingest')).id;
  });

  it('creates a model with revision 1, stores its facts and queues an analysis task', async () => {
    const { status, body } = await put('ingest', 'vertrieb/auftrag', order);
    expect(status).toBe(201);
    expect(body.outcome).toBe('created');
    expect(body.model).toMatchObject({
      key: 'vertrieb/auftrag',
      name: 'Auftragsabwicklung',
      headRev: 1,
      stage: 'waiting_for_agent',
    });
    expect(body.revision).toMatchObject({
      rev: 1,
      factsVersion: 'test-1',
      source: { kind: 'upload' },
    });

    const facts = await t.asOwner(
      `/api/v1/projects/ingest/models/${body.model.id}/revisions/${body.revision.id}/facts`,
    );
    expect(facts.status).toBe(200);
    const f = (await facts.json()) as RevisionFacts;
    expect(f.facts.map((x) => x.ref).sort()).toEqual([
      'vertrieb/auftrag#Call_Billing',
      'vertrieb/auftrag#Event_Shipped',
      'vertrieb/auftrag#Process_Order',
    ]);
    expect(f.processes).toEqual([
      expect.objectContaining({ processId: 'Process_Order', name: 'Auftragsabwicklung' }),
    ]);
    expect(await count('analysis_task', projectId, "state = 'queued'")).toBe(1);
  });

  it('serves the verbatim bytes', async () => {
    const { body } = await put('ingest', 'vertrieb/auftrag', order);
    const res = await t.asOwner(
      `/api/v1/projects/ingest/models/${body.model.id}/revisions/${body.revision.id}/content`,
    );
    expect(res.headers.get('content-type')).toBe('application/xml');
    expect(await res.text()).toBe(fakeBpmn(order));
  });

  it('treats identical bytes as unchanged: no revision, no event', async () => {
    const before = await count('event', projectId);
    const { status, body } = await put('ingest', 'vertrieb/auftrag', order);
    expect(status).toBe(200);
    expect(body.outcome).toBe('unchanged');
    expect(body.revision.rev).toBe(1);
    expect(await count('event', projectId)).toBe(before);
    expect(await count('model_revision', projectId)).toBe(1);
  });

  it('accepts the unambiguous call once its target exists and proposes the message by key', async () => {
    const before = Date.now() - 60_000;
    const { status } = await put('ingest', 'finanzen/rechnung', billing);
    expect(status).toBe(201);
    const page = await relations('ingest');
    // New relations carry the database's timestamp, not a placeholder.
    for (const r of page.items) expect(Date.parse(r.updatedAt)).toBeGreaterThan(before);
    expect(
      page.items.map((r) => [r.type, r.from, r.to, r.status, r.tier, r.endpointState]),
    ).toEqual([
      [
        'call',
        'vertrieb/auftrag#Call_Billing',
        'finanzen/rechnung#Process_Billing',
        'accepted',
        'rule',
        'ok',
      ],
      [
        'message',
        'vertrieb/auftrag#Event_Shipped',
        'finanzen/rechnung#Start_Shipped',
        'proposed',
        'key',
        'ok',
      ],
    ]);
    const findings = (await (
      await t.asOwner('/api/v1/projects/ingest/findings')
    ).json()) as FindingList;
    expect(findings.items).toEqual([
      {
        kind: 'unresolved-call',
        refs: ['finanzen/rechnung#Call_Dunning'],
        detail: 'no process Process_Dunning',
      },
    ]);
    // Rule assertions are recorded under the system principal with source_kind rule.
    const a = await database.db.execute<{
      kind: string;
      verdict: string | null;
      source_kind: string;
    }>(
      sql.raw(
        `SELECT a.kind, a.verdict, a.source_kind FROM relation_assertion a JOIN principal p ON p.id = a.principal_id
         WHERE a.project_id = '${projectId}' AND p.handle = 'proa-rules' ORDER BY a.seq`,
      ),
    );
    expect(a.rows).toEqual([
      { kind: 'decision', verdict: 'accept', source_kind: 'rule' },
      { kind: 'proposal', verdict: null, source_kind: 'rule' },
    ]);
  });

  it('counts open items per model (proposed message) and keeps both stages waiting for the agent', async () => {
    const res = await t.asOwner('/api/v1/projects/ingest/models');
    const page = (await res.json()) as ModelPage;
    expect(page.items.map((m) => [m.key, m.stage, m.openItems])).toEqual([
      ['finanzen/rechnung', 'waiting_for_agent', 1],
      ['vertrieb/auftrag', 'waiting_for_agent', 1],
    ]);
  });

  it('makes a layout-only change a new revision without a new analysis task', async () => {
    const tasks = await count('analysis_task', projectId);
    const { status, body } = await put('ingest', 'vertrieb/auftrag', { ...order, layout: 'moved' });
    expect(status).toBe(200);
    expect(body.outcome).toBe('revised');
    expect(body.revision.rev).toBe(2);
    expect(await count('analysis_task', projectId)).toBe(tasks);
    const revs = (await (
      await t.asOwner(`/api/v1/projects/ingest/models/${body.model.id}/revisions`)
    ).json()) as RevisionPage;
    expect(revs.items.map((r) => r.rev)).toEqual([2, 1]);
    expect(revs.items[0]?.factsHash).toBe(revs.items[1]?.factsHash);
    expect(revs.items[0]?.contentHash).not.toBe(revs.items[1]?.contentHash);
  });

  it('cancels the open task and queues a new one when the facts change', async () => {
    const changed: FakeModelSpec = {
      processes: [
        {
          id: 'Process_Order',
          name: 'Auftragsabwicklung',
          elements: [
            ...(order.processes[0]?.elements ?? []),
            { kind: 'evt_end', id: 'End_Done', name: 'Auftrag erledigt' },
          ],
        },
      ],
    };
    const { body } = await put('ingest', 'vertrieb/auftrag', changed);
    expect(body.revision.rev).toBe(3);
    const r = await database.db.execute<{ state: string; revision_id: string }>(
      sql.raw(
        `SELECT state, revision_id FROM analysis_task WHERE project_id = '${projectId}' AND model_id = '${body.model.id}' ORDER BY seq`,
      ),
    );
    expect(r.rows.map((x) => x.state)).toEqual(['cancelled', 'queued']);
    expect(r.rows[1]?.revision_id).toBe(body.revision.id);
    const events = await database.db.execute<{ type: string }>(
      sql.raw(`SELECT type FROM event WHERE project_id = '${projectId}' ORDER BY seq DESC LIMIT 3`),
    );
    expect(events.rows.map((e) => e.type)).toEqual([
      'analysis.queued',
      'analysis.cancelled',
      'model.revised',
    ]);
  });

  it('keeps the accepted call when its target is deleted: endpoint missing, an open item', async () => {
    const billingModel = (await (
      await t.asOwner('/api/v1/projects/ingest/models?limit=1')
    ).json()) as ModelPage;
    const id = billingModel.items[0]?.id;
    expect(billingModel.items[0]?.key).toBe('finanzen/rechnung');
    const del = await t.asOwner(`/api/v1/projects/ingest/models/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect((await t.asOwner(`/api/v1/projects/ingest/models/${id}`)).status).toBe(404);

    const page = await relations('ingest');
    expect(page.items.map((r) => [r.type, r.status, r.endpointState])).toEqual([
      ['call', 'accepted', 'missing'],
    ]);
    // The key-tier message proposal was withdrawn by the rules and is obsolete now.
    const obsolete = await relations('ingest', '?status=obsolete');
    expect(obsolete.items.map((r) => r.type)).toEqual(['message']);

    const models = (await (await t.asOwner('/api/v1/projects/ingest/models')).json()) as ModelPage;
    expect(models.items.map((m) => [m.key, m.openItems])).toEqual([['vertrieb/auftrag', 1]]);
    expect(await count('analysis_task', projectId, `model_id = '${id}' AND state = 'queued'`)).toBe(
      0,
    );
  });

  it('revives a deleted model on re-upload with the next revision; endpoints are ok again', async () => {
    const { status, body } = await put('ingest', 'finanzen/rechnung', billing);
    expect(status).toBe(201);
    expect(body.outcome).toBe('created');
    expect(body.revision.rev).toBe(2);
    const page = await relations('ingest');
    expect(page.items.map((r) => [r.type, r.status, r.endpointState])).toEqual([
      ['call', 'accepted', 'ok'],
      ['message', 'proposed', 'ok'],
    ]);
  });

  it('serves the landscape with an ETag and answers 304 while nothing changed', async () => {
    const res = await t.asOwner('/api/v1/projects/ingest/landscape');
    expect(res.status).toBe(200);
    const landscape = (await res.json()) as Landscape;
    const etag = res.headers.get('etag');
    expect(etag).toBe(`"s${landscape.seq}"`);
    expect(landscape.models.map((m) => m.key)).toEqual(['finanzen/rechnung', 'vertrieb/auftrag']);
    expect(landscape.relations).toHaveLength(2);
    expect(landscape.findings.map((f) => f.kind)).toEqual(['unresolved-call']);

    const again = await t.asOwner('/api/v1/projects/ingest/landscape', {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(again.status).toBe(304);

    await put('ingest', 'finanzen/rechnung', { ...billing, layout: 'x' });
    const changed = await t.asOwner('/api/v1/projects/ingest/landscape', {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(changed.status).toBe(200);
  });

  it('filters and pages relations', async () => {
    expect((await relations('ingest', '?type=message')).items).toHaveLength(1);
    expect((await relations('ingest', '?tier=rule')).items.map((r) => r.type)).toEqual(['call']);
    expect((await relations('ingest', '?modelKey=finanzen/rechnung')).items).toHaveLength(2);
    const first = await relations('ingest', '?limit=1');
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await relations('ingest', `?limit=1&cursor=${first.nextCursor ?? ''}`);
    expect(second.items.map((r) => r.type)).toEqual(['message']);
    expect(second.nextCursor).toBeNull();
    const bad = await t.asOwner('/api/v1/projects/ingest/relations?cursor=nope');
    expect(bad.status).toBe(422);
  });

  it('pages models and filters them by stage', async () => {
    const first = (await (
      await t.asOwner('/api/v1/projects/ingest/models?limit=1')
    ).json()) as ModelPage;
    const second = (await (
      await t.asOwner(`/api/v1/projects/ingest/models?limit=1&cursor=${first.nextCursor ?? ''}`)
    ).json()) as ModelPage;
    expect([...first.items, ...second.items].map((m) => m.key)).toEqual([
      'finanzen/rechnung',
      'vertrieb/auftrag',
    ]);
    const done = (await (
      await t.asOwner('/api/v1/projects/ingest/models?stage=incorporated')
    ).json()) as ModelPage;
    expect(done.items).toEqual([]);
  });
});

describe('stage (view model_pipeline)', () => {
  it('derives the stage from the latest task and the open items', async () => {
    const p = await t.createProject('stages');
    await put('stages', 'a/order', order);
    await put('stages', 'b/billing', billing);
    const setTask = (key: string, state: string) =>
      database.db.execute(
        sql.raw(
          `UPDATE analysis_task SET state = '${state}' WHERE project_id = '${p.id}'
           AND model_id = (SELECT id FROM model WHERE project_id = '${p.id}' AND key = '${key}')
           AND state IN ('queued', 'claimed')`,
        ),
      );
    const stageOf = async (key: string) => {
      const page = (await (await t.asOwner('/api/v1/projects/stages/models')).json()) as ModelPage;
      return page.items.find((m) => m.key === key)?.stage;
    };
    expect(await stageOf('a/order')).toBe('waiting_for_agent');
    await setTask('a/order', 'claimed');
    expect(await stageOf('a/order')).toBe('agent_working');
    await setTask('a/order', 'failed');
    expect(await stageOf('a/order')).toBe('agent_failed');
    // b/billing: done with a proposed message touching it.
    await setTask('b/billing', 'done');
    expect(await stageOf('b/billing')).toBe('waiting_for_review');
    await database.db.execute(
      sql.raw(
        `UPDATE relation SET status = 'held' WHERE project_id = '${p.id}' AND type = 'message'`,
      ),
    );
    expect(await stageOf('b/billing')).toBe('waiting_for_clarification');
    await database.db.execute(
      sql.raw(
        `UPDATE relation SET status = 'rejected' WHERE project_id = '${p.id}' AND type = 'message'`,
      ),
    );
    expect(await stageOf('b/billing')).toBe('incorporated');
    const filtered = (await (
      await t.asOwner('/api/v1/projects/stages/models?stage=incorporated')
    ).json()) as ModelPage;
    expect(filtered.items.map((m) => m.key)).toEqual(['b/billing']);
  });

  // Judge each pair once: a revert queues a task, since partners may have judged the pairs
  // against the other version meanwhile (before 0.2.0 the last done task's facts queued none).
  it('queues again when the facts return to those of the last done task', async () => {
    const p = await t.createProject('requeue');
    const first = await put('requeue', 'a/order', order);
    await database.db.execute(
      sql.raw(`UPDATE analysis_task SET state = 'done' WHERE project_id = '${p.id}'`),
    );
    await put('requeue', 'a/order', billing); // different facts: queued
    await put('requeue', 'a/order', { ...order, layout: 'back' }); // facts of the done task again
    const r = await database.db.execute<{ state: string }>(
      sql.raw(`SELECT state FROM analysis_task WHERE project_id = '${p.id}' ORDER BY seq`),
    );
    expect(r.rows.map((x) => x.state)).toEqual(['done', 'cancelled', 'queued']);
    expect(first.body.model.stage).toBe('waiting_for_agent');
  });
});

describe('ingest errors', () => {
  beforeAll(async () => {
    await t.createProject('errors');
  });

  it('answers 422 bpmn-invalid for hostile XML and nothing is stored', async () => {
    const res = await t.putModel('errors', 'a/b', '<!DOCTYPE x [<!ENTITY e "boom">]><x/>');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'bpmn-invalid', reason: 'doctype-forbidden' });
    expect((await (await t.asOwner('/api/v1/projects/errors/models')).json()) as ModelPage).toEqual(
      {
        items: [],
        nextCursor: null,
      },
    );
  });

  it('answers 415 for other media types and 413 for oversize bodies', async () => {
    const res = await t.asOwner('/api/v1/projects/errors/models/by-key/a%2Fb', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(415);
    const big = await t.putModel('errors', 'a/b', 'x'.repeat(5 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ code: 'payload-too-large' });
  });

  it('validates the model key (422)', async () => {
    const res = await t.putModel('errors', 'Not A Key', fakeBpmn(order));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'validation-failed' });
  });

  it('answers 404 for unknown projects and models', async () => {
    expect((await t.putModel('nope', 'a/b', fakeBpmn(order))).status).toBe(404);
    expect(
      (await t.asOwner('/api/v1/projects/errors/models/mdl_01J9Z3N4X5Q6R7S8T9V0W1X2Y3')).status,
    ).toBe(404);
  });
});

describe('import (POST …/imports)', () => {
  beforeAll(async () => {
    await t.createProject('imports');
  });

  function form(files: [string, string][]): FormData {
    const fd = new FormData();
    for (const [path, content] of files) {
      fd.append('files', new Blob([content], { type: 'application/xml' }), path);
    }
    return fd;
  }

  it('derives keys from paths, ingests in one go and reports per file', async () => {
    const res = await t.asOwner('/api/v1/projects/imports/imports', {
      method: 'POST',
      body: form([
        ['Vertrieb/Auftragsabwicklung.bpmn', fakeBpmn(order)],
        ['finanzen/rechnungsstellung.bpmn', fakeBpmn(billing)],
        ['broken.bpmn', 'not xml at all'],
        ['vertrieb/auftragsabwicklung.bpmn', fakeBpmn(order)],
        ['---.bpmn', fakeBpmn(order)],
      ]),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ImportResult;
    expect(
      result.files.map((f) => [f.path, f.modelKey, f.outcome, f.problem?.code ?? null]),
    ).toEqual([
      ['Vertrieb/Auftragsabwicklung.bpmn', 'vertrieb/auftragsabwicklung', 'created', null],
      ['finanzen/rechnungsstellung.bpmn', 'finanzen/rechnungsstellung', 'created', null],
      ['broken.bpmn', 'broken', 'failed', 'bpmn-invalid'],
      [
        'vertrieb/auftragsabwicklung.bpmn',
        'vertrieb/auftragsabwicklung',
        'failed',
        'validation-failed',
      ],
      ['---.bpmn', null, 'failed', 'validation-failed'],
    ]);
    const page = await relations('imports');
    expect(page.items.map((r) => [r.type, r.status])).toEqual([
      ['call', 'accepted'],
      ['message', 'proposed'],
    ]);

    const again = await t.asOwner('/api/v1/projects/imports/imports', {
      method: 'POST',
      body: form([['finanzen/rechnungsstellung.bpmn', fakeBpmn(billing)]]),
    });
    const r2 = (await again.json()) as ImportResult;
    expect(r2.files[0]?.outcome).toBe('unchanged');
  });

  it('rejects empty imports and non-multipart bodies', async () => {
    const empty = await t.asOwner('/api/v1/projects/imports/imports', {
      method: 'POST',
      body: new FormData(),
    });
    expect([415, 422]).toContain(empty.status);
    const json = await t.asOwner('/api/v1/projects/imports/imports', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(415);
  });

  it('rejects more than 50 files', async () => {
    const files: [string, string][] = Array.from({ length: 51 }, (_, i) => [
      `m/f${i}.bpmn`,
      fakeBpmn(order),
    ]);
    const res = await t.asOwner('/api/v1/projects/imports/imports', {
      method: 'POST',
      body: form(files),
    });
    expect(res.status).toBe(422);
  });
});
