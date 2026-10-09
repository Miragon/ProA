/**
 * The value chain follows the models (M4 S2), through the real server with
 * the real libraries on the dev landscape and its golden chain: model ingest
 * and deletion refresh the placements' endpoint state and derive the rule
 * tier's key proposals again. An accepted placement turns `changed` when its
 * process is renamed and `missing` when its model is deleted, and returns to
 * `ok` with the original model; a rule proposal whose process name changes
 * is withdrawn and comes back with it; unchanged re-imports and layout-only
 * re-saves (model and chain) move nothing; the relations and findings stay
 * exactly those of `eval:candidates`. Every rule proposal of the golden chain
 * is the process's `must` or one of its `may` steps. A placement proposed ad
 * hoc over MCP by an agent token and accepted over REST survives an unchanged
 * re-import and a layout-only re-save (the M4a done criterion, S4). The
 * holdout is never read.
 */
import { readFile } from 'node:fs/promises';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
  Finding,
  FindingList,
  ImportResult,
  Placement,
  PlacementPage,
  PlacementAssertionList,
  PostPlacementsResult,
  Project,
  PutModelResult,
  Ref,
  Relation,
  RelationPage,
  SaveValueChainResult,
} from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { libraryAnalysis } from '../../src/analysis.ts';
import { createStore } from '../../src/db/store.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { corpusFiles, importAll, libraryView, type CorpusFile } from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { listen } from '../support/http.ts';
import { NORDWIND_CHAIN, NORDWIND_PLACEMENTS, chainPath } from '../support/value-chain.ts';

const P = 'vc-ingest';
const GUTSCHRIFT = 'finanzen/gutschrift#Process_Gutschrift' as Ref;
const SHIPPING = 'logistik/shipping#Process_Shipping' as Ref;
const WARENEINGANG = 'lager/wareneingang#Process_Wareneingang' as Ref;
const ORDER_HANDLING = 'vertrieb/order-handling#Process_OrderHandling' as Ref;

let database: TestDatabase;
let t: TestApp;
let project: Project;
let files: CorpusFile[];
let rev = 0;
let server: { url: string; close: () => Promise<void> } | undefined;
const clients: Client[] = [];

const store = () => createStore(database.db);
const events = (after = 0) =>
  store().read((tx) => tx.events.list(project.id, { afterSeq: after, limit: 10_000 }));
const lastSeq = async () => (await events()).at(-1)?.seq ?? 0;

async function json<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  expect(res.status, text.slice(0, 500)).toBe(status);
  return JSON.parse(text) as T;
}

async function placements(query = ''): Promise<Placement[]> {
  const page = await json<PlacementPage>(
    await t.asOwner(chainPath(P, `/placements?limit=200${query}`)),
  );
  expect(page.nextCursor).toBeNull();
  return page.items;
}

async function on(step: string, process: Ref, query = ''): Promise<Placement | undefined> {
  return (await placements(query)).find((p) => p.elementId === step && p.process === process);
}

