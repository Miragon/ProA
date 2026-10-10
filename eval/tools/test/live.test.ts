// Tests for eval:live (src/live-recordings.ts, src/live.ts): the mapping of
// stored submissions to recording lines (fixtures under fixtures/live: a raw
// REST payload and an MCP payload with defaults applied), the REST reader
// against a fake server, and the command end to end on the `_sample`
// landscape: the gate per declared model, the warnings (several tokens,
// several files, a replaced file) and the exit codes (1 for a failing gate or
// a runtime error, 2 for a usage error, analyses of models the landscape does
// not have among them).
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { AnalysisSubmission, recordingPath, type AnalysisTask, type Revision } from '@proa/contracts';
import { getProcedure } from '@proa/procedures';

import {
  LiveSourceError,
  agentOf,
  buildRecordings,
  fetchStoredAnalyses,
  isStoredPlacement,
  recordingLineOf,
  type StoredAnalysis,
} from '../src/live-recordings.ts';
import { runLive, type LiveIo } from '../src/live.ts';
import { parseRecording } from '../src/recordings.ts';

const FIXTURES = new URL('./fixtures/live/', import.meta.url);
const A = 'vertrieb/auftragsabwicklung';
const R = 'finanzen/rechnungsstellung';
const P = 'finance/payment-collection';
const PROJECT = 'sample-run-1';
const TOKEN = `proa_at_${'t'.repeat(49)}`;

async function fixture(name: string): Promise<AnalysisSubmission> {
  return AnalysisSubmission.parse(JSON.parse(await readFile(new URL(name, FIXTURES), 'utf8')));
}

/** The REST fixture (model A, revision 2) and the MCP fixture (model P, revision 1). */
async function storedRun(): Promise<StoredAnalysis[]> {
  return [
    { modelKey: A, rev: 2, submission: await fixture('submission-rest.json') },
    { modelKey: P, rev: 1, submission: await fixture('submission-mcp.json') },
  ];
}

/** Every stored submission of `stored` declaring `version` of its procedure. */
function declaring(stored: StoredAnalysis[], version: string): StoredAnalysis[] {
  return stored.map((s) => {
    const procedure = { ...s.submission.procedure, version };
    return { ...s, submission: { ...s.submission, procedure, payload: { ...s.submission.payload, procedure } } };
  });
}

/** The stored submission declaring `llmModel` instead. */
function withModel(s: StoredAnalysis, llmModel: string): StoredAnalysis {
  return { ...s, submission: { ...s.submission, llmModel, payload: { ...s.submission.payload, llmModel } } };
}

test('maps a raw REST payload: defaults filled in, result without ids, no input', async () => {
  const [rest] = await storedRun();
  assert.ok(rest);
  const line = recordingLineOf(rest, { landscape: 'sample' });
  assert.deepEqual(line, {
    format: 'proa-recording/1',
    landscape: 'sample',
    modelKey: A,
    rev: 2,
    agent: 'claude-desktop-1',
    procedure: { id: 'proa-relations', version: '0.0.0' },
    llmModel: 'claude-opus-5-5',
    submission: {
      relations: [
        {
          type: 'message',
          from: `${A}#Event_WareVersandbereit`,
          to: `${R}#Start_WareVersandbereit`,
          confidence: 0.97,
          rationale: '',
          evidence: [],
          question: null,
        },
        {
          type: 'message',
          from: `${A}#End_WareVersandbereit`,
          to: `${R}#Start_WareVersandbereit`,
          confidence: 0.6,
          rationale: '',
          evidence: [],
          question: 'Ist das Ende „Ware versandbereit“ ein Sender?',
        },
        {
          type: 'manual',
          from: `${A}#Task_AbsageSenden`,
          to: `${P}#Event_PaymentReceived`,
          confidence: 0.5,
          rationale: '',
          evidence: [],
          question: null,
        },
      ],
      noLinks: [],
      summary: null,
      costUsd: null,
    },
    outcome: 'submitted',
    result: {
      replayed: false,
      counts: { applied: 2, duplicate: 0, suppressed: 0, reopened: 0, invalid: 1 },
      withdrawn: 0,
      items: [
        { index: 0, result: 'applied', status: 'proposed' },
        { index: 1, result: 'applied', status: 'proposed' },
        { index: 2, result: 'invalid:type-not-allowed', status: null },
      ],
    },
  });
  // The recorder's key order, so a file reads like one agent-sim writes (minus the input).
  assert.deepEqual(Object.keys(line), [
    'format', 'landscape', 'modelKey', 'rev', 'agent', 'procedure', 'llmModel', 'submission', 'outcome', 'result',
  ]);
  assert.deepEqual(Object.keys(line.result?.counts ?? {}), ['applied', 'duplicate', 'suppressed', 'reopened', 'invalid']);
  assert.equal(recordingPath(line), 'proa-relations@0.0.0/claude-desktop-1/claude-opus-5-5/sample.jsonl');
});

