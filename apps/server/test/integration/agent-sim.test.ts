/**
 * The simulation agent end to end (M2 item 8, M4b): both scored landscapes of
 * `eval/corpus` imported with the real libraries, then each landscape's golden
 * value chain created as `proa seed --value-chains` does (`PUT …/content` with
 * `If-None-Match: *`, the file loaded programmatically), an agent token each,
 * and `@proa/agent-sim` working the pipeline over MCP like any external
 * client, every task kind — `nordwind-handel` over Streamable HTTP (the
 * programmatic API), `stadtwerke-auental` through the `proa mcp` stdio bridge
 * (the `proa-agent-sim` command line, which spawns the bridge as a child
 * process).
 *
 * Requires: every task ends `done` with its stored submission; every agent
 * proposal carries the provenance of the token (principal, client) and the
 * declared procedure and model; nothing was decided (only the rule tier's
 * acceptances exist). The runs record in `--record-input summary
 * --no-record-ids` mode, and the files must equal the committed recordings
 * in `eval/recordings` (regenerate after an intended change with
 * `pnpm --filter @proa/server exec vitest run test/integration/agent-sim.test.ts -u`):
 * the relations recordings and the dev placement recording as file
 * snapshots; the holdout placement recording by sha256, line and byte counts
 * only, so no diff of it is ever printed (`-u` writes it). `eval:live`'s
 * reader, run against the same server afterwards, must build the recorder's
 * lines of both kinds from the stored submissions alone (all but the claim
 * input, which the server does not keep).
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SIM_POLICY,
  connect,
  createRecorder,
  runAgent,
  runSim,
  type AgentReport,
} from '@proa/agent-sim';
import {
  PlacementRecordingLine,
  RelationRecordingLine,
  recordingPath,
  type AnalysisSubmission,
  type AnalysisTaskPage,
  type CreatedAgentToken,
  type PlacementPage,
  type Relation,
  type RelationAssertionList,
  type RelationPage,
  type SaveValueChainResult,
  type ValueChainDetail,
} from '@proa/contracts';
import { buildRecordings, fetchStoredAnalyses, isStoredPlacement } from '@proa/eval-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { libraryAnalysis } from '../../src/analysis.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import {
  candidatesReport,
  corpusFiles,
  importAll,
  type CandidatesReport,
} from '../support/corpus.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { listen } from '../support/http.ts';
import { PLACEMENTS_PROCEDURE, RELATIONS_PROCEDURE } from '../support/pipeline.ts';
import { chainPath } from '../support/value-chain.ts';

const HTTP = 'nordwind-handel';
const STDIO = 'stadtwerke-auental';
const DRY = 'sample';
/** The holdout: its placement recording is compared by digest only. */
const HOLDOUT = STDIO;
/** The procedure the claims name, so the recordings move with every procedure release. */
const PROCEDURE = RELATIONS_PROCEDURE;
/** Relative to this file: `eval/recordings` (toMatchFileSnapshot resolves against the test file). */
const RECORDINGS = '../../../../eval/recordings';
/** `eval/value-chains`: each landscape's golden chain is read programmatically, never shown. */
const VALUE_CHAINS = new URL('../../../../eval/value-chains/', import.meta.url);

let database: TestDatabase;
let t: TestApp;
let server: { url: string; close: () => Promise<void> };
let recordDir: string;
let report: CandidatesReport;
const tokens: Record<string, CreatedAgentToken> = {};
const models: Record<string, number> = {};
const runs: Record<string, AgentReport> = {};
/** The golden chain's content hash per landscape (the server's `content_hash` of r1). */
const chains: Record<string, string> = {};

/** sha256, line and byte counts of a recording: all a test may print of the holdout's. */
function digest(text: string): { sha256: string; lines: number; bytes: number } {
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    lines: text.split('\n').filter((l) => l !== '').length,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}