async function allRelations(): Promise<Relation[]> {
  const items: Relation[] = [];
  let cursor: string | null = null;
  do {
    const q: string = cursor ? `&cursor=${cursor}` : '';
    const page: RelationPage = await json<RelationPage>(
      await t.asOwner(`/api/v1/projects/${P}/relations?limit=200${q}`),
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

const relationLine = (r: { type: string; from: string; to: string; status: string }) =>
  `${r.type} ${r.from} -> ${r.to} ${r.status}`;

function original(key: string): Uint8Array {
  const file = files.find((f) => f.key === key);
  if (!file) throw new Error(`${key} missing in the corpus`);
  return file.bytes;
}

async function putModel(key: string, bytes: Uint8Array | string): Promise<PutModelResult> {
  const res = await t.asOwner(`/api/v1/projects/${P}/models/by-key/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/xml' },
    body: bytes,
  });
  expect([200, 201]).toContain(res.status);
  return (await res.json()) as PutModelResult;
}

function edited(key: string, from: string, to: string): string {
  const xml = new TextDecoder().decode(original(key));
  expect(xml).toContain(from);
  return xml.replace(from, to);
}

async function golden(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(NORDWIND_CHAIN, 'utf8')) as Record<string, unknown>;
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { analysis: libraryAnalysis });
  project = await t.createProject(P);
  files = await corpusFiles('nordwind-handel');
  const outcomes = await importAll((path, init) => t.asOwner(path, init), P, files);
  expect(outcomes.every((o) => o.outcome === 'created')).toBe(true);
  const created = await json<SaveValueChainResult>(
    await t.asOwner(chainPath(P, '/content'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'if-none-match': '*' },
      body: await readFile(NORDWIND_CHAIN, 'utf8'),
    }),
    201,
  );
  rev = created.valueChain?.headRev ?? 0;
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await server?.close();
  await database.drop();
});

/** The head revision from `GET …/content` (`ETag: "r<rev>"`). */
async function headRev(): Promise<number> {
  const res = await t.asOwner(chainPath(P, '/content'));
  expect(res.status).toBe(200);
  await res.arrayBuffer();
  return Number(/^"r(\d+)"$/.exec(res.headers.get('etag') ?? '')?.[1] ?? 0);
}

/** The golden chain with every shape and waypoint moved right by `dx` (a layout-only change). */
async function shiftedGolden(dx: number): Promise<Record<string, unknown>> {
  const shifted = await golden();
  const move = (p: { x: number }) => {
    p.x += dx;
  };
  for (const e of shifted['elements'] as { bounds: { x: number } }[]) move(e.bounds);
  for (const c of shifted['connections'] as { waypoints: { x: number }[] }[]) {
    c.waypoints.forEach(move);
  }
  return shifted;
}

describe('the golden dev chain on the dev landscape', () => {
  it('gets the rule tier’s key proposals for equal names, each a must or may step', async () => {
    const expected = parse(await readFile(NORDWIND_PLACEMENTS, 'utf8')) as {
      placements: { process: string; must: string; may?: string[] }[];
    };
    const allowed = new Map(
      expected.placements.map((p) => [p.process, [p.must, ...(p.may ?? [])]]),
    );
    const all = await placements();
    expect(all.map((p) => [p.elementId, p.process])).toEqual([
      ['step-mahnwesen', 'finanzen/mahnwesen#Process_Mahnwesen'],
      ['step-rechnungsstellung', 'finanzen/rechnungsstellung#Process_Rechnungsstellung'],
      ['step-wareneingang', WARENEINGANG],
      ['step-zahlungseingang', 'finanzen/zahlungseingang#Process_Zahlungseingang'],
    ]);
    for (const p of all) {
      expect(p).toMatchObject({ status: 'proposed', tier: 'key', confidence: 1, source: 'rule' });
      expect(allowed.get(p.process), p.process).toContain(p.elementId);
    }
  });

  it('places processes by decision and by hand', async () => {
    const accept = await on(
      'step-rechnungsstellung',
      'finanzen/rechnungsstellung#Process_Rechnungsstellung',
    );
    await json(
      await t.asOwner(chainPath(P, `/placements/${accept?.id ?? ''}/decision`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'accept' }),
      }),
    );
    for (const [step, process] of [
      ['step-rechnungsstellung', GUTSCHRIFT],
      ['step-paketversand', SHIPPING],
    ] as const) {
      const r = await json<PostPlacementsResult>(
        await t.asOwner(chainPath(P, '/placements'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'manual', step, process, rationale: 'Golden must.' }),
        }),
      );
      expect(r.kind === 'manual' && r.placement.status).toBe('accepted');
    }
    expect((await placements('&status=accepted')).map((p) => p.process).sort()).toEqual([
      GUTSCHRIFT,
      'finanzen/rechnungsstellung#Process_Rechnungsstellung',
      SHIPPING,
    ]);
  });
});

describe('model changes', () => {
  it('a renamed process turns its accepted placement changed; the original makes it ok', async () => {
    const before = await on('step-rechnungsstellung', GUTSCHRIFT);
    const seq = await lastSeq();
    const renamed = await putModel(
      'finanzen/gutschrift',
      edited(
        'finanzen/gutschrift',
        'id="Process_Gutschrift" name="Gutschrift erstellen"',
        'id="Process_Gutschrift" name="Gutschrift anlegen"',
      ),
    );
    expect(renamed.outcome).toBe('revised');
    const changed = await on('step-rechnungsstellung', GUTSCHRIFT);
    expect(changed).toMatchObject({
      id: before?.id,
      status: 'accepted',
      endpointState: 'changed',
      endpoints: { step: 'ok', process: 'changed' },
    });
    expect(
      (await events(seq))
        .filter((e) => e.type.startsWith('placement.'))
        .map((e) => [e.type, e.subjectRef, e.principalId, e.clientId]),
    ).toEqual([
      ['placement.endpoint_changed', before?.id, await t.useCases.rulesPrincipal(), null],
    ]);

    expect((await putModel('finanzen/gutschrift', original('finanzen/gutschrift'))).outcome).toBe(
      'revised',
    );
    expect(await on('step-rechnungsstellung', GUTSCHRIFT)).toMatchObject({
      status: 'accepted',
      endpointState: 'ok',
    });
  });

  it('a deleted model turns its accepted placement missing; uploading it again makes it ok', async () => {
    const model = await store().read((tx) => tx.models.findByKey(project.id, 'logistik/shipping'));
    const del = await t.asOwner(`/api/v1/projects/${P}/models/${model?.id ?? ''}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(204);
    expect(await on('step-paketversand', SHIPPING)).toMatchObject({
      status: 'accepted',
      endpointState: 'missing',
      endpoints: { step: 'ok', process: 'missing' },
      processName: null,
    });
    expect((await putModel('logistik/shipping', original('logistik/shipping'))).outcome).toBe(
      'created',
    );
    expect(await on('step-paketversand', SHIPPING)).toMatchObject({
      status: 'accepted',
      endpointState: 'ok',
      processName: 'Parcel shipping',
    });
  });

  it('a rule proposal whose process loses the step’s name is withdrawn and comes back', async () => {
    const before = await on('step-wareneingang', WARENEINGANG);
    await putModel(
      'lager/wareneingang',
      edited(
        'lager/wareneingang',
        'id="Process_Wareneingang" name="Wareneingang"',
        'id="Process_Wareneingang" name="Warenannahme"',
      ),
    );
    expect(await on('step-wareneingang', WARENEINGANG)).toBeUndefined();
    expect(await on('step-wareneingang', WARENEINGANG, '&status=obsolete')).toMatchObject({
      id: before?.id,
    });
    await putModel('lager/wareneingang', original('lager/wareneingang'));
    expect(await on('step-wareneingang', WARENEINGANG)).toMatchObject({
      id: before?.id,
      status: 'proposed',
      tier: 'key',
      endpointState: 'ok',
    });
  });
});

describe('no-ops', () => {
  it('an unchanged re-import writes nothing', async () => {
    const before = await placements();
    const seq = await lastSeq();
    const outcomes = await importAll((path, init) => t.asOwner(path, init), P, files);
    expect(outcomes.every((o: ImportResult['files'][number]) => o.outcome === 'unchanged')).toBe(
      true,
    );
    expect(await lastSeq()).toBe(seq);
    expect(await placements()).toEqual(before);
  });

  it('a layout-only model revision moves no placement', async () => {
    const before = await placements();
    const seq = await lastSeq();
    const moved = await putModel(
      'finanzen/gutschrift',
      edited('finanzen/gutschrift', '<dc:Bounds x="200" y="142"', '<dc:Bounds x="210" y="142"'),
    );
    expect(moved.outcome).toBe('revised');
    expect((await events(seq)).filter((e) => e.type.startsWith('placement.'))).toEqual([]);
    expect(await placements()).toEqual(before);
    await putModel('finanzen/gutschrift', original('finanzen/gutschrift'));
  });

  it('a layout-only chain revision moves no placement', async () => {
    const before = await placements();
    const shifted = await shiftedGolden(20);
    const seq = await lastSeq();
    const saved = await json<SaveValueChainResult>(
      await t.asOwner(chainPath(P, '/content'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': `"r${rev}"` },
        body: JSON.stringify(shifted),
      }),
    );
    expect(saved).toMatchObject({ outcome: 'revised', impact: { structureChanged: false } });
    expect((await events(seq)).map((e) => e.type)).toEqual(['value_chain.revised']);
    expect(await placements()).toEqual(before);
  });
});

describe('the relation side', () => {
  it('stays exactly what eval:candidates computes', async () => {
    const { rules } = await libraryView(files);
    expect((await allRelations()).map(relationLine).sort()).toEqual(
      rules.relations.map(relationLine).sort(),
    );
    const { items } = await json<FindingList>(await t.asOwner(`/api/v1/projects/${P}/findings`));
    expect(items).toEqual(rules.findings satisfies Finding[]);
  });
});

describe('M4a: a placement proposed ad hoc over MCP', () => {
  it('is accepted over REST and survives an unchanged re-import and a layout-only re-save', async () => {
    const { secret } = await t.createToken(P, ['proa:read', 'proa:propose']);
    server = await listen(t.app.fetch);
    const client = new Client({ name: 'vc-ingest-agent', version: '0' });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${secret}` } },
      }),
    );
    await client.listTools();
    const proposed = await client.callTool({
      name: 'propose_placement',
      arguments: {
        projectId: P,
        procedure: { id: 'proa-placements', version: '0.1.0' },
        llmModel: 'vc-ingest-test',
        placements: [
          {
            step: 'step-auftragsabwicklung',
            process: ORDER_HANDLING,
            confidence: 0.85,
            rationale: 'Der Order-to-Cash-Hub wickelt Kundenaufträge ab.',
            evidence: [ORDER_HANDLING, 'step:step-auftragsabwicklung'],
          },
        ],
      },
    });
    expect(proposed.isError, JSON.stringify(proposed.content)).not.toBe(true);
    const [item] = (
      proposed.structuredContent as { items: { result: string; placementId: string }[] }
    ).items;
    expect(item?.result).toBe('applied');
    const id = item?.placementId ?? '';
    expect(await on('step-auftragsabwicklung', ORDER_HANDLING)).toMatchObject({
      id,
      status: 'proposed',
      tier: 'lexical',
      source: 'agent',
    });

    await json(
      await t.asOwner(chainPath(P, `/placements/${id}/decision`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'accept' }),
      }),
    );
    const accepted = await on('step-auftragsabwicklung', ORDER_HANDLING);
    expect(accepted).toMatchObject({ id, status: 'accepted', endpointState: 'ok' });

    // An unchanged re-import writes nothing.
    const seq = await lastSeq();
    const outcomes = await importAll((path, init) => t.asOwner(path, init), P, files);
    expect(outcomes.every((o) => o.outcome === 'unchanged')).toBe(true);
    expect(await lastSeq()).toBe(seq);

    // A layout-only re-save stores a revision and moves no placement.
    const head = await headRev();
    const saved = await json<SaveValueChainResult>(
      await t.asOwner(chainPath(P, '/content'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': `"r${head}"` },
        body: JSON.stringify(await shiftedGolden(40)),
      }),
    );
    expect(saved).toMatchObject({
      outcome: 'revised',
      valueChain: { headRev: head + 1 },
      impact: { structureChanged: false },
    });
    expect((await events(seq)).map((e) => e.type)).toEqual(['value_chain.revised']);
    expect(await on('step-auftragsabwicklung', ORDER_HANDLING)).toEqual(accepted);
    const { items: history } = await json<PlacementAssertionList>(
      await t.asOwner(chainPath(P, `/placements/${id}/assertions`)),
    );
    expect(history.map((a) => [a.kind, a.sourceKind])).toEqual([
      ['proposal', 'agent'],
      ['decision', 'human'],
    ]);
  });
});
