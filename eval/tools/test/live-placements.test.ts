// Tests for eval:live with placement tasks (M4b): the REST reader takes the
// chain revision's number and content hash from the revision listing, the
// command writes placement lines, scores them on the golden chain of the dev
// landscape, applies the placement live gate (exit 1 on a failing gate) and
// refuses a run on an edited chain. Dev landscape only (nordwind-handel).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  AnalysisSubmission,
  PlacementRecordingLine,
  type AnalysisTask,
  type ValueChainRevision,
} from '@proa/contracts';
import { getProcedure } from '@proa/procedures';

import { fetchStoredAnalyses, isStoredPlacement, placementLineOf } from '../src/live-recordings.ts';
import { runLive, type LiveIo } from '../src/live.ts';
import { loadPlacementRun } from '../src/placements-load.ts';
import { OUTSIDE } from '../src/placements-score.ts';

const LANDSCAPE = 'nordwind-handel';
const PROJECT = 'nw-place-1';
const TOKEN = `proa_at_${'t'.repeat(49)}`;
const TASK = 'ana_01JAKKKKKKKKKKKKKKKKKKKK31';
const CHAIN = 'vch_01JAKKKKKKKKKKKKKKKKKKKK01';
const REV1 = 'vcr_01JAKKKKKKKKKKKKKKKKKKKK01';
const REV2 = 'vcr_01JAKKKKKKKKKKKKKKKKKKKK02';
const procedure = getProcedure('proa-placements');

interface Placed {
  step: string;
  process: string;
  confidence: number;
}

/** A stored placement submission of `items` (all applied), declared like a live run. */
function submission(items: Placed[], handle = 'agent:claude-code-1'): AnalysisSubmission {
  assert.ok(procedure);
  const declared = { id: procedure.id, version: procedure.version };
  const sid = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
  return AnalysisSubmission.parse({
    id: 'sbm_01JAKKKKKKKKKKKKKKKKKKKK31',
    taskId: TASK,
    submissionId: sid,
    principalId: 'prn_01JAKKKKKKKKKKKKKKKKKKKK01',
    handle,
    clientId: 'agt_01JAKKKKKKKKKKKKKKKKKKKK01',
    procedure: declared,
    llmModel: 'claude-sonnet-5-5',
    // Over MCP: the arguments as parsed, defaults applied (relations and noLinks empty).
    payload: {
      submissionId: sid,
      procedure: declared,
      llmModel: 'claude-sonnet-5-5',
      relations: [],
      noLinks: [],
      placements: items.map((i) => ({ ...i, rationale: 'Begründung', evidence: [i.process], question: null })),
      unsure: [{ process: 'x/unbekannt#P', reason: 'Kein Schritt passt.' }],
      summary: 'Platziert.',
      costUsd: null,
    },
    result: {
      kind: 'placement',
      taskId: TASK,
      submissionId: sid,
      replayed: false,
      placements: {
        items: items.map((_, index) => ({
          index,
          result: 'applied',
          placementId: `plc_01JAKKKKKKKKKKKKKKKKKKK${String(100 + index).padStart(3, '0')}`,
          status: 'proposed',
        })),
        counts: { applied: items.length, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 },
      },
      unsure: { items: [{ index: 0, result: 'invalid:outside-task-input' }], counts: { stored: 0, duplicate: 0, invalid: 1 } },
      withdrawn: 0,
      skipped: { count: 0, processes: [] },
      followUp: false,
    },
    createdAt: '2026-10-09T10:00:00.000Z',
  });
}

function placementTask(revisionId: string): AnalysisTask {
  return {
    id: TASK,
    projectId: 'prj_01JAKKKKKKKKKKKKKKKKKKKK01',
    kind: 'placement',
    subjectKind: 'value_chain',
    modelId: null,
    modelKey: null,
    revisionId: null,
    valueChainId: CHAIN,
    valueChainKey: 'main',
    valueChainRevisionId: revisionId as AnalysisTask['valueChainRevisionId'],
    state: 'done',
    attempts: 1,
    factsHash: null,
    inputHash: 'b'.repeat(64),
    leaseUntil: '2026-10-09T10:15:00.000Z',
    claimedBy: 'agent:claude-code-1',
    lastError: null,
    submissionId: null,
    createdAt: '2026-10-09T09:00:00.000Z',
    updatedAt: '2026-10-09T10:00:00.000Z',
  };
}

function chainRevision(id: string, rev: number, contentHash: string): ValueChainRevision {
  return {
    id: id as ValueChainRevision['id'],
    rev,
    contentHash,
    structureHash: 'c'.repeat(64),
    schemaVersion: 1,
    baseRevisionId: null,
    principalId: 'prn_01JAKKKKKKKKKKKKKKKKKKKK09',
    handle: 'user:owner',
    seq: rev,
    createdAt: '2026-10-09T08:00:00.000Z',
  };
}

/** A ProA REST API with one done placement task of PROJECT on chain revision `revisionId`. */
function fakeServer(sub: AnalysisSubmission, revisionId: string, golden: string) {
  const seen: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    seen.push(`${url.pathname}${url.search}`);
    const base = `/api/v1/projects/${PROJECT}`;
    if (url.pathname === `${base}/analyses`) return Promise.resolve(json({ items: [placementTask(revisionId)], nextCursor: null }));
    if (url.pathname === `${base}/analyses/${TASK}/submission`) return Promise.resolve(json(sub));
    if (url.pathname === `${base}/value-chains/main/revisions`) {
      return Promise.resolve(
        json({ items: [chainRevision(REV2, 2, 'e'.repeat(64)), chainRevision(REV1, 1, golden)], nextCursor: null }),
      );
    }
    return Promise.resolve(json({ code: 'not-found', detail: url.pathname }, 404));
  };
  return { fetch, seen };
}

