/**
 * Ingest of `eval/corpus/_sample` end to end with the real deterministic
 * libraries (`libraryAnalysis`: `@proa/bpmn-facts` + `@proa/relations`),
 * checked against `eval/corpus/_sample/expected.yaml`. The scored landscapes
 * are covered by corpus.test.ts.
 */
import type {
  FindingList,
  ImportResult,
  ModelPage,
  RelationPage,
  RevisionFacts,
} from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { corpusFiles, importForm, libraryView, type CorpusFile } from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let database: TestDatabase;
let t: TestApp;
let files: CorpusFile[];

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { analysis: libraryAnalysis });
  await t.createProject('sample');
  files = await corpusFiles('_sample');
});

afterAll(async () => {
  await database.drop();
});

async function relations(): Promise<string[]> {
  const page = (await (
    await t.asOwner('/api/v1/projects/sample/relations?limit=200')
  ).json()) as RelationPage;
  return page.items.map((r) => `${r.type} ${r.from} ${r.to} ${r.status} ${r.tier}`).sort();
}

describe('real @proa/bpmn-facts and @proa/relations on eval/corpus/_sample', () => {
  it('imports every model and stores the extracted facts', async () => {
    const res = await t.asOwner('/api/v1/projects/sample/imports', {
      method: 'POST',
      body: importForm(files),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as ImportResult;
    expect(result.files.map((f) => [f.modelKey, f.outcome])).toEqual([
      ['finance/payment-collection', 'created'],
      ['finanzen/rechnungsstellung', 'created'],
      ['vertrieb/auftragsabwicklung', 'created'],
    ]);

    const models = (await (await t.asOwner('/api/v1/projects/sample/models')).json()) as ModelPage;
    // The engine comes from `modeler:executionPlatform` (M2).
    expect(models.items.map((m) => [m.key, m.engine])).toEqual([
      ['finance/payment-collection', 'c7'],
      ['finanzen/rechnungsstellung', 'c8'],
      ['vertrieb/auftragsabwicklung', 'c7'],
    ]);
    const order = models.items.find((m) => m.key === 'vertrieb/auftragsabwicklung');
    expect(order).toBeDefined();
    const facts = (await (
      await t.asOwner(
        `/api/v1/projects/sample/models/${order?.id}/revisions/${order?.headRevisionId}/facts`,
      )
    ).json()) as RevisionFacts;
    const refs = facts.facts.map((f) => f.ref);
    expect(refs).toContain('vertrieb/auftragsabwicklung#Call_ZahlungAbwickeln');
    expect(refs).toContain('vertrieb/auftragsabwicklung#Event_WareVersandbereit');
  });

  it('derives the rule-tier links of expected.yaml and nothing it forbids', async () => {
    const stored = await relations();
    // must_link pairs the rule tier can see (same id or name); the de-en
    // message is semantic and left to agents.
    expect(stored).toEqual(
      [
        'call vertrieb/auftragsabwicklung#Call_ZahlungAbwickeln finance/payment-collection#Process_PaymentCollection accepted rule',
        'message vertrieb/auftragsabwicklung#Event_WareVersandbereit finanzen/rechnungsstellung#Start_WareVersandbereit proposed key',
        'signal finanzen/rechnungsstellung#End_RechnungsstellungAbgeschlossen finance/payment-collection#Start_InvoicingCompleted proposed key',
        'signal finanzen/rechnungsstellung#End_RechnungsstellungAbgeschlossen vertrieb/auftragsabwicklung#Start_RechnungsstellungAbgeschlossen proposed key',
      ].sort(),
    );
    const { rules } = await libraryView(files);
    expect(
      rules.relations.map((r) => `${r.type} ${r.from} ${r.to} ${r.status} ${r.tier}`).sort(),
    ).toEqual(stored);
  });

  it('reports the findings of expected.yaml', async () => {
    const { items } = (await (
      await t.asOwner('/api/v1/projects/sample/findings')
    ).json()) as FindingList;
    const of = (kind: string) => items.filter((f) => f.kind === kind).flatMap((f) => f.refs);
    expect(of('dynamic-call')).toEqual(['finanzen/rechnungsstellung#Call_RechnungAusgeben']);
    expect(of('unresolved-call')).toEqual(['finanzen/rechnungsstellung#Call_Mahnwesen']);
    expect(of('duplicate-process-id')).toEqual([]);
    expect(of('dangling-throw')).toContain('finance/payment-collection#Task_SendReminder');
    expect(of('unmatched-catch')).toContain('finance/payment-collection#Event_PaymentReceived');
    const { rules } = await libraryView(files);
    expect(items).toEqual(rules.findings);
  });

  it('rejects hostile XML with 422 bpmn-invalid', async () => {
    const res = await t.putModel(
      'sample',
      'evil/xxe',
      '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d>&x;</d>',
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'bpmn-invalid' });
  });

  it('re-importing identical files changes nothing', async () => {
    const before = await relations();
    const res = await t.asOwner('/api/v1/projects/sample/imports', {
      method: 'POST',
      body: importForm(files),
    });
    const result = (await res.json()) as ImportResult;
    expect(result.files.every((f) => f.outcome === 'unchanged')).toBe(true);
    expect(await relations()).toEqual(before);
  });
});
