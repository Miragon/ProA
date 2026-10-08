// Tests for the live gate (src/live-gate.ts) on synthetic scores: status
// (pass, fail, incomplete), the baseline (previous version's live runs, else
// the agent-sim recording of the same version), the 5-point boundary, the
// 0.8 rule and landscapes without must_link pairs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_RECALL_DROP,
  MIN_LIVE_RUNS,
  compareVersions,
  formatLiveGate,
  liveGates,
  splitProcedure,
  type LiveGateInput,
} from '../src/live-gate.ts';

let n = 0;

/** A replay score with what the gate reads; `hits` are the confidences of must_not_link proposals. */
function score(
  procedure: string,
  agent: string,
  recall: number | null,
  options: { landscape?: string; precision?: number | null; f1?: number | null; hits?: number[] } = {},
): LiveGateInput {
  const landscape = options.landscape ?? 'nordwind-handel';
  n++;
  return {
    file: `${procedure}/${agent}/model-${n}/${landscape}.jsonl`,
    procedure,
    agent,
    llmModel: `model-${n}`,
    landscape,
    split: 'dev',
    overall: {
      mustLink: recall === null ? 0 : 20,
      found: recall === null ? 0 : Math.round(recall * 20),
      mayLink: 0,
      mustNotLink: options.hits?.length ?? 0,
      unlisted: 0,
      sameProcess: 0,
      precision: options.precision === undefined ? 0.9 : options.precision,
      recall,
      f1: options.f1 === undefined ? 0.8 : options.f1,
    },
    mustNotLinkHits: (options.hits ?? []).map((confidence, i) => ({
      type: 'message',
      from: `a#From_${i}`,
      to: `b#To_${i}`,
      class: 'must_not_link',
      tags: ['near-miss'],
      confidence,
      question: false,
    })),
  };
}

const V1 = 'proa-relations@0.1.0';
const V2 = 'proa-relations@0.2.0';

test('passes with three live runs at the baseline; the simulation agent is no live run', () => {
  const gates = liveGates([
    score(V1, 'agent-sim', 0.75),
    score(V1, 'claude-desktop-1', 0.8, { precision: 0.9, f1: 0.85 }),
    score(V1, 'claude-desktop-2', 0.75, { precision: 0.8, f1: 0.75 }),
    score(V1, 'claude-code-1', 0.7, { precision: 0.7, f1: 0.65, hits: [0.79, 0.5] }),
  ]);
  assert.equal(gates.length, 1);
  const g = gates[0];
  assert.ok(g);
  assert.deepEqual(
    [g.procedure, g.landscape, g.status, g.runs, g.mustNotLinkHighConfidence, g.reasons],
    [V1, 'nordwind-handel', 'pass', 3, 0, []],
  );
  assert.ok(Math.abs((g.recall ?? 0) - 0.75) < 1e-12);
  assert.ok(Math.abs((g.precision ?? 0) - 0.8) < 1e-12);
  assert.ok(Math.abs((g.f1 ?? 0) - 0.75) < 1e-12);
  assert.deepEqual(
    [g.baseline.source, g.baseline.procedure, g.baseline.runs, g.baseline.recall],
    ['agent-sim', V1, 1, 0.75],
  );
  assert.deepEqual(g.liveRuns.map((r) => r.agent), ['claude-code-1', 'claude-desktop-1', 'claude-desktop-2'].sort());
  assert.match(formatLiveGate(g), /^live gate proa-relations@0\.1\.0 \/ nordwind-handel \(dev\): pass; 3 runs, .*baseline 75\.0 % from agent-sim proa-relations@0\.1\.0/);
  // Only the simulation agent: nothing to gate.
  assert.deepEqual(liveGates([score(V1, 'agent-sim', 0.75)]), []);
});

test(`is incomplete below ${MIN_LIVE_RUNS} runs or without a baseline`, () => {
  const [two] = liveGates([score(V1, 'agent-sim', 0.7), score(V1, 'a-1', 0.8), score(V1, 'a-2', 0.8)]);
  assert.deepEqual([two?.status, two?.reasons], ['incomplete', [`2 of ${MIN_LIVE_RUNS} runs`]]);
  const [none] = liveGates([score(V1, 'a-1', 0.8), score(V1, 'a-2', 0.8), score(V1, 'a-3', 0.8)]);
  assert.equal(none?.status, 'incomplete');
  assert.deepEqual(none?.baseline, { source: 'none', procedure: null, runs: 0, recall: null, files: [] });
  assert.equal(none?.recallDelta, null);
  assert.match(none?.reasons[0] ?? '', /^no baseline/);
  assert.match(formatLiveGate(none ?? assert.fail()), /\(no baseline\)/);
});

test('fails on a must_not_link proposal at confidence 0.8 or more, in any run and with any run count', () => {
  const runs = (hits: number[]) => [
    score(V1, 'agent-sim', 0.8),
    score(V1, 'a-1', 0.8),
    score(V1, 'a-2', 0.8, { hits }),
    score(V1, 'a-3', 0.8),
  ];
  assert.equal(liveGates(runs([0.79999]))[0]?.status, 'pass');
  const [at] = liveGates(runs([0.8, 0.3]));
  assert.deepEqual(
    [at?.status, at?.mustNotLinkHighConfidence, at?.reasons],
    ['fail', 1, ['1 must_not_link pair proposed with confidence ≥ 0.8 (in 1 of 3 runs)']],
  );
  assert.equal(liveGates(runs([1, 0.95]))[0]?.mustNotLinkHighConfidence, 2);
  // One run is enough to fail (fail before incomplete); the other reasons are listed too.
  const [single] = liveGates([score(V1, 'a-1', 0.9, { hits: [0.85] })]);
  assert.equal(single?.status, 'fail');
  assert.equal(single?.reasons.length, 3);
});

