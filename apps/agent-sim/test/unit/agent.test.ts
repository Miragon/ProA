/**
 * The agent loop over MCP against an in-memory ProA (`fake-proa.ts`): the
 * real SDK client and transport, the fake's tools.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RecordingLine } from '@proa/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { SimError, problemOf, runAgent, type McpSession } from '../../src/agent.ts';
import { connect } from '../../src/connect.ts';
import { SIM_POLICY, decide } from '../../src/policy.ts';
import { createRecorder } from '../../src/recorder.ts';
import { claimInput } from '../support/fixtures.ts';
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
    expect(report.prompt).toBe(true);
    expect(report.stop).toBe('no-work');
    expect(report.tasks.map((t) => t.outcome)).toEqual(['submitted', 'submitted', 'submitted']);
    // One task per claim, then an empty claim ends the loop.
    expect(proa.claims).toEqual([{ max: 1 }, { max: 1 }, { max: 1 }, { max: 1 }]);
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
    expect(lines[0]).toBe('procedure proa-relations@0.0.1 (placeholder)');
    expect(lines[1]).toMatch(/^prompt work_pipeline: \d+ characters$/);
    expect(lines[2]).toMatch(
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
    expect(proa.claims).toEqual([
      { projectId: 'demo', modelKey: 'vertrieb/orders', max: 1 },
      { projectId: 'demo', modelKey: 'vertrieb/orders', max: 1 },
    ]);
    expect(proa.queue).toHaveLength(1);
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
    expect(lines.map((l) => RecordingLine.parse(JSON.parse(l)).outcome)).toEqual([
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