test('maps an MCP payload (defaults applied) verbatim, U+FFFD included', async () => {
  const [, mcp] = await storedRun();
  assert.ok(mcp);
  const line = recordingLineOf(mcp, { landscape: 'sample' });
  const payload = mcp.submission.payload;
  assert.deepEqual(line.submission.relations, payload['relations']);
  assert.deepEqual(line.submission.noLinks, payload['noLinks']);
  assert.equal(line.submission.relations[0]?.rationale, 'Gleiches Signal�RechnungsstellungAbgeschlossen');
  assert.equal(line.submission.noLinks[0]?.reason, 'Absage ist keine Zahlung�');
  assert.equal(line.submission.summary, 'Zwei Links, eine Absage.');
  assert.equal(line.submission.costUsd, 0.12);
  assert.deepEqual(line.result, {
    replayed: false,
    counts: { applied: 1, duplicate: 1, suppressed: 0, reopened: 0, invalid: 0 },
    withdrawn: 1,
    items: [
      { index: 0, result: 'applied', status: 'proposed' },
      { index: 1, result: 'duplicate', status: 'proposed' },
    ],
  });
  assert.equal(line.input, undefined);
  assert.equal(line.task, undefined);
});

test('maps typed no-links and the no-link outcomes, withdrawn no-links and the uncovered count in the recorder\'s key order', async () => {
  const [, mcp] = await storedRun();
  assert.ok(mcp);
  const noLinks = (mcp.submission.payload['noLinks'] as Array<Record<string, unknown>>).map((n) => ({ ...n, type: 'message' }));
  const pair = { type: 'signal', from: `${R}#End_RechnungsstellungAbgeschlossen`, to: `${P}#Start_InvoicingCompleted` } as const;
  const stored: StoredAnalysis = {
    ...mcp,
    submission: {
      ...mcp.submission,
      payload: { ...mcp.submission.payload, noLinks },
      result: {
        // The stored result's keys in another order than a recording has them.
        uncovered: { pairs: [{ to: pair.to, type: pair.type, from: pair.from }], count: 4 },
        withdrawnNoLinks: 2,
        noLinks: { counts: { invalid: 0, duplicate: 0, stored: 1 }, items: [{ result: 'stored', index: 0 }] },
        ...mcp.submission.result,
      },
    },
  };
  const line = recordingLineOf(stored, { landscape: 'sample' });
  assert.deepEqual(line.submission.noLinks, [
    { type: 'message', from: `${A}#Task_AbsageSenden`, to: `${P}#Event_PaymentReceived`, reason: 'Absage ist keine Zahlung�' },
  ]);
  assert.deepEqual(Object.keys(line.submission.noLinks[0] ?? {}), ['type', 'from', 'to', 'reason']);
  assert.equal(
    JSON.stringify(line.result),
    JSON.stringify({
      replayed: false,
      counts: { applied: 1, duplicate: 1, suppressed: 0, reopened: 0, invalid: 0 },
      withdrawn: 1,
      items: [
        { index: 0, result: 'applied', status: 'proposed' },
        { index: 1, result: 'duplicate', status: 'proposed' },
      ],
      noLinks: { items: [{ index: 0, result: 'stored' }], counts: { stored: 1, duplicate: 0, invalid: 0 } },
      withdrawnNoLinks: 2,
      // The count only, like the recorder: the pairs would bloat the recordings.
      uncovered: { count: 4 },
    }),
  );
  // An untyped no-link (before proa-relations@0.2.0) stays untyped.
  assert.deepEqual(Object.keys(recordingLineOf(mcp, { landscape: 'sample' }).submission.noLinks[0] ?? {}), ['from', 'to', 'reason']);
});