async function owner<T>(urlPath: string): Promise<T> {
  const res = await t.asOwner(urlPath);
  if (res.status !== 200) throw new Error(`${urlPath}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function allRelations(project: string): Promise<Relation[]> {
  const out: Relation[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page: RelationPage = await owner<RelationPage>(
      `/api/v1/projects/${project}/relations?limit=200${query}`,
    );
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/** The principal behind an agent token (`principal.subject` is the token id). */
async function principalOf(tokenId: string): Promise<{ id: string; handle: string }> {
  const { rows } = await database.pool.query<{ id: string; handle: string }>(
    'SELECT id, handle FROM principal WHERE subject = $1',
    [tokenId],
  );
  expect(rows).toHaveLength(1);
  return rows[0] as { id: string; handle: string };
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { analysis: libraryAnalysis });
  report = await candidatesReport();
  for (const [project, landscape] of [
    [HTTP, HTTP],
    [STDIO, STDIO],
    [DRY, '_sample'],
  ] as const) {
    await t.createProject(project, project);
    const files = await corpusFiles(landscape);
    const outcomes = await importAll((p, init) => t.asOwner(p, init), project, files);
    expect(outcomes.every((o) => o.outcome === 'created')).toBe(true);
    models[project] = files.length;
    if (project !== DRY) {
      // As `proa seed --value-chains`: the golden chain after the import, without placements.
      const bytes = await readFile(new URL(`${project}/value-chain.vc.json`, VALUE_CHAINS));
      const saved = await t.asOwner(chainPath(project, '/content'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body: bytes,
      });
      expect(saved.status).toBe(201);
      const result = (await saved.json()) as SaveValueChainResult;
      expect(result.outcome).toBe('created');
      chains[project] = createHash('sha256').update(bytes).digest('hex');
    }
    const res = await t.asOwner(`/api/v1/projects/${project}/agent-tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'agent-sim', scopes: ['proa:read', 'proa:propose'] }),
    });
    expect(res.status).toBe(201);
    tokens[project] = (await res.json()) as CreatedAgentToken;
  }
  server = await listen(t.app.fetch);
  recordDir = await mkdtemp(path.join(os.tmpdir(), 'proa-agent-sim-'));
}, 180_000);

afterAll(async () => {
  await server?.close();
  await database?.drop();
  if (recordDir) await rm(recordDir, { recursive: true, force: true });
});