async function live(argv: string[], fetch: typeof globalThis.fetch, cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: LiveIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { PROA_TOKEN: TOKEN, PROA_URL: 'http://proa.test' },
    cwd,
    fetch,
  };
  const code = await runLive(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

test('eval:live records placement tasks, scores them on the golden chain and applies the placement live gate', async () => {
  assert.ok(procedure);
  const run = await loadPlacementRun(LANDSCAPE);
  const golden = run.golden.contentHash;
  // A perfect run: every process on its must (`@outside` included).
  const perfect = run.golden.placements.map((p) => ({ step: p.must, process: p.process, confidence: 0.9 }));
  assert.ok(perfect.some((p) => p.step === OUTSIDE));
  const server = fakeServer(submission(perfect), REV1, golden);

  // The reader: the chain revision the claim showed, by id in the listing.
  const stored = await fetchStoredAnalyses({ url: 'http://proa.test', token: TOKEN, project: PROJECT, fetch: server.fetch });
  assert.equal(stored.length, 1);
  const [one] = stored;
  assert.ok(one && isStoredPlacement(one));
  assert.deepEqual(one.valueChain, { key: 'main', rev: 1, contentHash: golden });
  assert.deepEqual(server.seen, [
    `/api/v1/projects/${PROJECT}/analyses?state=done&limit=200`,
    `/api/v1/projects/${PROJECT}/analyses/${TASK}/submission`,
    `/api/v1/projects/${PROJECT}/value-chains/main/revisions?limit=200`,
  ]);
  const line = placementLineOf(one, { landscape: LANDSCAPE });
  assert.deepEqual(PlacementRecordingLine.parse(line), line);
  assert.deepEqual(Object.keys(line), [
    'format', 'kind', 'landscape', 'valueChain', 'agent', 'procedure', 'llmModel', 'submission', 'outcome', 'result',
  ]);
  assert.deepEqual(line.result?.skipped, { count: 0 });
  assert.equal(line.submission.unsure.length, 1);

  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-live-placements-'));
  try {
    const first = await live(['--project', PROJECT, '--landscape', LANDSCAPE, '--out', 'rec'], server.fetch, dir);
    assert.equal(first.err, '');
    assert.equal(first.code, 0);
    const rel = `${procedure.id}@${procedure.version}/claude-code-1/claude-sonnet-5-5/${LANDSCAPE}.jsonl`;
    const text = await readFile(path.join(dir, 'rec', rel), 'utf8');
    assert.equal(text, `${JSON.stringify(line)}\n`);
    assert.match(first.out, /: 1 task, \d+ placements; precision 100\.0 %, recall 100\.0 %, recall@1 100\.0 % \(baseline-prefix\/1 43\.8 % with votes, 46\.9 % without\)/);
    assert.match(first.out, /placement live gate .* \(dev\): INCOMPLETE; 1 run, recall@1 100\.0 % \(bar 66\.9 %/);
    assert.match(first.out, / {2}- 1 of 3 runs\n/);
    // Two more runs: the gate passes.
    for (const agent of ['claude-code-2', 'claude-code-3']) {
      const more = await live(['--project', PROJECT, '--landscape', LANDSCAPE, '--out', 'rec', '--agent', agent], server.fetch, dir);
      assert.equal(more.code, 0, more.err);
    }
    const json = await live(['--project', PROJECT, '--landscape', LANDSCAPE, '--out', 'rec', '--json', '--no-write'], server.fetch, dir);
    assert.equal(json.code, 0, json.err);
    const report = JSON.parse(json.out) as {
      placementRuns: { file: string; numbers: { recallAt1: number } }[];
      placementGates: { status: string; runs: number; baseline: { bar: number } }[];
    };
    assert.deepEqual(report.placementRuns.map((r) => [r.file, r.numbers.recallAt1]), [[rel, 1]]);
    assert.deepEqual(report.placementGates.map((g) => [g.status, g.runs]), [['pass', 3]]);

    // A trap at confidence ≥ 0.8 fails the gate: exit 1.
    const trap = run.golden.placements.find((p) => p.mustNot.length > 0);
    assert.ok(trap);
    const trapped = perfect.map((p) => (p.process === trap.process ? { ...p, step: trap.mustNot[0] ?? '' } : p));
    const failing = fakeServer(submission(trapped, 'agent:claude-code-4'), REV1, golden);
    const fail = await live(['--project', PROJECT, '--landscape', LANDSCAPE, '--out', 'rec'], failing.fetch, dir);
    assert.equal(fail.code, 1);
    assert.match(fail.out, /placement live gate .*: FAIL; 4 runs/);
    assert.match(fail.out, / {2}- 1 must_not placement with confidence ≥ 0\.8 \(in 1 of 4 runs\)\n/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval:live refuses a placement run on an edited chain', async () => {
  const run = await loadPlacementRun(LANDSCAPE);
  const items = run.golden.placements.slice(0, 2).map((p) => ({ step: p.must, process: p.process, confidence: 0.9 }));
  const server = fakeServer(submission(items), REV2, run.golden.contentHash);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-live-placements-'));
  try {
    const r = await live(['--project', PROJECT, '--landscape', LANDSCAPE, '--out', 'rec'], server.fetch, dir);
    assert.equal(r.code, 1);
    assert.match(
      r.err,
      /project nw-place-1: 1 placement task worked on value chain r2, not the golden chain of nordwind-handel: not comparable \(edited chain\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