test('takes the agent from the handle agent:<token name>, unless --agent names one', async () => {
  assert.equal(agentOf('agent:claude-desktop-1'), 'claude-desktop-1');
  assert.equal(agentOf('agent:claude code'), 'claude code');
  assert.equal(agentOf('owner'), 'owner');
  const [rest] = await storedRun();
  assert.ok(rest);
  assert.equal(recordingLineOf(rest, { landscape: 'sample', agent: 'claude-desktop-2' }).agent, 'claude-desktop-2');

  // Token and model names at their limits (100 characters), with characters a path segment cannot hold.
  const tokenName = `Claude Desktop / Run ${'x'.repeat(79)}`;
  const llmModel = `claude opus ${'5'.repeat(88)}`;
  assert.equal(tokenName.length, 100);
  assert.equal(llmModel.length, 100);
  const long: StoredAnalysis = { ...rest, submission: { ...rest.submission, handle: `agent:${tokenName}`, llmModel } };
  const line = recordingLineOf(long, { landscape: 'sample' });
  assert.equal(line.agent, tokenName);
  assert.equal(line.llmModel, llmModel);
  const [built] = buildRecordings([long], { landscape: 'sample' });
  assert.ok(built);
  assert.equal(built.path, `proa-relations@0.0.0/Claude-Desktop-Run-${'x'.repeat(79)}/claude-opus-${'5'.repeat(88)}/sample.jsonl`);
  assert.equal(parseRecording(built.path, built.text).agent, `Claude-Desktop-Run-${'x'.repeat(79)}`);
});

