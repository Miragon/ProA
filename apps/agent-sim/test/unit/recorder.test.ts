import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RecordingLine, newId, recordingPath, recordingSegment } from '@proa/contracts';
import { afterAll, describe, expect, it } from 'vitest';

import { SIM_POLICY, decide } from '../../src/policy.ts';
import {
  createRecorder,
  recordingLine,
  summarizeInput,
  type RecordedTask,
} from '../../src/recorder.ts';
import { claimInput, claimed } from '../support/fixtures.ts';

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function task(outcome: RecordedTask['outcome'] = 'submitted', projectKey = 'demo'): RecordedTask {
  const c = claimed(projectKey);
  const decision = decide(c.input);
  return {
    agent: 'agent-sim',
    llmModel: SIM_POLICY,
    claimed: c,
    decision,
    submissionId: outcome === 'dry-run' ? null : '00000000-0000-4000-8000-000000000001',
    outcome,
    result:
      outcome === 'submitted'
        ? {
            taskId: c.taskId,
            submissionId: '00000000-0000-4000-8000-000000000001',
            replayed: false,
            items: decision.relations.map((_, index) => ({
              index,
              result: index === 0 ? 'duplicate' : 'applied',
              relationId: newId('relation'),
              status: 'proposed',
            })),
            counts: { applied: 3, duplicate: 1, suppressed: 0, reopened: 0, invalid: 0 },
            withdrawn: 2,
          }
        : null,
  };
}

describe('recordingLine', () => {
  it('holds the claim input, the submission without the lease token and the result', () => {
    const t = task();
    const line = recordingLine(t, { input: 'full', ids: true });
    expect(RecordingLine.parse(line)).toEqual(line);
    expect(line).toMatchObject({
      format: 'proa-recording/1',
      landscape: 'demo',
      modelKey: 'vertrieb/orders',
      rev: 1,
      agent: 'agent-sim',
      procedure: { id: 'proa-relations', version: '0.0.1' },
      llmModel: SIM_POLICY,
      task: {
        taskId: t.claimed.taskId,
        revisionId: t.claimed.revisionId,
        attempt: 1,
        submissionId: '00000000-0000-4000-8000-000000000001',
      },
      input: t.claimed.input,
      submission: { summary: t.decision.summary, costUsd: 0 },
      outcome: 'submitted',
      result: { withdrawn: 2, counts: { duplicate: 1 } },
    });
    expect(line.submission.relations).toEqual(t.decision.relations);
    expect(line.submission.noLinks).toEqual(t.decision.noLinks);
    expect(line.result?.items[0]).toMatchObject({
      index: 0,
      result: 'duplicate',
      status: 'proposed',
    });
    expect(line.result?.items[0]?.relationId).toMatch(/^rel_/);
    expect(JSON.stringify(line)).not.toContain('proa_lt_');
  });

  it('leaves server ids out and summarizes the input on request', () => {
    const t = task();
    const line = recordingLine(t, { input: 'summary', ids: false });
    expect(RecordingLine.parse(line)).toEqual(line);
    expect(line.task).toBeUndefined();
    expect(line.result?.items.every((i) => !('relationId' in i))).toBe(true);
    expect(line.input).toEqual({
      format: 'proa-claim/1',
      summary: true,
      facts: 7,
      candidates: 10,
      partners: 9,
      relations: 5,
      bytes: Buffer.byteLength(JSON.stringify(t.claimed.input)),
    });
    expect(JSON.stringify(line)).not.toMatch(/"(ana|rev|rel)_[0-9A-Z]{26}"/);
    // Two different runs of the same decision give the same line.
    expect(recordingLine(task(), { input: 'summary', ids: false })).toEqual(line);
  });

  it('keeps the no-link types and the no-link outcomes, withdrawn no-links and the uncovered count', () => {
    const t = task();
    const result = t.result;
    expect(result).not.toBeNull();
    if (!result) return;
    expect(t.decision.noLinks.length).toBeGreaterThan(0);
    // Server results before no-links were validated have none of the three fields.
    const before = recordingLine(t, { input: 'summary', ids: false });
    expect(before.result && Object.keys(before.result)).toEqual([
      'replayed',
      'counts',
      'withdrawn',
      'items',
    ]);
    expect(before.submission.noLinks.every((n) => n.type === 'message')).toBe(true);

    const pair = { type: 'message', from: 'vertrieb/orders#A', to: 'lager/stock#B' } as const;
    const line = recordingLine(
      {
        ...t,
        result: {
          // Keys in another order than the recorder writes them.
          ...result,
          uncovered: { pairs: [{ to: pair.to, from: pair.from, type: pair.type }], count: 3 },
          withdrawnNoLinks: 1,
          noLinks: {
            counts: { invalid: 1, duplicate: 0, stored: 0 },
            items: [{ result: 'invalid:type-required', index: 0 }],
          },
        },
      },
      { input: 'summary', ids: false },
    );
    expect(RecordingLine.parse(line)).toEqual(line);
    expect(JSON.stringify(line.result)).toBe(
      JSON.stringify({
        ...before.result,
        noLinks: {
          items: [{ index: 0, result: 'invalid:type-required' }],
          counts: { stored: 0, duplicate: 0, invalid: 1 },
        },
        withdrawnNoLinks: 1,
        // The count only: the pairs would bloat the recordings.
        uncovered: { count: 3 },
      }),
    );
  });

  it('records dry runs and failures without a result', () => {
    expect(recordingLine(task('dry-run'), { input: 'summary', ids: true })).toMatchObject({
      outcome: 'dry-run',
      result: null,
      task: { submissionId: null },
    });
    const failed = recordingLine(
      { ...task('failed'), problem: { code: 'lease-lost', detail: null } },
      { input: 'summary', ids: false },
    );
    expect(RecordingLine.parse(failed).problem).toEqual({ code: 'lease-lost', detail: null });
  });

  it('summarizes the size of the input as the agent received it', () => {
    const input = claimInput();
    expect(summarizeInput(input).bytes).toBe(Buffer.byteLength(JSON.stringify(input), 'utf8'));
  });
});