test(`fails when the mean recall is more than ${MAX_RECALL_DROP * 100} points below the baseline; exactly 5 points pass`, () => {
  // Baseline 0.8 (mean of 0.85 and 0.75): float arithmetic must not tip the boundary.
  const sims = [score(V1, 'agent-sim', 0.85, { landscape: 'x' }), score(V1, 'agent-sim', 0.75, { landscape: 'x' })];
  const at = liveGates([...sims, ...[0.7, 0.8, 0.75].map((r, i) => score(V1, `a-${i}`, r, { landscape: 'x' }))]);
  assert.equal(at[0]?.baseline.runs, 2);
  assert.ok(Math.abs((at[0]?.recallDelta ?? 0) + 0.05) < 1e-12);
  assert.equal(at[0]?.status, 'pass');
  const below = liveGates([...sims, ...[0.7, 0.8, 0.7499].map((r, i) => score(V1, `a-${i}`, r, { landscape: 'x' }))]);
  assert.equal(below[0]?.status, 'fail');
  assert.match(below[0]?.reasons[0] ?? '', /^mean recall 75\.0 % is more than 5 points below the baseline 80\.0 %$/);
  // Above the baseline is fine.
  const above = liveGates([score(V1, 'agent-sim', 0.5), ...[0.9, 0.9, 0.9].map((r, i) => score(V1, `a-${i}`, r))]);
  assert.equal(above[0]?.status, 'pass');
});

test("takes the baseline from the highest earlier version's live runs, else from agent-sim of the same version", () => {
  const scores = [
    // Earlier versions on this landscape: 0.1.9 and 0.1.10 (numeric order), live runs.
    score('proa-relations@0.1.9', 'a-1', 0.95),
    score('proa-relations@0.1.10', 'a-1', 0.9),
    score('proa-relations@0.1.10', 'a-2', 0.8),
    score('proa-relations@0.1.10', 'agent-sim', 0.1),
    // Not earlier, other landscape, other procedure, no x.y.z version: ignored.
    score('proa-relations@0.3.0', 'a-1', 1),
    score('proa-relations@0.1.0', 'a-1', 1, { landscape: 'stadtwerke-auental' }),
    score('proa-other@0.1.0', 'a-1', 1),
    score('proa-relations@0.1.99-rc.1', 'a-1', 1),
    // The current version: its sim recording is not the baseline while earlier live runs exist.
    score(V2, 'agent-sim', 0.2),
    score(V2, 'b-1', 0.8),
    score(V2, 'b-2', 0.8),
    score(V2, 'b-3', 0.8),
  ];
  const v2 = liveGates(scores).find((g) => g.procedure === V2);
  assert.ok(v2);
  assert.deepEqual(
    [v2.baseline.source, v2.baseline.procedure, v2.baseline.runs],
    ['previous-version', 'proa-relations@0.1.10', 2],
  );
  assert.ok(Math.abs((v2.baseline.recall ?? 0) - 0.85) < 1e-12);
  assert.equal(v2.status, 'pass');
  assert.match(formatLiveGate(v2), /baseline 85\.0 % from 2 live runs of proa-relations@0\.1\.10/);

  // A drop against the previous version fails even though the sim recording is far lower.
  const drop = liveGates([...scores.slice(0, -3), ...[0.7, 0.8, 0.8].map((r, i) => score(V2, `b-${i}`, r))]);
  assert.equal(drop.find((g) => g.procedure === V2)?.status, 'fail');

  // Earlier versions with sim recordings only: the sim recording of the same version.
  const simOnly = liveGates([score(V1, 'agent-sim', 0.9), score(V2, 'agent-sim', 0.6), score(V2, 'b-1', 0.6)]);
  assert.deepEqual([simOnly[0]?.baseline.source, simOnly[0]?.baseline.procedure], ['agent-sim', V2]);

  // Gates come sorted by procedure, then landscape; one per group with live runs.
  assert.deepEqual(
    liveGates(scores).map((g) => `${g.procedure} ${g.landscape}`),
    [
      'proa-other@0.1.0 nordwind-handel',
      'proa-relations@0.1.0 stadtwerke-auental',
      'proa-relations@0.1.10 nordwind-handel',
      'proa-relations@0.1.9 nordwind-handel',
      'proa-relations@0.1.99-rc.1 nordwind-handel',
      'proa-relations@0.2.0 nordwind-handel',
      'proa-relations@0.3.0 nordwind-handel',
    ],
  );
});

test('a landscape without must_link pairs has no recall: no recall rule, means skip nulls', () => {
  const [g] = liveGates([
    score(V1, 'agent-sim', null),
    score(V1, 'a-1', null, { precision: null, f1: null }),
    score(V1, 'a-2', null, { precision: 0.5, f1: null }),
    score(V1, 'a-3', null, { precision: 1, f1: null }),
  ]);
  assert.deepEqual(
    [g?.status, g?.recall, g?.precision, g?.f1, g?.baseline.recall, g?.recallDelta],
    ['pass', null, 0.75, null, null, null],
  );
  assert.match(formatLiveGate(g ?? assert.fail()), /recall n\/a \(baseline n\/a from agent-sim/);
});

test('splits and compares procedure versions', () => {
  assert.deepEqual(splitProcedure('proa-relations@0.1.0'), { id: 'proa-relations', version: '0.1.0' });
  assert.deepEqual(splitProcedure('a@b@1.0.0'), { id: 'a@b', version: '1.0.0' });
  assert.deepEqual(splitProcedure('none'), { id: 'none', version: '' });
  assert.ok((compareVersions('0.1.10', '0.1.9') ?? 0) > 0);
  assert.ok((compareVersions('0.9.0', '1.0.0') ?? 0) < 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), null);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), null);
});
