/**
 * The simulation agent end to end (M2 item 8): both scored landscapes of
 * `eval/corpus` imported with the real libraries, an agent token each, and
 * `@proa/agent-sim` working the pipeline over MCP like any external client —
 * `nordwind-handel` over Streamable HTTP (the programmatic API),
 * `stadtwerke-auental` through the `proa mcp` stdio bridge (the
 * `proa-agent-sim` command line, which spawns the bridge as a child process).
 *
 * Requires: every task ends `done` with its stored submission; every agent
 * proposal carries the provenance of the token (principal, client) and the
 * declared procedure and model; nothing was decided (only the rule tier's
 * acceptances exist). The runs record in `--record-input summary
 * --no-record-ids` mode, and the files must equal the committed recordings
 * in `eval/recordings` (regenerate after an intended change with
 * `pnpm --filter @proa/server exec vitest run test/integration/agent-sim.test.ts -u`).
 * `eval:live`'s reader, run against the same server afterwards, must build
 * the recorder's lines from the stored submissions alone (all but the claim
 * input, which the server does not keep).
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SIM_POLICY,
  connect,
  createRecorder,
  runAgent,
  runSim,
  type AgentReport,
} from '@proa/agent-sim';
import {
  RecordingLine,
  recordingPath,
  type AnalysisSubmission,
  type AnalysisTaskPage,
  type CreatedAgentToken,
  type Relation,
  type RelationAssertionList,
  type RelationPage,
} from '@proa/contracts';
import { buildRecordings, fetchStoredAnalyses } from '@proa/eval-tools';
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

const HTTP = 'nordwind-handel';
const STDIO = 'stadtwerke-auental';
const DRY = 'sample';
const PROCEDURE = { id: 'proa-relations', version: '0.0.1' };
/** Relative to this file: `eval/recordings` (toMatchFileSnapshot resolves against the test file). */
const RECORDINGS = '../../../../eval/recordings';

let database: TestDatabase;
let t: TestApp;
let server: { url: string; close: () => Promise<void> };
let recordDir: string;
let report: CandidatesReport;
const tokens: Record<string, CreatedAgentToken> = {};
const models: Record<string, number> = {};
const runs: Record<string, AgentReport> = {};

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
    expect(run.prompt).toBe(true);
    expect(run.stop).toBe('no-work');
    expect(run.totals).toMatchObject({ tasks: models[HTTP], submitted: models[HTTP], failed: 0 });
    expect(run.totals.outcomes.invalid).toBe(0);
    expect(run.totals.proposed).toBeGreaterThan(0);
    expect(run.totals.questions).toBeGreaterThan(0);
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
    expect(run.totals).toMatchObject({ tasks: models[STDIO], submitted: models[STDIO], failed: 0 });
    expect(run.totals.outcomes.invalid).toBe(0);
    // The per-task log came through stderr; the bridge announced itself there too.
    expect(err.join('')).toMatch(
      /bridge: proa mcp: bridging stdio to http:\/\/127\.0\.0\.1:\d+\/mcp/,
    );
    expect(err.join('')).toMatch(/stadtwerke-auental \S+ \(ana_\w+, attempt 1\): \d+ proposed/);
  }, 120_000);

  for (const project of [HTTP, STDIO]) {
    it(`${project}: every task ends done with its stored submission`, async () => {
      const page = await owner<AnalysisTaskPage>(`/api/v1/projects/${project}/analyses?limit=200`);
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
        expect(sub.result.counts.invalid).toBe(0);
      }
      // Every model is out of the agent's stages.
      const stages = await owner<{ items: { stage: string }[] }>(
        `/api/v1/projects/${project}/models?limit=200`,
      );
      expect(stages.items.filter((m) => m.stage.startsWith('waiting_for_agent'))).toEqual([]);
      expect(stages.items.filter((m) => m.stage === 'agent_working')).toEqual([]);
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
        .map((l) => RecordingLine.parse(JSON.parse(l)));
      expect(lines).toHaveLength(models[project] ?? -1);
      expect(new Set(lines.map((l) => l.modelKey)).size).toBe(models[project]);
      expect(lines.every((l) => l.outcome === 'submitted' && l.task === undefined)).toBe(true);
      await expect(text).toMatchFileSnapshot(`${RECORDINGS}/${rel}`);
    });

    it(`${project}: eval:live builds the recorder's lines from the stored submissions (input aside)`, async () => {
      // As eval:live reads a live run: over REST with the run's agent token.
      const stored = await fetchStoredAnalyses({
        url: server.url,
        token: tokens[project]?.secret ?? '',
        project,
      });
      expect(stored).toHaveLength(models[project] ?? -1);
      const built = buildRecordings(stored, { landscape: project });
      // One file, at the recorder's path (agent from the token name, declared procedure and model).
      expect(built).toHaveLength(1);
      const [live] = built;
      const recorded = (await readFile(path.join(recordDir, live?.path ?? ''), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((l) => {
          const { input, ...line } = JSON.parse(l) as RecordingLine;
          expect(input).toBeDefined();
          return line;
        })
        .sort((a, b) => (a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0));
      expect(live?.lines).toEqual(recorded);
      // Byte for byte, in the recorder's key order.
      expect(live?.text).toBe(recorded.map((l) => `${JSON.stringify(l)}\n`).join(''));
      for (const line of live?.lines ?? []) RecordingLine.parse(line);
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