describe('the simulation agent over MCP', () => {
  it(`works ${HTTP} over Streamable HTTP until no task is left`, async () => {
    const session = await connect(
      { kind: 'http', url: server.url, token: tokens[HTTP]?.secret ?? '' },
      { name: 'proa-agent-sim', version: '0.0.0' },
    );
    try {
      runs[HTTP] = await runAgent(session, {
        recorder: createRecorder({ dir: recordDir, input: 'summary', ids: false }),
      });
    } finally {
      await session.close();
    }
    const run = runs[HTTP];
    expect(run.procedure).toEqual(PROCEDURE);
    expect(run.procedures).toEqual({ relations: PROCEDURE, placement: PLACEMENTS_PROCEDURE });
    expect(run.prompt).toBe(true);
    expect(run.stop).toBe('no-work');
    const relations = run.byKind.relations;
    expect(relations).toMatchObject({ tasks: models[HTTP], submitted: models[HTTP], failed: 0 });
    expect(relations.outcomes.invalid).toBe(0);
    expect(relations.proposed).toBeGreaterThan(0);
    expect(relations.questions).toBeGreaterThan(0);
    // One placement task: the chain's processes fit one claim; judged once, nothing left.
    const placement = run.byKind.placement;
    expect(placement).toMatchObject({
      tasks: 1,
      submitted: 1,
      failed: 0,
      skipped: 0,
      followUps: 0,
    });
    expect(placement.outcomes.invalid).toBe(0);
    expect(placement.proposed).toBeGreaterThan(0);
    // The relations tasks come first (queued at the import, before the chain).
    expect(run.tasks.map((x) => x.kind)).toEqual([
      ...Array<string>(models[HTTP] ?? 0).fill('relations'),
      'placement',
    ]);
  }, 120_000);

  it(`works ${STDIO} through the proa mcp stdio bridge (proa-agent-sim --stdio)`, async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSim(
      [
        '--url',
        server.url,
        '--stdio',
        '--project',
        STDIO,
        '--record',
        recordDir,
        '--record-input',
        'summary',
        '--no-record-ids',
        '--json',
      ],
      {
        stdout: (s) => out.push(s),
        stderr: (s) => err.push(s),
        env: { PROA_TOKEN: tokens[STDIO]?.secret ?? '' },
        cwd: recordDir,
      },
    );
    expect(code, err.join('')).toBe(0);
    runs[STDIO] = JSON.parse(out.join('')) as AgentReport;
    const run = runs[STDIO];
    expect(run.procedure).toEqual(PROCEDURE);
    expect(run.stop).toBe('no-work');
    expect(run.byKind.relations).toMatchObject({
      tasks: models[STDIO],
      submitted: models[STDIO],
      failed: 0,
    });
    expect(run.byKind.relations.outcomes.invalid).toBe(0);
    // Counts only: the holdout.
    expect(run.byKind.placement).toMatchObject({ tasks: 1, submitted: 1, failed: 0, followUps: 0 });
    expect(run.byKind.placement.outcomes.invalid).toBe(0);
    // The per-task log came through stderr; the bridge announced itself there too.
    expect(err.join('')).toMatch(
      /bridge: proa mcp: bridging stdio to http:\/\/127\.0\.0\.1:\d+\/mcp/,
    );
    expect(err.join('')).toMatch(/stadtwerke-auental \S+ \(ana_\w+, attempt 1\): \d+ proposed/);
  }, 120_000);

  for (const project of [HTTP, STDIO]) {
    it(`${project}: every task ends done with its stored submission`, async () => {
      const page = await owner<AnalysisTaskPage>(
        `/api/v1/projects/${project}/analyses?kind=relations&limit=200`,
      );
      expect(page.items).toHaveLength(models[project] ?? -1);
      expect(page.items.filter((x) => x.state !== 'done')).toEqual([]);
      const token = tokens[project];
      for (const task of page.items) {
        expect(task.attempts).toBe(1);
        expect(task.claimedBy).toBe('agent:agent-sim');
        const sub = await owner<AnalysisSubmission>(
          `/api/v1/projects/${project}/analyses/${task.id}/submission`,
        );
        expect(sub).toMatchObject({
          submissionId: task.submissionId,
          handle: 'agent:agent-sim',
          clientId: token?.id,
          procedure: PROCEDURE,
          llmModel: SIM_POLICY,
        });
        expect(sub.payload).not.toHaveProperty('leaseToken');
        expect('counts' in sub.result && sub.result.counts.invalid).toBe(0);
      }
      // Every model is out of the agent's stages.
      const stages = await owner<{ items: { stage: string }[] }>(
        `/api/v1/projects/${project}/models?limit=200`,
      );
      expect(stages.items.filter((m) => m.stage.startsWith('waiting_for_agent'))).toEqual([]);
      expect(stages.items.filter((m) => m.stage === 'agent_working')).toEqual([]);
    });

    it(`${project}: the placement task ends done; the agent proposed, nothing was decided`, async () => {
      const page = await owner<AnalysisTaskPage>(
        `/api/v1/projects/${project}/analyses?kind=placement&limit=200`,
      );
      expect(page.items.map((x) => [x.state, x.attempts, x.claimedBy])).toEqual([
        ['done', 1, 'agent:agent-sim'],
      ]);
      const [task] = page.items;
      const sub = await owner<AnalysisSubmission>(
        `/api/v1/projects/${project}/analyses/${task?.id}/submission`,
      );
      expect(sub).toMatchObject({
        handle: 'agent:agent-sim',
        clientId: tokens[project]?.id,
        procedure: PLACEMENTS_PROCEDURE,
        llmModel: SIM_POLICY,
        result: { kind: 'placement', followUp: false, skipped: { count: 0 } },
      });
      expect(sub.payload).not.toHaveProperty('leaseToken');
      // The stage: waiting for review, nothing due (judge each process once).
      const detail = await owner<ValueChainDetail>(chainPath(project));
      expect(detail.pipeline).toMatchObject({ stage: 'waiting_for_review', due: 0 });
      expect(detail.pipeline.task?.state).toBe('done');
      expect(detail.valueChain.contentHash).toBe(chains[project]);
      // Agent proposals with the token's provenance; decisions only by nobody but the rule tier's proposals.
      const placements = await owner<PlacementPage>(chainPath(project, '/placements?limit=200'));
      const byAgent = placements.items.filter((p) => p.provenance?.sourceKind === 'agent');
      expect(byAgent.length).toBeGreaterThan(0);
      expect(byAgent.every((p) => p.status === 'proposed')).toBe(true);
      expect(
        byAgent.every(
          (p) =>
            p.provenance?.handle === 'agent:agent-sim' &&
            p.provenance.clientId === tokens[project]?.id &&
            p.provenance.llmModel === SIM_POLICY,
        ),
      ).toBe(true);
      expect(placements.items.filter((p) => p.status !== 'proposed').length).toBe(0);
      const { rows } = await database.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM placement_assertion a JOIN project p ON p.id = a.project_id
          WHERE p.key = $1 AND a.kind <> 'proposal'`,
        [project],
      );
      expect(rows[0]?.n).toBe('0');
    });

    it(`${project}: agent proposals carry provenance: principal, client, declared procedure and model`, async () => {
      const token = tokens[project];
      const principal = await principalOf(token?.id ?? '');
      expect(principal.handle).toBe('agent:agent-sim');
      const relations = await allRelations(project);
      const byAgent = relations.filter((r) => r.source === 'agent');
      expect(byAgent.length).toBeGreaterThan(10);
      for (const r of byAgent) {
        expect(r.status, `${r.from} -> ${r.to}`).toBe('proposed');
        expect(r.provenance).toMatchObject({
          kind: 'proposal',
          sourceKind: 'agent',
          principalId: principal.id,
          handle: 'agent:agent-sim',
          clientId: token?.id,
          procedure: PROCEDURE,
          llmModel: SIM_POLICY,
        });
        expect(r.provenance?.rationale).toBeTruthy();
      }
      // The timeline of one questioned proposal: rule or agent proposals, the agent's from a submission.
      const asked = byAgent.find((r) => r.provenance?.question);
      expect(asked).toBeDefined();
      const timeline = await owner<RelationAssertionList>(
        `/api/v1/projects/${project}/relations/${asked?.id}/assertions`,
      );
      const mine = timeline.items.filter((a) => a.principalId === principal.id);
      expect(mine.length).toBeGreaterThan(0);
      for (const a of mine) {
        expect(a).toMatchObject({ kind: 'proposal', sourceKind: 'agent', clientId: token?.id });
        expect(a.submissionId).toMatch(/^sbm_/);
        expect(a.evidence).toEqual([asked?.from, asked?.to]);
      }
      // In the database: every agent assertion of this project is the token's, with its declaration.
      const { rows } = await database.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM relation_assertion a JOIN project p ON p.id = a.project_id
          WHERE p.key = $1 AND a.source_kind = 'agent'
            AND NOT (a.principal_id = $2 AND a.client_id = $3 AND a.submission_id IS NOT NULL
                     AND a.declared = $4::jsonb)`,
        [
          project,
          principal.id,
          token?.id,
          JSON.stringify({ procedure: PROCEDURE, llmModel: SIM_POLICY }),
        ],
      );
      expect(rows[0]?.n).toBe('0');
    });

    it(`${project}: nothing was decided; the rule tier's acceptances are the only ones`, async () => {
      const relations = await allRelations(project);
      const counts: Record<string, number> = {};
      for (const r of relations) counts[r.status] = (counts[r.status] ?? 0) + 1;
      const expected = report.landscapes.find((l) => l.name === project);
      expect(counts['accepted']).toBe(expected?.counts.rules.accepted);
      expect(counts['rejected'] ?? 0).toBe(0);
      expect(counts['held'] ?? 0).toBe(0);
      for (const r of relations.filter((x) => x.status === 'accepted')) {
        expect(r.provenance).toMatchObject({ kind: 'decision', sourceKind: 'rule' });
      }
      const { rows } = await database.pool.query<{ kind: string; source_kind: string; n: string }>(
        `SELECT a.kind, a.source_kind, count(*) AS n FROM relation_assertion a
           JOIN project p ON p.id = a.project_id
          WHERE p.key = $1 AND a.kind <> 'proposal'
          GROUP BY a.kind, a.source_kind ORDER BY a.kind, a.source_kind`,
        [project],
      );
      expect(rows.map((r) => [r.kind, r.source_kind])).toEqual([['decision', 'rule']]);
      const events = await database.pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM event e JOIN project p ON p.id = e.project_id
          WHERE p.key = $1 AND e.type = 'relation.decided' AND e.principal_id = $2`,
        [project, (await principalOf(tokens[project]?.id ?? '')).id],
      );
      expect(events.rows[0]?.n).toBe('0');
    });

    it(`${project}: the recording equals eval/recordings (reproducible)`, async () => {
      const rel = recordingPath({
        procedure: PROCEDURE,
        agent: 'agent-sim',
        llmModel: SIM_POLICY,
        landscape: project,
      });
      const text = await readFile(path.join(recordDir, rel), 'utf8');
      const lines = text
        .trimEnd()
        .split('\n')
        .map((l) => RelationRecordingLine.parse(JSON.parse(l)));
      expect(lines).toHaveLength(models[project] ?? -1);
      expect(new Set(lines.map((l) => l.modelKey)).size).toBe(models[project]);
      expect(lines.every((l) => l.outcome === 'submitted' && l.task === undefined)).toBe(true);
      // The claim input stays below 100 KB with the judgements of earlier tasks (judge each pair once).
      for (const l of lines) {
        expect(l.input && 'bytes' in l.input ? l.input.bytes : null, l.modelKey).toBeLessThan(
          100 * 1024,
        );
      }
      await expect(text).toMatchFileSnapshot(`${RECORDINGS}/${rel}`);
    });

    it(`${project}: the placement recording equals eval/recordings (reproducible)`, async () => {
      const rel = recordingPath({
        procedure: PLACEMENTS_PROCEDURE,
        agent: 'agent-sim',
        llmModel: SIM_POLICY,
        landscape: project,
      });
      const text = await readFile(path.join(recordDir, rel), 'utf8');
      const lines = text
        .trimEnd()
        .split('\n')
        .map((l) => PlacementRecordingLine.parse(JSON.parse(l)));
      expect(lines).toHaveLength(1);
      for (const l of lines) {
        expect(l).toMatchObject({ kind: 'placement', outcome: 'submitted', landscape: project });
        expect(l.task).toBeUndefined();
        // Worked on the golden chain, so eval:replay can score it.
        expect(l.valueChain).toEqual({ key: 'main', rev: 1, contentHash: chains[project] });
        // Every recorded placement claim input stays below 100 KB.
        expect(l.input && 'bytes' in l.input ? l.input.bytes : null).toBeLessThan(100 * 1024);
        expect(l.input).toMatchObject({ summary: true, truncated: false });
      }
      const committed = fileURLToPath(new URL(`${RECORDINGS}/${rel}`, import.meta.url));
      if (project !== HOLDOUT) {
        await expect(text).toMatchFileSnapshot(`${RECORDINGS}/${rel}`);
        return;
      }
      // The holdout: digests only, never a diff; `-u` (or a missing file locally) writes it.
      const before = await readFile(committed, 'utf8').catch(() => null);
      if (before === text) return;
      const mode = expect.getState().snapshotState.snapshotUpdateState;
      if (mode === 'all' || (before === null && mode === 'new')) {
        await mkdir(path.dirname(committed), { recursive: true });
        await writeFile(committed, text);
        return;
      }
      expect(
        digest(text),
        `the holdout placement recording ${rel} differs (no diff shown); regenerate with -u`,
      ).toEqual(before === null ? null : digest(before));
    });

    it(`${project}: eval:live builds the recorder's lines from the stored submissions (input aside)`, async () => {
      // As eval:live reads a live run: over REST with the run's agent token.
      const stored = await fetchStoredAnalyses({
        url: server.url,
        token: tokens[project]?.secret ?? '',
        project,
      });
      expect(stored.filter((x) => !isStoredPlacement(x))).toHaveLength(models[project] ?? -1);
      expect(stored.filter(isStoredPlacement)).toHaveLength(1);
      const built = buildRecordings(stored, { landscape: project });
      // One file per kind, at the recorder's paths (agent from the token name, declared procedure and model).
      expect(built.map((b) => b.path)).toEqual([
        recordingPath({
          procedure: PLACEMENTS_PROCEDURE,
          agent: 'agent-sim',
          llmModel: SIM_POLICY,
          landscape: project,
        }),
        recordingPath({
          procedure: PROCEDURE,
          agent: 'agent-sim',
          llmModel: SIM_POLICY,
          landscape: project,
        }),
      ]);
      const [placements, live] = built;
      // The placement lines, byte for byte without the input (compared without printing the holdout's).
      const recordedPlacements = (
        await readFile(path.join(recordDir, placements?.path ?? ''), 'utf8')
      )
        .trimEnd()
        .split('\n')
        .map((l) => {
          const { input, ...line } = JSON.parse(l) as PlacementRecordingLine;
          expect(input).toBeDefined();
          return `${JSON.stringify(line)}\n`;
        })
        .join('');
      for (const line of placements?.lines ?? []) PlacementRecordingLine.parse(line);
      expect(digest(placements?.text ?? '')).toEqual(digest(recordedPlacements));
      const recorded = (await readFile(path.join(recordDir, live?.path ?? ''), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((l) => {
          const { input, ...line } = JSON.parse(l) as RelationRecordingLine;
          expect(input).toBeDefined();
          return line;
        })
        .sort((a, b) => (a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0));
      expect(live?.lines).toEqual(recorded);
      // Byte for byte, in the recorder's key order.
      expect(live?.text).toBe(recorded.map((l) => `${JSON.stringify(l)}\n`).join(''));
      for (const line of live?.lines ?? []) RelationRecordingLine.parse(line);
    });
  }

  it('dry run: decides and records, then hands every task back unsubmitted', async () => {
    const session = await connect(
      { kind: 'http', url: server.url, token: tokens[DRY]?.secret ?? '' },
      { name: 'proa-agent-sim', version: '0.0.0' },
    );
    let run: AgentReport;
    try {
      run = await runAgent(session, { dryRun: true });
    } finally {
      await session.close();
    }
    expect(run.tasks.map((x) => x.outcome)).toEqual(Array(models[DRY]).fill('dry-run'));
    const page = await owner<AnalysisTaskPage>(`/api/v1/projects/${DRY}/analyses?limit=200`);
    expect(page.items.map((x) => [x.state, x.attempts])).toEqual(
      Array(models[DRY]).fill(['queued', 0]),
    );
    expect(page.items.every((x) => x.lastError === 'agent-sim dry run')).toBe(true);
    expect((await allRelations(DRY)).filter((r) => r.source === 'agent')).toEqual([]);
  });
});