test('builds one file per procedure, agent and model, lines sorted by model key and submission time', async () => {
  const [rest, mcp] = await storedRun();
  assert.ok(rest && mcp);
  // A requeued model (two submissions, newest listed first) and a submission that declared no model.
  const again: StoredAnalysis = {
    ...rest,
    submission: { ...rest.submission, taskId: 'ana_01JAKKKKKKKKKKKKKKKKKKKK09', createdAt: '2026-10-08T11:00:00.000Z' },
  };
  const { llmModel: _model, ...payload } = mcp.submission.payload;
  const unnamed: StoredAnalysis = { ...mcp, submission: { ...mcp.submission, llmModel: null, payload } };
  const built = buildRecordings([unnamed, again, mcp, rest], { landscape: 'sample' });
  assert.deepEqual(
    built.map((b) => [b.path, b.lines.map((l) => `${l.modelKey} ${l.rev}`)]),
    [
      ['proa-relations@0.0.0/claude-desktop-1/claude-opus-5-5/sample.jsonl', [`${P} 1`, `${A} 2`, `${A} 2`]],
      ['proa-relations@0.0.0/claude-desktop-1/none/sample.jsonl', [`${P} 1`]],
    ],
  );
  // `finance/…` sorts before `vertrieb/…`; the requeued model's earlier submission comes first.
  const first = built[0];
  assert.ok(first);
  assert.equal(first.lines[1]?.submission.relations.length, 3);
  assert.equal(first.text, first.lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  for (const b of built) assert.equal(parseRecording(b.path, b.text).lines.length, b.lines.length);
  // The same input builds the same bytes.
  assert.deepEqual(buildRecordings([rest, mcp, again, unnamed], { landscape: 'sample' }), built);
});

test('refuses a stored payload that is no submission, and a landscape that is no project key', async () => {
  const [rest] = await storedRun();
  assert.ok(rest);
  const broken = { ...rest.submission.payload, relations: 'none' };
  assert.throws(
    () => recordingLineOf({ ...rest, submission: { ...rest.submission, payload: broken } }, { landscape: 'sample' }),
    (err: unknown) =>
      err instanceof LiveSourceError &&
      /task ana_01JAKKKKKKKKKKKKKKKKKKKK01: the stored payload is no submission \(relations: /.test(err.message),
  );
  const { procedure: _procedure, ...undeclared } = rest.submission.payload;
  assert.throws(
    () => recordingLineOf({ ...rest, submission: { ...rest.submission, payload: undeclared } }, { landscape: 'sample' }),
    /the stored payload is no submission \(procedure: /,
  );
  assert.throws(() => recordingLineOf(rest, { landscape: '_sample' }), /no proa-recording\/1 line \(landscape: /);
});

test('maps a REST relations payload without relations (only no-links) to relations: []', async () => {
  const [rest] = await storedRun();
  assert.ok(rest);
  // Over REST the server stores the raw body: a submission of no-links alone has no relations.
  const { relations: _relations, ...payload } = rest.submission.payload;
  const line = recordingLineOf({ ...rest, submission: { ...rest.submission, payload } }, { landscape: 'sample' });
  assert.deepEqual(line.submission.relations, []);
  assert.deepEqual(line.submission.noLinks, recordingLineOf(rest, { landscape: 'sample' }).submission.noLinks);
});

// ------------------------------------------------------------- REST reader

const HASH = 'a'.repeat(64);

function task(id: string, modelId: string, modelKey: string, revisionId: string): AnalysisTask {
  return {
    id: id as AnalysisTask['id'],
    projectId: 'prj_01JAKKKKKKKKKKKKKKKKKKKK01',
    kind: 'relations',
    subjectKind: 'model',
    modelId: modelId as AnalysisTask['modelId'],
    modelKey,
    revisionId: revisionId as AnalysisTask['revisionId'],
    valueChainId: null,
    valueChainKey: null,
    valueChainRevisionId: null,
    state: 'done',
    attempts: 1,
    factsHash: HASH,
    inputHash: null,
    leaseUntil: '2026-10-08T10:15:00.000Z',
    claimedBy: 'agent:claude-desktop-1',
    lastError: null,
    submissionId: null,
    createdAt: '2026-10-08T09:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
  };
}

function revision(id: string, modelId: string, rev: number): Revision {
  return {
    id: id as Revision['id'],
    modelId: modelId as Revision['modelId'],
    rev,
    contentHash: HASH,
    factsHash: HASH,
    factsVersion: '1',
    engine: null,
    source: { kind: 'import' },
    seq: rev,
    createdAt: '2026-10-08T09:00:00.000Z',
  };
}

interface FakeServer {
  fetch: typeof globalThis.fetch;
  seen: string[];
}

/**
 * A ProA REST API with the two fixture tasks of PROJECT (newest first, one per
 * page), model A at revision 2 of 2 and model P at revision 1.
 */
async function fakeServer(stored: StoredAnalysis[] = []): Promise<FakeServer> {
  const [rest, mcp] = stored.length > 0 ? stored : await storedRun();
  assert.ok(rest && mcp);
  const modelA = 'mdl_01JAKKKKKKKKKKKKKKKKKKKK01';
  const modelP = 'mdl_01JAKKKKKKKKKKKKKKKKKKKK02';
  const tasks = [
    task(mcp.submission.taskId, modelP, P, 'rev_01JAKKKKKKKKKKKKKKKKKKKK21'),
    task(rest.submission.taskId, modelA, A, 'rev_01JAKKKKKKKKKKKKKKKKKKKK12'),
  ];
  const submissions = new Map<string, AnalysisSubmission>([
    [rest.submission.taskId, rest.submission],
    [mcp.submission.taskId, mcp.submission],
  ]);
  const revisions = new Map([
    [modelA, [revision('rev_01JAKKKKKKKKKKKKKKKKKKKK12', modelA, 2), revision('rev_01JAKKKKKKKKKKKKKKKKKKKK11', modelA, 1)]],
    [modelP, [revision('rev_01JAKKKKKKKKKKKKKKKKKKKK21', modelP, 1)]],
  ]);
  const seen: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    seen.push(`${url.pathname}${url.search}`);
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return Promise.resolve(json({ code: 'unauthorized', detail: 'invalid, expired or revoked agent token' }, 401));
    }
    const base = `/api/v1/projects/${PROJECT}`;
    if (url.pathname === `${base}/analyses` && url.searchParams.get('state') === 'done') {
      const second = url.searchParams.get('cursor') === 'page-2';
      return Promise.resolve(json({ items: [tasks[second ? 1 : 0]], nextCursor: second ? null : 'page-2' }));
    }
    const sub = /^\/api\/v1\/projects\/[^/]+\/analyses\/([^/]+)\/submission$/.exec(url.pathname);
    if (url.pathname.startsWith(base) && sub?.[1] && submissions.has(sub[1])) {
      return Promise.resolve(json(submissions.get(sub[1])));
    }
    const revs = /^\/api\/v1\/projects\/[^/]+\/models\/([^/]+)\/revisions$/.exec(url.pathname);
    if (url.pathname.startsWith(base) && revs?.[1] && revisions.has(revs[1])) {
      return Promise.resolve(json({ items: revisions.get(revs[1]), nextCursor: null }));
    }
    return Promise.resolve(json({ code: 'not-found', detail: `${req.method} ${url.pathname}` }, 404));
  };
  return { fetch, seen };
}

test('reads every done analysis over REST: pages, stored submissions, revision numbers', async () => {
  const server = await fakeServer();
  const stored = await fetchStoredAnalyses({ url: 'http://proa.test/', token: TOKEN, project: PROJECT, fetch: server.fetch });
  assert.deepEqual(
    stored.map((s) => (isStoredPlacement(s) ? [] : [s.modelKey, s.rev, s.submission.taskId])),
    [
      [P, 1, 'ana_01JAKKKKKKKKKKKKKKKKKKKK02'],
      [A, 2, 'ana_01JAKKKKKKKKKKKKKKKKKKKK01'],
    ],
  );
  assert.deepEqual(stored.map((s) => s.submission), (await storedRun()).map((s) => s.submission).reverse());
  // Every page of tasks first, then per task its submission and (once per model) the revisions.
  assert.deepEqual(server.seen, [
    `/api/v1/projects/${PROJECT}/analyses?state=done&limit=200`,
    `/api/v1/projects/${PROJECT}/analyses?state=done&limit=200&cursor=page-2`,
    `/api/v1/projects/${PROJECT}/analyses/ana_01JAKKKKKKKKKKKKKKKKKKKK02/submission`,
    `/api/v1/projects/${PROJECT}/models/mdl_01JAKKKKKKKKKKKKKKKKKKKK02/revisions?limit=200`,
    `/api/v1/projects/${PROJECT}/analyses/ana_01JAKKKKKKKKKKKKKKKKKKKK01/submission`,
    `/api/v1/projects/${PROJECT}/models/mdl_01JAKKKKKKKKKKKKKKKKKKKK01/revisions?limit=200`,
  ]);
});

test('reports server errors and an unreachable server', async () => {
  const server = await fakeServer();
  await assert.rejects(
    fetchStoredAnalyses({ url: 'http://proa.test', token: 'proa_at_wrong', project: PROJECT, fetch: server.fetch }),
    /GET \/projects\/sample-run-1\/analyses\?state=done&limit=200: 401 unauthorized: invalid, expired or revoked agent token/,
  );
  await assert.rejects(
    fetchStoredAnalyses({ url: 'http://proa.test', token: TOKEN, project: 'other', fetch: server.fetch }),
    /404 not-found/,
  );
  await assert.rejects(
    fetchStoredAnalyses({ url: 'http://127.0.0.1:9', token: TOKEN, project: PROJECT }),
    (err: unknown) => err instanceof LiveSourceError && /^cannot reach ProA at http:\/\/127\.0\.0\.1:9/.test(err.message),
  );
});

// ----------------------------------------------------------------- command

interface Run {
  code: number;
  out: string;
  err: string;
}

async function live(argv: string[], server: FakeServer, cwd: string, env: Record<string, string> = {}): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const io: LiveIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { PROA_TOKEN: TOKEN, PROA_URL: 'http://proa.test', ...env },
    cwd,
    fetch: server.fetch,
  };
  const code = await runLive(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

const current = getProcedure('proa-relations');

test('eval:live writes the run, scores it and reports the live gate', async () => {
  assert.ok(current);
  const version = current.version;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-live-'));
  try {
    const server = await fakeServer(declaring(await storedRun(), version));
    // Relative --out resolves against the base directory (INIT_CWD: the repository root under pnpm), not eval/tools.
    const r = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec'], server, dir);
    assert.equal(r.err, '');
    assert.equal(r.code, 0);
    const rel = `proa-relations@${version}/claude-desktop-1/claude-opus-5-5/sample.jsonl`;
    assert.match(r.out, new RegExp(`^${path.join('rec', rel).replaceAll('.', '\\.')}: 2 tasks from project ${PROJECT}$`, 'm'));
    // Proposals: 3 must_link found of 5, 1 must_not_link (0.6), the manual item invalid.
    assert.match(r.out, /: 2 tasks, 4 pairs; precision 75\.0 %, recall 60\.0 % \(∪ rules 80\.0 %\), F1 66\.7 %; must_not_link 1 \(0 at ≥ 0\.8\)/);
    assert.match(
      r.out,
      new RegExp(`live gate proa-relations@${version.replaceAll('.', '\\.')} / sample / claude-opus-5-5 \\(dev\\): INCOMPLETE; 1 run`),
    );
    assert.match(r.out, /- 1 of 3 runs\n/);
    assert.match(
      r.out,
      /- no baseline: no live runs of an earlier version with this llmModel and no agent-sim recording of this version/,
    );
    const text = await readFile(path.join(dir, 'rec', rel), 'utf8');
    assert.deepEqual(
      parseRecording(rel, text).lines.map((l) => ('modelKey' in l ? l.modelKey : null)),
      [P, A],
    );

    // Two more runs and the simulation agent's recording of the same version: the gate passes.
    for (const agent of ['claude-desktop-2', 'claude-desktop-3', 'agent-sim']) {
      const more = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec', '--agent', agent], server, dir);
      assert.equal(more.code, 0, more.err);
    }
    // Recording the same project again writes the same bytes: no warning.
    const again = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec', '--json'], server, dir);
    assert.equal(again.code, 0, again.err);
    assert.equal(again.err, '');
    const report = JSON.parse(again.out) as {
      written: boolean;
      recordings: { path: string; lines: number }[];
      runs: { file: string; overall: { recall: number }; pairsJudgedTwice: number; uncovered: number | null }[];
      gates: { llmModel: string; status: string; runs: number; recall: number; baseline: { source: string; recall: number } }[];
    };
    assert.equal(report.written, true);
    assert.deepEqual(report.recordings, [{ path: rel, lines: 2 }]);
    // No pair judged in both models' tasks; results before proa-relations@0.2.0 report no uncovered pairs.
    assert.deepEqual(report.runs.map((x) => [x.file, x.overall.recall, x.pairsJudgedTwice, x.uncovered]), [[rel, 0.6, 0, null]]);
    assert.deepEqual(
      report.gates.map((g) => [g.llmModel, g.status, g.runs, g.recall, g.baseline.source, g.baseline.recall]),
      [['claude-opus-5-5', 'pass', 3, 0.6, 'agent-sim', 0.6]],
    );

    // A run with another model is a gate of its own, with the sim baseline; the first model's gate is not shown.
    const other = await fakeServer(declaring(await storedRun(), version).map((s) => withModel(s, 'claude-sonnet-5-5')));
    const sonnet = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec', '--agent', 'claude-code-1'], other, dir);
    assert.equal(sonnet.code, 0, sonnet.err);
    assert.match(sonnet.out, / \/ sample \/ claude-sonnet-5-5 \(dev\): INCOMPLETE; 1 run, .*\(baseline 60\.0 % from agent-sim /);
    assert.doesNotMatch(sonnet.out, /claude-opus-5-5 \(dev\)/);
    // The simulation agent's recording is the baseline of both models' gates, so recording it shows both.
    const sim = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec', '--agent', 'agent-sim', '--json'], server, dir);
    assert.equal(sim.code, 0, sim.err);
    assert.deepEqual(
      (JSON.parse(sim.out) as { gates: { llmModel: string; status: string }[] }).gates.map((g) => [g.llmModel, g.status]),
      [
        ['claude-opus-5-5', 'pass'],
        ['claude-sonnet-5-5', 'incomplete'],
      ],
    );
    // The console names no pairs (holdout runs must not leak ground truth).
    assert.doesNotMatch(again.out, /#/);
    assert.deepEqual(
      (await readdir(path.join(dir, 'rec', `proa-relations@${version}`))).sort(),
      ['agent-sim', 'claude-code-1', 'claude-desktop-1', 'claude-desktop-2', 'claude-desktop-3'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval:live exits 1 when the live gate fails, and writes nothing with --no-write', async () => {
  assert.ok(current);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-live-'));
  try {
    // The must_not_link pair at exactly 0.8.
    const stored = declaring(await storedRun(), current.version);
    const [rest, mcp] = stored;
    assert.ok(rest && mcp);
    const payload = rest.submission.payload as { relations: Array<Record<string, unknown>> };
    const relations = payload.relations.map((r, i) => (i === 1 ? { ...r, confidence: 0.8 } : r));
    const failing = { ...rest, submission: { ...rest.submission, payload: { ...payload, relations } } };
    const server = await fakeServer([failing, mcp]);
    const r = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec', '--no-write'], server, dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /: FAIL; 1 run/);
    assert.match(r.out, /- 1 must_not_link pair proposed with confidence ≥ 0\.8 \(in 1 of 1 run\)/);
    assert.match(r.out, /\(not written\)/);
    await assert.rejects(readdir(path.join(dir, 'rec')), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval:live warns when the project gives several files, and when it replaces a file with other content', async () => {
  assert.ok(current);
  const version = current.version;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-live-'));
  try {
    const [rest, mcp] = declaring(await storedRun(), version);
    assert.ok(rest && mcp);
    const prefix = `proa-relations@${version}/claude-desktop-1`;

    // Two declared models in one project: two files, each counted as a run of its model's gate.
    const mixed = await live(
      ['--project', PROJECT, '--landscape', 'sample', '--no-write'],
      await fakeServer([rest, withModel(mcp, 'claude-sonnet-5-5')]),
      dir,
    );
    assert.equal(mixed.code, 0, mixed.err);
    assert.equal(
      mixed.err,
      `eval:live: warning: project ${PROJECT} gives 2 recording files, one per declared procedure, agent and llmModel:\n` +
        `  ${prefix}/claude-opus-5-5/sample.jsonl\n` +
        `  ${prefix}/claude-sonnet-5-5/sample.jsonl\n` +
        '  One run should declare one llmModel and one procedure under one agent token: the live gate counts every file as a run.\n',
    );
    assert.match(mixed.out, / \/ sample \/ claude-opus-5-5 \(dev\): INCOMPLETE; 1 run/);
    assert.match(mixed.out, / \/ sample \/ claude-sonnet-5-5 \(dev\): INCOMPLETE; 1 run/);
    // One model: one file, no warning.
    const single = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec'], await fakeServer([rest, mcp]), dir);
    assert.equal(single.code, 0, single.err);
    assert.equal(single.err, '');

    // The same file with other content (the run went on, or another project under the same name): replaced, with a note.
    const summary = { ...mcp, submission: { ...mcp.submission, payload: { ...mcp.submission.payload, summary: 'Anders.' } } };
    const file = path.join('rec', prefix, 'claude-opus-5-5', 'sample.jsonl');
    const before = await readFile(path.join(dir, file), 'utf8');
    const replaced = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec'], await fakeServer([rest, summary]), dir);
    assert.equal(replaced.code, 0, replaced.err);
    assert.equal(replaced.err, `eval:live: replacing ${file} (2 lines before, 2 now)\n`);
    const after = await readFile(path.join(dir, file), 'utf8');
    assert.notEqual(after, before);
    assert.match(after, /"summary":"Anders\."/);
    // With --no-write nothing is replaced, so there is nothing to say.
    const dry = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec', '--no-write'], await fakeServer([rest, mcp]), dir);
    assert.equal(dry.err, '');
    assert.equal(await readFile(path.join(dir, file), 'utf8'), after);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval:live warns when the project was worked under several tokens, also with --agent', async () => {
  assert.ok(current);
  const version = current.version;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-live-'));
  try {
    const [rest, mcp] = declaring(await storedRun(), version);
    assert.ok(rest && mcp);
    const second = (s: StoredAnalysis, handle: string): StoredAnalysis => ({
      ...s,
      submission: { ...s.submission, principalId: 'prn_01JAKKKKKKKKKKKKKKKKKKKK02', handle },
    });
    const prefix = `proa-relations@${version}`;
    const tokens = (agent: string) =>
      `eval:live: warning: project ${PROJECT} was worked under 2 tokens (agent:claude-code-9, agent:claude-desktop-1)${agent}: ` +
      'one run is one agent token in a fresh project; do not commit it.\n';

    // Two token names: two files, so both warnings.
    const named = await fakeServer([rest, second(mcp, 'agent:claude-code-9')]);
    const split = await live(['--project', PROJECT, '--landscape', 'sample', '--no-write'], named, dir);
    assert.equal(split.code, 0, split.err);
    assert.equal(
      split.err,
      tokens('') +
        `eval:live: warning: project ${PROJECT} gives 2 recording files, one per declared procedure, agent and llmModel:\n` +
        `  ${prefix}/claude-code-9/claude-opus-5-5/sample.jsonl\n` +
        `  ${prefix}/claude-desktop-1/claude-opus-5-5/sample.jsonl\n` +
        '  One run should declare one llmModel and one procedure under one agent token: the live gate counts every file as a run.\n',
    );

    // --agent files them as one run: one file, and the warning all the same.
    const merged = await live(['--project', PROJECT, '--landscape', 'sample', '--out', 'rec', '--agent', 'claude-code-1'], named, dir);
    assert.equal(merged.code, 0, merged.err);
    assert.equal(merged.err, tokens(', which --agent claude-code-1 records as one run'));
    assert.deepEqual(await readdir(path.join(dir, 'rec', prefix)), ['claude-code-1']);

    // Two tokens of one name give one file too.
    const sameName = await fakeServer([rest, second(mcp, 'agent:claude-desktop-1')]);
    const one = await live(['--project', PROJECT, '--landscape', 'sample', '--no-write'], sameName, dir);
    assert.equal(one.code, 0, one.err);
    assert.equal(
      one.err,
      `eval:live: warning: project ${PROJECT} was worked under 2 tokens (agent:claude-desktop-1, agent:claude-desktop-1): ` +
        'one run is one agent token in a fresh project; do not commit it.\n',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval:live refuses analyses of models the landscape does not have, and writes nothing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-live-'));
  try {
    // The fixtures analysed two models of _sample; of its three, nordwind-handel has finanzen/rechnungsstellung only.
    const r = await live(['--project', PROJECT, '--landscape', 'nordwind-handel', '--out', 'rec'], await fakeServer(), dir);
    assert.equal(r.code, 2, r.err);
    assert.match(
      r.err,
      new RegExp(
        `^eval:live: project ${PROJECT} has analyses of 2 models not in landscape nordwind-handel ` +
          `\\(${P}, ${A}\\); name the landscape the project was seeded from with --landscape\n`,
      ),
    );
    assert.match(r.err, /\n\nusage: pnpm eval:live --project <key>/);
    assert.equal(r.out, '');
    await assert.rejects(readdir(path.join(dir, 'rec')), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eval:live warns about another declared procedure version; usage errors exit 2, runtime errors 1', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'proa-live-'));
  try {
    const server = await fakeServer(); // the fixtures declare proa-relations@0.0.0
    const old = await live(['--project', PROJECT, '--landscape', '_sample', '--no-write'], server, dir);
    assert.equal(old.code, 0, old.err);
    assert.match(
      old.err,
      new RegExp(`warning: the run declared proa-relations@0\\.0\\.0; the current procedure is proa-relations@${current?.version.replaceAll('.', '\\.') ?? ''}`),
    );

    // Usage errors: exit 2 with the usage text, before any request.
    const usage: Array<[string[], Record<string, string>, RegExp]> = [
      [[], {}, /--project is required/],
      [['--project', PROJECT, '--landscape', 'sample'], { PROA_TOKEN: '' }, /--token or PROA_TOKEN/],
      [['--project', PROJECT], {}, /project sample-run-1 is not named after a corpus landscape; name the landscape .* --landscape/],
      [['--project', PROJECT, '--landscape', 'atlantis'], {}, /no landscape atlantis in /],
      [['--project', PROJECT, '--landscape', 'sample', '--bogus'], {}, /Unknown option '--bogus'/],
    ];
    for (const [argv, env, message] of usage) {
      const seen = server.seen.length;
      const r = await live(argv, server, dir, env);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, message);
      assert.match(r.err, /^eval:live: /);
      assert.match(r.err, /\n\nusage: pnpm eval:live --project <key>/);
      assert.equal(server.seen.length, seen, argv.join(' '));
    }

    // Runtime errors: exit 1, no usage text.
    const [rest, mcp] = await storedRun();
    assert.ok(rest && mcp);
    const payload = { ...rest.submission.payload, relations: 'none' };
    const broken = await fakeServer([{ ...rest, submission: { ...rest.submission, payload } }, mcp]);
    const unreachable: FakeServer = { fetch: () => Promise.reject(new TypeError('fetch failed')), seen: [] };
    const runtime: Array<[string[], FakeServer, RegExp]> = [
      [['--token', 'proa_at_wrong'], server, /401 unauthorized/],
      [['--project', 'other'], server, /GET \/projects\/other\/analyses\?state=done&limit=200: 404 not-found/],
      [[], unreachable, /cannot reach ProA at http:\/\/proa\.test \(fetch failed\)/],
      [[], broken, /task ana_01JAKKKKKKKKKKKKKKKKKKKK01: the stored payload is no submission \(relations: /],
    ];
    for (const [extra, at, message] of runtime) {
      const r = await live(['--project', PROJECT, '--landscape', 'sample', '--no-write', ...extra], at, dir);
      assert.equal(r.code, 1, extra.join(' '));
      assert.match(r.err, message);
      assert.match(r.err, /^eval:live: /);
      assert.doesNotMatch(r.err, /usage:/);
    }

    const help = await live(['--help'], server, dir);
    assert.equal(help.code, 0);
    assert.match(help.out, /^usage: pnpm eval:live --project <key>/);
    assert.match(help.out, /Exit codes: 0 .*, 1 .*\n.*, 2 a usage error\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
