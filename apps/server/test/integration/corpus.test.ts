/**
 * The scored eval landscapes through the real server with the real libraries
 * (`@proa/bpmn-facts`, `@proa/relations`): importing `nordwind-handel` and
 * `stadtwerke-auental` into one project each must store every model and
 * produce exactly the rule relations and findings that `eval:candidates`
 * computes (`eval/reports/candidates.json`). Re-imports are no-ops; a changed
 * model gets a revision and its relations are recomputed; deleting a model
 * turns the partner relations' endpoint state to `missing`.
 */
import type {
  Finding,
  FindingList,
  Landscape,
  Model,
  ModelPage,
  Project,
  PutModelResult,
  Relation,
  RelationPage,
  RevisionFacts,
  RevisionPage,
} from '@proa/contracts';
import type { RuleResult } from '@proa/relations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import {
  candidatesReport,
  corpusFiles,
  importAll,
  libraryView,
  type CandidatesReport,
  type CorpusFile,
} from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let database: TestDatabase;
let t: TestApp;
let report: CandidatesReport;

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { analysis: libraryAnalysis });
  report = await candidatesReport();
});

afterAll(async () => {
  await database.drop();
});

const asOwner = (path: string, init?: RequestInit) => t.asOwner(path, init);

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await t.asOwner(path, init);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function allRelations(project: string, query = ''): Promise<Relation[]> {
  const items: Relation[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams(query);
    q.set('limit', '200');
    if (cursor) q.set('cursor', cursor);
    const page: RelationPage = await json(`/api/v1/projects/${project}/relations?${q.toString()}`);
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

async function allModels(project: string): Promise<Model[]> {
  const page = await json<ModelPage>(`/api/v1/projects/${project}/models?limit=200`);
  expect(page.nextCursor).toBeNull();
  return page.items;
}

async function project(key: string): Promise<Project> {
  return json<Project>(`/api/v1/projects/${key}`);
}

function relationLine(r: { type: string; from: string; to: string; status: string }): string {
  return `${r.type} ${r.from} -> ${r.to} ${r.status}`;
}

/** Findings in the report's form: one entry per ref, duplicate ids as one space-joined group. */
function findingRefs(findings: readonly Finding[], kind: string): string[] {
  const of = findings.filter((f) => f.kind === kind);
  return (
    kind === 'duplicate-process-id' ? of.map((f) => f.refs.join(' ')) : of.flatMap((f) => f.refs)
  ).sort();
}

function put(projectKey: string, key: string, xml: string | Uint8Array) {
  return t.asOwner(`/api/v1/projects/${projectKey}/models/by-key/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/xml' },
    body: xml,
  });
}

describe.each(['nordwind-handel', 'stadtwerke-auental'])('import of %s', (landscape) => {
  let files: CorpusFile[];
  let expected: CandidatesReport['landscapes'][number];
  let rules: RuleResult;
  let factCount: number;

  beforeAll(async () => {
    files = await corpusFiles(landscape);
    const entry = report.landscapes.find((l) => l.name === landscape);
    if (!entry) throw new Error(`${landscape} missing in eval/reports/candidates.json`);
    expected = entry;
    ({ rules, factCount } = await libraryView(files));
    await t.createProject(landscape);
  });

  it('stores every model as revision 1', async () => {
    const outcomes = await importAll(asOwner, landscape, files);
    expect(outcomes).toHaveLength(expected.counts.models);
    expect(outcomes.filter((o) => o.outcome !== 'created')).toEqual([]);
    expect(outcomes.map((o) => o.modelKey)).toEqual(files.map((f) => f.key));

    const models = await allModels(landscape);
    expect(models.map((m) => m.key)).toEqual(files.map((f) => f.key));
    expect(models.every((m) => m.headRev === 1 && m.stage === 'waiting_for_agent')).toBe(true);
  });

  it('stores the facts the extractor gives (counts of eval:candidates)', async () => {
    expect(factCount).toBe(expected.counts.facts);
    let stored = 0;
    for (const m of await allModels(landscape)) {
      const facts = await json<RevisionFacts>(
        `/api/v1/projects/${landscape}/models/${m.id}/revisions/${m.headRevisionId}/facts`,
      );
      stored += facts.facts.length;
    }
    expect(stored).toBe(expected.counts.facts);
    const view = await json<Landscape>(`/api/v1/projects/${landscape}/landscape`);
    expect(view.models.flatMap((m) => m.processes)).toHaveLength(expected.counts.processes);
  });

  it('derives exactly the rule relations of eval:candidates', async () => {
    const stored = await allRelations(landscape);
    const byStatus = (s: string) => stored.filter((r) => r.status === s).length;
    expect(byStatus('accepted')).toBe(expected.counts.rules.accepted);
    expect(byStatus('proposed')).toBe(expected.counts.rules.proposed);
    expect(stored).toHaveLength(expected.counts.rules.accepted + expected.counts.rules.proposed);

    expect(stored.map(relationLine).sort()).toEqual(rules.relations.map(relationLine).sort());
    // Tier, confidence and attributes (call binding, match kind, names) as derived.
    const derived = new Map(rules.relations.map((d) => [relationLine(d), d]));
    for (const r of stored) {
      const d = derived.get(relationLine(r));
      expect(r.endpointState, relationLine(r)).toBe('ok');
      expect([r.tier, r.confidence, r.attrs], relationLine(r)).toEqual([
        d?.tier,
        d?.confidence,
        d?.attrs,
      ]);
    }
  });

  it('stores exactly the findings of eval:candidates', async () => {
    const { items } = await json<FindingList>(`/api/v1/projects/${landscape}/findings`);
    expect(items).toHaveLength(rules.findings.length);
    for (const check of expected.findings) {
      expect(findingRefs(items, check.kind), check.kind).toEqual([...check.computed].sort());
    }
  });

  it('is idempotent on re-import: nothing changes, no event is written', async () => {
    const before = await project(landscape);
    const relationsBefore = await allRelations(landscape);
    const outcomes = await importAll(asOwner, landscape, files);
    expect(outcomes.every((o) => o.outcome === 'unchanged')).toBe(true);
    expect((await project(landscape)).lastSeq).toBe(before.lastSeq);
    expect(await allRelations(landscape)).toEqual(relationsBefore);
    expect((await allModels(landscape)).every((m) => m.headRev === 1)).toBe(true);
  });
});

describe('changes to nordwind-handel', () => {
  const P = 'nordwind-handel';
  const GUTSCHRIFT = 'finanzen/gutschrift';
  const CALL =
    'call finanzen/gutschrift#Call_GutschriftVersenden -> finanzen/briefversand#Process_Briefversand';
  let original: Uint8Array;

  beforeAll(async () => {
    const file = (await corpusFiles(P)).find((f) => f.key === GUTSCHRIFT);
    if (!file) throw new Error(`${GUTSCHRIFT} missing in the corpus`);
    original = file.bytes;
  });

  function lines(rs: readonly Relation[]): string[] {
    return rs.map(relationLine);
  }

  it('a changed model gets a new revision and its relations are recomputed', async () => {
    expect(lines(await allRelations(P))).toContain(`${CALL} accepted`);
    const changed = new TextDecoder()
      .decode(original)
      .replace('calledElement="Process_Briefversand"', 'calledElement="Process_Briefdienst"');
    expect(changed).toContain('Process_Briefdienst');

    const res = await put(P, GUTSCHRIFT, changed);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PutModelResult;
    expect(body.outcome).toBe('revised');
    expect(body.revision.rev).toBe(2);
    expect(body.model).toMatchObject({ headRev: 2, stage: 'waiting_for_agent' });

    const revisions = await json<RevisionPage>(
      `/api/v1/projects/${P}/models/${body.model.id}/revisions`,
    );
    expect(revisions.items.map((r) => r.rev)).toEqual([2, 1]);
    const facts = await json<RevisionFacts>(
      `/api/v1/projects/${P}/models/${body.model.id}/revisions/${body.revision.id}/facts`,
    );
    expect(facts.facts.find((f) => f.elementId === 'Call_GutschriftVersenden')?.keyRaw).toBe(
      'Process_Briefdienst',
    );

    // The rule no longer derives the call: withdrawn, hidden as obsolete.
    expect(lines(await allRelations(P))).not.toContain(`${CALL} accepted`);
    expect(lines(await allRelations(P, 'status=obsolete'))).toContain(`${CALL} obsolete`);
    const { items } = await json<FindingList>(`/api/v1/projects/${P}/findings`);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: 'unresolved-call',
        refs: ['finanzen/gutschrift#Call_GutschriftVersenden'],
      }),
    );
  });

  it('restoring the original bytes accepts the call again (revision 3)', async () => {
    const res = await put(P, GUTSCHRIFT, original);
    const body = (await res.json()) as PutModelResult;
    expect(body.outcome).toBe('revised');
    expect(body.revision.rev).toBe(3);
    expect(lines(await allRelations(P))).toContain(`${CALL} accepted`);
    const { items } = await json<FindingList>(`/api/v1/projects/${P}/findings`);
    expect(findingRefs(items, 'unresolved-call')).not.toContain(
      'finanzen/gutschrift#Call_GutschriftVersenden',
    );
  });

  it('deleting a model turns partner relations missing; uploading it again restores them', async () => {
    const shipping = (await allModels(P)).find((m) => m.key === 'logistik/shipping');
    if (!shipping) throw new Error('logistik/shipping not stored');
    const touching = (rs: readonly Relation[]) =>
      rs.filter(
        (r) => r.from.startsWith('logistik/shipping#') || r.to.startsWith('logistik/shipping#'),
      );
    const before = touching(await allRelations(P));
    const acceptedCalls = before.filter((r) => r.type === 'call' && r.status === 'accepted');
    expect(acceptedCalls.map((r) => r.from).sort()).toEqual([
      'service/ersatzlieferung#Call_ErsatzwareVersenden',
      'vertrieb/order-handling#Call_ShipOrder',
    ]);
    const seq = (await project(P)).lastSeq;

    const del = await t.asOwner(`/api/v1/projects/${P}/models/${shipping.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    expect((await allModels(P)).map((m) => m.key)).not.toContain('logistik/shipping');

    const after = touching(await allRelations(P));
    // Accepted calls stay accepted with a missing endpoint (open items);
    // the rule's key-tier proposals touching the model are withdrawn.
    expect(after.map((r) => [r.from, r.status, r.endpointState]).sort()).toEqual(
      acceptedCalls.map((r) => [r.from, 'accepted', 'missing']).sort(),
    );
    const obsolete = touching(await allRelations(P, 'status=obsolete'));
    expect(obsolete).toHaveLength(before.length - acceptedCalls.length);

    const { items } = await json<FindingList>(`/api/v1/projects/${P}/findings`);
    for (const r of acceptedCalls) {
      expect(findingRefs(items, 'unresolved-call')).toContain(r.from);
    }
    const callers = await allModels(P);
    for (const key of ['vertrieb/order-handling', 'service/ersatzlieferung']) {
      expect(callers.find((m) => m.key === key)?.openItems, key).toBeGreaterThan(0);
    }
    expect((await project(P)).lastSeq).toBeGreaterThan(seq);

    const file = (await corpusFiles(P)).find((f) => f.key === 'logistik/shipping');
    if (!file) throw new Error('logistik/shipping missing in the corpus');
    const res = await put(P, 'logistik/shipping', file.bytes);
    expect(((await res.json()) as PutModelResult).outcome).toBe('created');
    const restored = touching(await allRelations(P));
    expect(restored.map(relationLine).sort()).toEqual(before.map(relationLine).sort());
    expect(restored.every((r) => r.endpointState === 'ok')).toBe(true);
  });

  it('after the round trip the project matches eval:candidates again', async () => {
    const { rules } = await libraryView(await corpusFiles(P));
    expect((await allRelations(P)).map(relationLine).sort()).toEqual(
      rules.relations.map(relationLine).sort(),
    );
    const { items } = await json<FindingList>(`/api/v1/projects/${P}/findings`);
    expect(items).toEqual(rules.findings);
  });
});