describe('recordingPath', () => {
  it('is <procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl with safe segments', () => {
    expect(
      recordingPath({
        procedure: { id: 'proa-relations', version: '0.1.0' },
        agent: 'claude code',
        llmModel: 'claude-sonnet-5-5',
        landscape: 'nordwind-handel',
      }),
    ).toBe('proa-relations@0.1.0/claude-code/claude-sonnet-5-5/nordwind-handel.jsonl');
    expect(recordingSegment('../../etc')).toBe('etc');
    expect(recordingSegment('a/b:c')).toBe('a-b-c');
    expect(recordingSegment('')).toBe('none');
    expect(
      recordingPath({
        procedure: { id: 'x', version: '1' },
        agent: 'a',
        llmModel: null,
        landscape: 'l',
      }),
    ).toBe('x@1/a/none/l.jsonl');
  });
});

describe('createRecorder', () => {
  it('starts each file afresh in a run, then appends', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-sim-rec-'));
    dirs.push(dir);
    const file = path.join(dir, 'proa-relations@0.0.1/agent-sim/sim-policy-1/demo.jsonl');
    for (let run = 0; run < 2; run++) {
      const recorder = createRecorder({ dir, input: 'summary', ids: false });
      expect(await recorder.record(task())).toBe(file);
      await recorder.record(task());
      await recorder.record(task('submitted', 'other'));
      expect(recorder.files).toEqual([file, path.join(path.dirname(file), 'other.jsonl')]);
    }
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines).toHaveLength(3); // two lines and the final newline: the second run replaced the first
    expect(lines[2]).toBe('');
    expect(lines[0]).toBe(lines[1]);
  });
});
