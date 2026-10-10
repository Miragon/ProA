/**
 * The agent loop over MCP against an in-memory ProA (`fake-proa.ts`): the
 * real SDK client and transport, the fake's tools.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PlacementRecordingLine, RelationRecordingLine } from '@proa/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { SimError, problemOf, runAgent, type McpSession } from '../../src/agent.ts';
import { connect } from '../../src/connect.ts';
import { decidePlacements } from '../../src/placement-policy.ts';
import { SIM_POLICY, decide } from '../../src/policy.ts';
import { createRecorder } from '../../src/recorder.ts';
import { claimInput } from '../support/fixtures.ts';
import { placementInput } from '../support/placement-fixtures.ts';
import { TOKEN, fakeProa, type FakeProa } from '../support/fake-proa.ts';

const sessions: McpSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function open(proa: FakeProa, token = TOKEN): Promise<McpSession> {
  const s = await connect(
    { kind: 'http', url: 'http://proa.test', token, fetch: proa.fetch },
    {
      name: 'test',
      version: '0',
    },
  );
  sessions.push(s);
  return s;
}

async function tempDir(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'agent-sim-'));
  dirs.push(d);
  return d;
}

describe('runAgent', () => {
  it('loads the procedure and the prompt, then claims and submits until no task is left', async () => {
    const proa = fakeProa({ tasks: 3 });
    const lines: string[] = [];
    let n = 0;
    const report = await runAgent(await open(proa), {
      log: (l) => lines.push(l),
      newSubmissionId: () => `00000000-0000-4000-8000-00000000000${n++}`,
    });
    expect(report.procedure).toEqual({ id: 'proa-relations', version: '0.0.1' });
    expect(report.procedures).toEqual({
      relations: { id: 'proa-relations', version: '0.0.1' },
      placement: { id: 'proa-placements', version: '0.0.1' },
    });
    expect(report.kinds).toEqual(['relations', 'placement']);
    expect(report.prompt).toBe(true);
    expect(report.stop).toBe('no-work');
    expect(report.tasks.map((t) => t.outcome)).toEqual(['submitted', 'submitted', 'submitted']);
    // One task per claim of every kind the agent handles, then an empty claim ends the loop.
    const claim = { max: 1, kinds: ['relations', 'placement'] };
    expect(proa.claims).toEqual([claim, claim, claim, claim]);
    // Both kinds: the relations text of work_pipeline (the default).
    expect(proa.prompts).toEqual([{}]);
    expect(proa.queue).toHaveLength(0);
    expect(proa.claimed.size).toBe(0);
    expect(proa.authorizations.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);

    const expected = decide(claimInput());
    for (const [i, s] of proa.submissions.entries()) {
      expect(s).toMatchObject({
        submissionId: `00000000-0000-4000-8000-00000000000${i}`,
        procedure: { id: 'proa-relations', version: '0.0.1' },
        llmModel: SIM_POLICY,
        relations: expected.relations,
        noLinks: expected.noLinks,
        summary: expected.summary,
        costUsd: 0,
      });
      expect(String(s['leaseToken'])).toMatch(/^proa_lt_/);
    }
    expect(report.totals).toMatchObject({
      tasks: 3,
      submitted: 3,
      proposed: 3 * expected.relations.length,
      questions: 3,
      noLinks: 3,
      outcomes: { applied: 3 * expected.relations.length, invalid: 0 },
    });
    expect(report.byKind.placement.tasks).toBe(0);
    expect(lines[0]).toBe('procedure proa-relations@0.0.1 (placeholder)');
    expect(lines[1]).toBe('procedure proa-placements@0.0.1 (placeholder)');
    expect(lines[2]).toMatch(/^prompt work_pipeline: \d+ characters$/);
    expect(lines[3]).toMatch(
      /^demo vertrieb\/orders \(ana_\w+, attempt 1\): 4 proposed, 1 with a question, 1 no-links; applied 4/,
    );
  });

  it('narrows claims to a project and model and stops after maxTasks', async () => {
    const proa = fakeProa({ tasks: 3 });
    const report = await runAgent(await open(proa), {
      projectId: 'demo',
      modelKey: 'vertrieb/orders',
      maxTasks: 2,
    });
    expect(report.stop).toBe('max-tasks');
    expect(report.tasks).toHaveLength(2);
    const claim = {
      projectId: 'demo',
      modelKey: 'vertrieb/orders',
      max: 1,
      kinds: ['relations', 'placement'],
    };
    expect(proa.claims).toEqual([claim, claim]);
    expect(proa.queue).toHaveLength(1);
  });

  it('works placement tasks after the relations tasks, dispatching on the kind', async () => {
    const proa = fakeProa({ tasks: 1, placements: 1 });
    const dir = await tempDir();
    const lines: string[] = [];
    const report = await runAgent(await open(proa), {
      log: (l) => lines.push(l),
      newSubmissionId: () => '00000000-0000-4000-8000-000000000001',
      recorder: createRecorder({ dir, input: 'summary', ids: false }),
    });
    expect(report.tasks.map((t) => [t.kind, t.outcome])).toEqual([
      ['relations', 'submitted'],
      ['placement', 'submitted'],
    ]);
    const expected = decidePlacements(placementInput());
    const sent = proa.submissions[1] ?? {};
    expect(sent).toMatchObject({
      procedure: { id: 'proa-placements', version: '0.0.1' },
      llmModel: SIM_POLICY,
      placements: expected.placements,
      unsure: expected.unsure,
      summary: expected.summary,
      costUsd: 0,
    });
    // A placement submission carries no relations items.
    expect(sent['relations']).toEqual([]);
    expect(sent['noLinks']).toEqual([]);
    expect(report.byKind.relations).toMatchObject({ tasks: 1, submitted: 1, failed: 0 });
    expect(report.byKind.placement).toMatchObject({
      tasks: 1,
      submitted: 1,
      proposed: expected.placements.length,
      questions: 2,
      unsure: 2,
      skipped: 0,
      followUps: 0,
      outcomes: { applied: expected.placements.length, invalid: 0 },
    });
    expect(report.totals.tasks).toBe(2);
    expect(lines.at(-1)).toMatch(
      /^demo value chain main r3 \(ana_\w+, attempt 1\): 8 processes, 6 placed, 2 with a question, 2 unsure; applied 6, .*, skipped 0$/,
    );
    // Each kind in its procedure's folder; the placement file holds placement lines.
    expect(report.recordings.map((f) => path.relative(dir, f))).toEqual([
      'proa-relations@0.0.1/agent-sim/sim-policy-1/demo.jsonl',
      'proa-placements@0.0.1/agent-sim/sim-policy-1/demo.jsonl',
    ]);
    const line = PlacementRecordingLine.parse(
      JSON.parse(await readFile(report.recordings[1] ?? '', 'utf8')),
    );
    expect(line).toMatchObject({
      kind: 'placement',
      valueChain: { key: 'main', rev: 3, contentHash: 'a'.repeat(64) },
      outcome: 'submitted',
      result: { counts: { applied: 6 }, skipped: { count: 0 }, followUp: false },
    });
  });

  it('claims only the kinds asked for', async () => {
    const proa = fakeProa({ tasks: 2, placements: 1 });
    const report = await runAgent(await open(proa), { kinds: ['placement'] });
    expect(report.kinds).toEqual(['placement']);
    expect(report.procedures).toEqual({
      placement: { id: 'proa-placements', version: '0.0.1' },
    });
    expect(report.procedure).toBeNull();
    expect(report.tasks.map((t) => t.kind)).toEqual(['placement']);
    expect(proa.claims.every((c) => JSON.stringify(c['kinds']) === '["placement"]')).toBe(true);
    // The pipeline prompt of the one kind it claims.
    expect(proa.prompts).toEqual([{ kind: 'placement' }]);
    expect(proa.queue.map((c) => c.kind)).toEqual(['relations', 'relations']);
    await expect(runAgent(await open(proa), { kinds: [] })).rejects.toThrow(/no task kind/);
  });

  it('hands a refused placement submission back (wrong-task-kind) and records it as failed', async () => {
    const proa = fakeProa({
      tasks: 0,
      placements: 1,
      submitProblem: () => ({ code: 'wrong-task-kind', status: 422, detail: 'x' }),
    });
    const dir = await tempDir();
    const report = await runAgent(await open(proa), {
      recorder: createRecorder({ dir, input: 'full', ids: true }),
    });
    expect(report.tasks.map((t) => [t.kind, t.outcome, t.problem?.code])).toEqual([
      ['placement', 'failed', 'wrong-task-kind'],
    ]);
    expect(report.byKind.placement.failed).toBe(1);
    expect(proa.releases.map((r) => r['reason'])).toEqual([
      'agent-sim: submission refused (wrong-task-kind)',
    ]);
    const line = PlacementRecordingLine.parse(
      JSON.parse(await readFile(report.recordings[0] ?? '', 'utf8')),
    );
    expect(line).toMatchObject({
      outcome: 'failed',
      result: null,
      problem: { code: 'wrong-task-kind', detail: 'x' },
    });
    expect(line.task?.taskId).toMatch(/^ana_/);
    expect(line.input).toMatchObject({ format: 'proa-claim-placement/1', truncated: false });
  });

  it('dry run: decides and records, submits nothing and hands every task back', async () => {
    const proa = fakeProa({ tasks: 2 });
    const dir = await tempDir();
    const report = await runAgent(await open(proa), {
      dryRun: true,
      recorder: createRecorder({ dir, input: 'summary', ids: true }),
    });
    expect(report.tasks.map((t) => t.outcome)).toEqual(['dry-run', 'dry-run']);
    expect(proa.submissions).toHaveLength(0);
    expect(proa.releases.map((r) => r['reason'])).toEqual([
      'agent-sim dry run',
      'agent-sim dry run',
    ]);
    expect(proa.queue).toHaveLength(2);
    const [file] = report.recordings;
    expect(file).toBe(path.join(dir, 'proa-relations@0.0.1/agent-sim/sim-policy-1/demo.jsonl'));
    const lines = (await readFile(file ?? '', 'utf8')).trimEnd().split('\n');
    expect(lines.map((l) => RelationRecordingLine.parse(JSON.parse(l)).outcome)).toEqual([
      'dry-run',
      'dry-run',
    ]);
  });

  it('reports a refused submission, goes on and hands that task back at the end', async () => {
    const proa = fakeProa({
      tasks: 2,
      submitProblem: (n) =>
        n === 0 ? { code: 'validation-failed', status: 422, detail: 'relations: too many' } : null,
    });
    const report = await runAgent(await open(proa));
    expect(report.tasks.map((t) => [t.outcome, t.problem?.code ?? null])).toEqual([
      ['failed', 'validation-failed'],
      ['submitted', null],
    ]);
    expect(report.totals.failed).toBe(1);
    expect(report.stop).toBe('no-work');
    expect(proa.releases.map((r) => r['reason'])).toEqual([
      'agent-sim: submission refused (validation-failed)',
    ]);
    expect(proa.queue).toHaveLength(1);
  });

  it('stops instead of looping when a claim returns a task it saw before', async () => {
    const proa = fakeProa({ tasks: 1 });
    const session = await open(proa);
    // A server that hands the same task out twice (e.g. released by someone else meanwhile).
    const twice: McpSession = {
      ...session,
      async callTool(name, args) {
        const out = await session.callTool(name, args);
        if (name === 'claim_analysis' && proa.claims.length === 1)
          proa.queue.push(...proa.claimed.values());
        return out;
      },
    };
    const report = await runAgent(twice, { dryRun: true });
    expect(report.stop).toBe('repeated-task');
    expect(report.tasks).toHaveLength(1);
  });

  it('keeps a task whose submission was refused for another reason (the lease runs out)', async () => {
    const proa = fakeProa({
      tasks: 1,
      submitProblem: () => ({ code: 'lease-lost', status: 409, detail: 'claimed again' }),
    });
    const report = await runAgent(await open(proa));
    expect(report.tasks[0]?.problem).toEqual({ code: 'lease-lost', detail: 'claimed again' });
    expect(proa.releases).toHaveLength(0);
    expect(report.stop).toBe('no-work');
  });

  it('works without prompts and without get_procedure', async () => {
    const proa = fakeProa({ tasks: 1, prompts: false, procedure: false });
    const report = await runAgent(await open(proa));
    expect(report.prompt).toBe(false);
    expect(report.procedure).toBeNull();
    expect(proa.submissions[0]?.['procedure']).toEqual({ id: 'proa-relations', version: '0.0.1' });
  });

  it('refuses a server without the pipeline tools', async () => {
    const proa = fakeProa({ without: 'claim_analysis' });
    await expect(runAgent(await open(proa))).rejects.toThrow(SimError);
    await expect(runAgent(await open(proa))).rejects.toThrow(/offers no claim_analysis/);
  });

  it('fails to connect with a wrong token', async () => {
    await expect(open(fakeProa(), `proa_at_${'x'.repeat(43)}`)).rejects.toThrow();
  });
});

describe('problemOf', () => {
  it('reads RFC 9457 problems and falls back to the text', () => {
    expect(
      problemOf({
        isError: true,
        data: {},
        text: '{"code":"lease-lost","status":409,"detail":"x"}',
      }),
    ).toEqual({ code: 'lease-lost', detail: 'x' });
    expect(problemOf({ isError: true, data: {}, text: 'Input validation error: max' })).toEqual({
      code: 'tool-error',
      detail: 'Input validation error: max',
    });
    expect(problemOf({ isError: true, data: {}, text: '' })).toEqual({
      code: 'tool-error',
      detail: null,
    });
  });
});
