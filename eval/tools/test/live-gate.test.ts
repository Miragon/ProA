// Tests for the live gate (src/live-gate.ts) on synthetic scores: status
// (pass, fail, incomplete), one gate per procedure version, landscape and
// declared model, the baseline (previous version's live runs with the same
// model, else the agent-sim recordings of the same version, any model), the
// 5-point boundary, the 0.8 rule and landscapes without must_link pairs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_RECALL_DROP,
  MIN_LIVE_RUNS,
  compareVersions,
  SIM_AGENT,
  formatLiveGate,
  gateLabel,
  liveGates,
  splitProcedure,
  type LiveGateInput,
} from '../src/live-gate.ts';

let n = 0;

/** The declared model of the live runs unless a test names another. */
const MODEL = 'claude-model-a';

/**
 * A replay score with what the gate reads; `hits` are the confidences of
 * must_not_link proposals. Live runs declare {@link MODEL} by default, each
 * `agent-sim` recording a model of its own (the sim baseline takes any).
 */
function score(
  procedure: string,
  agent: string,
  recall: number | null,
  options: { landscape?: string; llmModel?: string; precision?: number | null; f1?: number | null; hits?: number[] } = {},
): LiveGateInput {
  const landscape = options.landscape ?? 'nordwind-handel';
  n++;
  const llmModel = options.llmModel ?? (agent === SIM_AGENT ? `sim-policy-${n}` : MODEL);
  return {
    file: `${procedure}/${agent}/${llmModel}/${landscape}.jsonl`,
    procedure,
    agent,
    llmModel,
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
    [g.procedure, g.landscape, g.llmModel, g.status, g.runs, g.mustNotLinkHighConfidence, g.reasons],
    [V1, 'nordwind-handel', MODEL, 'pass', 3, 0, []],
  );
  assert.ok(Math.abs((g.recall ?? 0) - 0.75) < 1e-12);
  assert.ok(Math.abs((g.precision ?? 0) - 0.8) < 1e-12);
  assert.ok(Math.abs((g.f1 ?? 0) - 0.75) < 1e-12);
  assert.deepEqual(
    [g.baseline.source, g.baseline.procedure, g.baseline.runs, g.baseline.recall],
    ['agent-sim', V1, 1, 0.75],
  );
  assert.deepEqual(g.liveRuns.map((r) => r.agent), ['claude-code-1', 'claude-desktop-1', 'claude-desktop-2'].sort());
  assert.equal(gateLabel(g), `${V1} / nordwind-handel / ${MODEL}`);
  assert.match(
    formatLiveGate(g),
    /^live gate proa-relations@0\.1\.0 \/ nordwind-handel \/ claude-model-a \(dev\): pass; 3 runs, .*baseline 75\.0 % from agent-sim proa-relations@0\.1\.0/,
  );
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
  assert.equal(
    none?.reasons[0],
    'no baseline: no live runs of an earlier version with this llmModel and no agent-sim recording of this version',
  );
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

  // Gates come sorted by procedure, then landscape, then model; one per group with live runs.
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

test('gates every declared model on its own: runs, means and the 0.8 rule do not mix', () => {
  const gates = liveGates([
    score(V1, 'agent-sim', 0.75),
    score(V1, 'claude-code-1', 0.8, { llmModel: 'claude-model-a' }),
    score(V1, 'claude-code-2', 0.8, { llmModel: 'claude-model-a' }),
    score(V1, 'claude-code-3', 0.8, { llmModel: 'claude-model-a' }),
    score(V1, 'claude-desktop-1', 0.5, { llmModel: 'claude-model-b', hits: [0.9] }),
    score(V1, 'claude-desktop-2', 0.9, { llmModel: 'claude-model-b' }),
    score(V1, 'claude-code-1', 0.9, { landscape: 'stadtwerke-auental', llmModel: 'claude-model-a' }),
  ]);
  assert.deepEqual(
    gates.map((g) => [gateLabel(g), g.status, g.runs, g.mustNotLinkHighConfidence, g.liveRuns.map((r) => r.agent)]),
    [
      [`${V1} / nordwind-handel / claude-model-a`, 'pass', 3, 0, ['claude-code-1', 'claude-code-2', 'claude-code-3']],
      [`${V1} / nordwind-handel / claude-model-b`, 'fail', 2, 1, ['claude-desktop-1', 'claude-desktop-2']],
      [`${V1} / stadtwerke-auental / claude-model-a`, 'incomplete', 1, 0, ['claude-code-1']],
    ],
  );
  // Model b's 0.5 does not pull model a's mean down; both take the agent-sim baseline of the version.
  assert.ok(Math.abs((gates[0]?.recall ?? 0) - 0.8) < 1e-12);
  assert.ok(Math.abs((gates[1]?.recall ?? 0) - 0.7) < 1e-12);
  assert.deepEqual(
    gates.slice(0, 2).map((g) => [g.baseline.source, g.baseline.recall]),
    [
      ['agent-sim', 0.75],
      ['agent-sim', 0.75],
    ],
  );
  // Three runs of the version, but only two per model: neither model passes on them.
  const split = liveGates([
    score(V1, 'agent-sim', 0.75),
    score(V1, 'a-1', 0.8, { llmModel: 'claude-model-a' }),
    score(V1, 'a-2', 0.8, { llmModel: 'claude-model-a' }),
    score(V1, 'a-3', 0.8, { llmModel: 'claude-model-b' }),
  ]);
  assert.deepEqual(
    split.map((g) => [g.llmModel, g.status, g.reasons]),
    [
      ['claude-model-a', 'incomplete', ['2 of 3 runs']],
      ['claude-model-b', 'incomplete', ['1 of 3 runs']],
    ],
  );
});

test("takes the previous version's baseline from runs with the same llmModel only, else agent-sim of any model", () => {
  const scores = [
    // 0.1.9 with model a, 0.1.10 with model b only: for model a the highest earlier version is 0.1.9.
    score('proa-relations@0.1.9', 'a-1', 0.9, { llmModel: 'claude-model-a' }),
    score('proa-relations@0.1.9', 'a-2', 0.7, { llmModel: 'claude-model-a' }),
    score('proa-relations@0.1.10', 'b-1', 0.2, { llmModel: 'claude-model-b' }),
    // Model a on another landscape: not its baseline.
    score('proa-relations@0.1.10', 'a-1', 0.1, { llmModel: 'claude-model-a', landscape: 'stadtwerke-auental' }),
    score(V2, 'agent-sim', 0.6, { llmModel: 'sim-policy-1' }),
    ...[0.8, 0.8, 0.8].map((r, i) => score(V2, `a-${i}`, r, { llmModel: 'claude-model-a' })),
    ...[0.8, 0.8, 0.8].map((r, i) => score(V2, `b-${i}`, r, { llmModel: 'claude-model-b' })),
    ...[0.8, 0.8, 0.8].map((r, i) => score(V2, `c-${i}`, r, { llmModel: 'claude-model-c' })),
  ];
  const v2 = liveGates(scores).filter((g) => g.procedure === V2);
  assert.deepEqual(
    v2.map((g) => [g.llmModel, g.status, g.baseline.source, g.baseline.procedure, g.baseline.runs, g.baseline.files]),
    [
      [
        'claude-model-a',
        'pass',
        'previous-version',
        'proa-relations@0.1.9',
        2,
        ['proa-relations@0.1.9/a-1/claude-model-a/nordwind-handel.jsonl', 'proa-relations@0.1.9/a-2/claude-model-a/nordwind-handel.jsonl'],
      ],
      ['claude-model-b', 'pass', 'previous-version', 'proa-relations@0.1.10', 1, ['proa-relations@0.1.10/b-1/claude-model-b/nordwind-handel.jsonl']],
      // No earlier run with model c: the simulation agent's recording of the version, whatever its model.
      ['claude-model-c', 'pass', 'agent-sim', V2, 1, ['proa-relations@0.2.0/agent-sim/sim-policy-1/nordwind-handel.jsonl']],
    ],
  );
  assert.ok(Math.abs((v2[0]?.baseline.recall ?? 0) - 0.8) < 1e-12);
  assert.match(formatLiveGate(v2[0] ?? assert.fail()), /baseline 80\.0 % from 2 live runs of proa-relations@0\.1\.9/);

  // Model a drops more than 5 points below its own previous runs: fail, though model b's runs were far lower.
  const drop = liveGates([...scores.slice(0, 5), ...[0.7, 0.7, 0.8].map((r, i) => score(V2, `a-${i}`, r, { llmModel: 'claude-model-a' }))]);
  assert.deepEqual(
    drop.filter((g) => g.procedure === V2).map((g) => [g.llmModel, g.status]),
    [['claude-model-a', 'fail']],
  );

  // A model without earlier runs and without a sim recording of the version has no baseline.
  const [none] = liveGates([score('proa-relations@0.1.9', 'a-1', 0.9), score(V2, 'c-1', 0.8, { llmModel: 'claude-model-c' })]).filter(
    (g) => g.procedure === V2,
  );
  assert.deepEqual([none?.baseline.source, none?.status], ['none', 'incomplete']);
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
