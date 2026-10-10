// Tests for the placement part of eval:replay (src/placements-replay.ts,
// placements-replay-report.ts, placement-live-gate.ts) on a synthetic chain
// with known answers, and on the committed recordings of the simulation agent:
// the union of valid items ranked by confidence, the comparability check, the
// holdout redaction, the report sections and the placement live gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RECORDING_FORMAT,
  recordingPath,
  type PlacementRecordingLine,
} from '@proa/contracts';
import { getProcedure } from '@proa/procedures';

import {
  PLACEMENT_RECALL_MARGIN,
  formatPlacementLiveGate,
  placementBar,
  placementLiveGates,
  type PlacementGateBaselines,
  type PlacementGateInput,
} from '../src/placement-live-gate.ts';
import { renderPlacementReplaySections } from '../src/placements-replay-report.ts';
import {
  NotComparableError,
  PLACEMENT_HOLDOUT_NOTE,
  placementBaselines,
  rankedPlacements,
  scorePlacementRecording,
  type PlacementNumbers,
} from '../src/placements-replay.ts';
import { HOLDOUT_MIN_GROUP, OUTSIDE, type Golden, type PlacementRun } from '../src/placements-score.ts';
import { parseRecording, recordingKind } from '../src/recordings.ts';
import { renderReplayMarkdown } from '../src/replay-report.ts';
import { replay } from '../src/replay.ts';

const HASH = '0'.repeat(64);

// A synthetic chain: areas a, b (with sub-steps) and c (a top-level leaf).
const GOLDEN: Golden = {
  landscape: 'synthetic',
  contentHash: HASH,
  steps: [
    { id: 'area-a', name: 'Alpha', kind: 'core', level: 0, parent: null },
    { id: 'a-1', name: 'Alpha Eins', kind: 'core', level: 1, parent: 'area-a' },
    { id: 'a-2', name: 'Alpha Zwei', kind: 'core', level: 1, parent: 'area-a' },
    { id: 'area-b', name: 'Bravo', kind: 'core', level: 0, parent: null },
    { id: 'b-1', name: 'Bravo Eins', kind: 'core', level: 1, parent: 'area-b' },
    { id: 'b-2', name: 'Bravo Zwei', kind: 'core', level: 1, parent: 'area-b' },
    { id: 'area-c', name: 'Charlie', kind: 'support', level: 0, parent: null },
  ],
  placements: [
    { process: 'm/p1#P1', name: 'Prozess Eins', must: 'a-1', may: ['b-1'], mustNot: ['a-2'], tags: ['name-match'], supersededBy: null },
    { process: 'm/p2#P2', name: 'Archiv', must: OUTSIDE, may: [], mustNot: ['area-b'], tags: ['outdated-copy'], supersededBy: 'm/p1#P1' },
    { process: 'm/p3#P3', name: 'Bravo Zwei', must: 'b-2', may: [], mustNot: [], tags: ['name-match'], supersededBy: null },
    { process: 'm/p4#P4', name: 'Vier', must: 'area-c', may: [], mustNot: [], tags: [], supersededBy: null },
  ],
};

function run(split: 'dev' | 'holdout' = 'dev'): PlacementRun {
  return {
    name: 'synthetic',
    split,
    golden: GOLDEN,
    chainSteps: GOLDEN.steps.map((s) => ({ id: s.id, name: s.name, parentId: s.parent, link: null })),
    processes: GOLDEN.placements.map((p) => ({
      ref: p.process,
      label: p.name,
      name: p.name,
      modelKey: p.process.slice(0, p.process.indexOf('#')),
    })),
    neighbours: new Map(),
    validator: { exitCode: 0, summary: [] },
  };
}

type Item = { step: string; process: string; confidence: number; question?: string | null };
type Result = NonNullable<PlacementRecordingLine['result']>;
type Answer = Result['items'][number]['result'];
type UnsureAnswer = Result['unsure']['items'][number]['result'];

/** A placement line with the server's answers per item (synthetic: the chain above). */
function recorded(
  items: Array<[Item, Answer]>,
  unsure: Array<[string, UnsureAnswer]> = [],
  extra: { contentHash?: string; rev?: number; skipped?: number; followUp?: boolean } = {},
): PlacementRecordingLine {
  const answers = items.map(([, a]) => a);
  const count = (a: Answer) => answers.filter((x) => x === a).length;
  return {
    format: RECORDING_FORMAT,
    kind: 'placement',
    landscape: 'synthetic',
    valueChain: { key: 'main', rev: extra.rev ?? 1, contentHash: extra.contentHash ?? HASH },
    agent: 'claude-code-1',
    procedure: { id: 'proa-placements', version: '9.9.9' },
    llmModel: 'model-x',
    submission: {
      placements: items.map(([i]) => ({
        step: i.step,
        process: i.process,
        confidence: i.confidence,
        rationale: 'r',
        evidence: [],
        question: i.question ?? null,
      })),
      unsure: unsure.map(([process]) => ({ process, reason: 'unklar' })),
      summary: null,
      costUsd: null,
    },
    outcome: 'submitted',
    result: {
      replayed: false,
      counts: {
        applied: count('applied'),
        duplicate: count('duplicate'),
        suppressed: count('suppressed'),
        reopened: count('reopened'),
        invalid: answers.filter((a) => a.startsWith('invalid:')).length,
      },
      withdrawn: 0,
      items: answers.map((result, index) => ({
        index,
        result,
        status: result.startsWith('invalid:') ? null : 'proposed',
      })),
      unsure: {
        items: unsure.map(([, result], index) => ({ index, result })),
        counts: {
          stored: unsure.filter(([, a]) => a === 'stored').length,
          duplicate: unsure.filter(([, a]) => a === 'duplicate').length,
          invalid: unsure.filter(([, a]) => a.startsWith('invalid:')).length,
        },
      },
      skipped: { count: extra.skipped ?? 0 },
      followUp: extra.followUp ?? false,
    },
  };
}

function file(lines: PlacementRecordingLine[]) {
  const first = lines[0];
  assert.ok(first);
  return parseRecording(recordingPath(first), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
}

test('ranks the union of valid items per process by confidence, ties by step id', () => {
  const lines = [
    recorded([
      [{ process: 'm/p1#P1', step: 'a-2', confidence: 0.6 }, 'applied'],
      [{ process: 'm/p1#P1', step: 'a-1', confidence: 0.8 }, 'applied'],
      [{ process: 'm/p3#P3', step: 'b-1', confidence: 0.7 }, 'invalid:unknown-step'],
    ]),
    recorded([
      // A follow-up repeats a-2 with a higher confidence: one placement, its highest confidence.
      [{ process: 'm/p1#P1', step: 'a-2', confidence: 0.9 }, 'duplicate'],
      [{ process: 'm/p3#P3', step: 'b-2', confidence: 0.7 }, 'suppressed'],
      [{ process: 'm/p3#P3', step: 'area-b', confidence: 0.7 }, 'reopened'],
    ]),
  ];
  assert.deepEqual(
    rankedPlacements(lines).map((p) => `${p.process} ${p.rank} ${p.step} ${p.confidence}`),
    ['m/p1#P1 1 a-2 0.9', 'm/p1#P1 2 a-1 0.8', 'm/p3#P3 1 area-b 0.7', 'm/p3#P3 2 b-2 0.7'],
  );
});

test('scores a recording: union, ranks, outcomes, unsure, skipped, invalid and the dev lists', () => {
  const f = file([
    recorded(
      [
        [{ process: 'm/p1#P1', step: 'a-2', confidence: 0.85, question: 'Welcher?' }, 'applied'],
        [{ process: 'm/p1#P1', step: 'a-1', confidence: 0.6 }, 'applied'],
        [{ process: 'm/p2#P2', step: OUTSIDE, confidence: 0.9 }, 'applied'],
        [{ process: 'm/p3#P3', step: 'b-1', confidence: 0.5 }, 'invalid:unknown-step'],
      ],
      [
        ['m/p4#P4', 'stored'],
        ['m/p3#P3', 'invalid:also-placed'],
      ],
      { skipped: 1, followUp: true },
    ),
  ]);
  assert.equal(recordingKind(f), 'placement');
  const s = scorePlacementRecording(f, run());
  assert.deepEqual(s.tasks, { lines: 1, submitted: 1, dryRun: 0, failed: 0, followUps: 1 });
  assert.deepEqual(s.items, { total: 4, outcomes: { applied: 3, invalid: 1 }, invalid: { 'unknown-step': 1 } });
  assert.deepEqual([s.questions, s.outside, s.unsure, s.skipped, s.invalid], [1, 1, 1, 1, 2]);
  assert.deepEqual(s.valueChain, { revs: [1], contentHash: HASH });
  const n: PlacementNumbers = s.numbers;
  // p1: a-2 (trap, 0.85) ranked first, a-1 (hit) second; p2: @outside (hit); p3, p4 none.
  assert.equal(n.proposals, 3);
  assert.equal(n.recall, 2 / 4);
  assert.equal(n.recallAt1, 1 / 4);
  assert.equal(n.precisionAt1, 1 / 2);
  assert.equal(n.precision, 2 / 3);
  assert.equal(n.trapsHighConfidence, 1);
  assert.equal(n.trapRate, 1 / 2);
  assert.equal(s.note, undefined);
  assert.deepEqual(
    s.lists?.traps.map((i) => `${i.process} ${i.step}`),
    ['m/p1#P1 a-2'],
  );
  assert.deepEqual(s.lists?.missed, [
    { process: 'm/p3#P3', top: null, class: 'none' },
    { process: 'm/p4#P4', top: null, class: 'unsure' },
  ]);
  assert.deepEqual(s.lists?.unsure, ['m/p4#P4']);
});

test('refuses a recording on an edited chain: not comparable', () => {
  const f = file([
    recorded([[{ process: 'm/p1#P1', step: 'a-1', confidence: 0.9 }, 'applied']]),
    recorded([[{ process: 'm/p3#P3', step: 'b-2', confidence: 0.9 }, 'applied']], [], {
      contentHash: 'f'.repeat(64),
      rev: 2,
    }),
  ]);
  assert.throws(
    () => scorePlacementRecording(f, run()),
    (err: unknown) =>
      err instanceof NotComparableError && /not comparable \(edited chain\): line 2 worked on r2/.test(err.message),
  );
});

test('a holdout recording gives aggregate numbers only', () => {
  const f = file([recorded([[{ process: 'm/p1#P1', step: 'a-2', confidence: 0.9 }, 'applied']])]);
  const s = scorePlacementRecording(f, run('holdout'));
  assert.equal(s.lists, undefined);
  assert.equal(s.system.items, undefined);
  assert.equal(s.note, PLACEMENT_HOLDOUT_NOTE);
  // No tag has HOLDOUT_MIN_GROUP processes here, so none is shown.
  assert.ok(HOLDOUT_MIN_GROUP > 2);
  assert.deepEqual(Object.keys(s.system.byTag), []);
  const md = renderPlacementReplaySections({
    recordings: [s],
    baselines: [placementBaselines('synthetic', run('holdout'))],
    liveGate: [],
  }).join('\n\n');
  assert.doesNotMatch(md, /m\/p1#P1/);
  assert.doesNotMatch(md, /### Traps/);
  assert.match(md, /_holdout: aggregate numbers only/);
});

test('renders the placement sections after the relations sections', () => {
  const f = file([recorded([[{ process: 'm/p1#P1', step: 'a-1', confidence: 0.9 }, 'applied']])]);
  const s = scorePlacementRecording(f, run());
  const baselines = [placementBaselines('synthetic', run())];
  const placements = { recordings: [s], baselines, liveGate: placementLiveGates([s], baselines) };
  const md = renderReplayMarkdown({ recordings: [], liveGate: [], placements });
  assert.match(md, /^# eval:replay\n/);
  assert.match(md, /_No recordings\._\n\n## Placements\n/);
  assert.match(md, /\| proa-placements@9\.9\.9 \/ claude-code-1 \/ model-x \/ synthetic \| dev \| 1 \| 1 \| 100\.0 % \| 25\.0 % \| 25\.0 % \|/);
  assert.match(md, /## Placement live gate\n/);
  assert.match(
    md,
    /- proa-placements@9\.9\.9 \/ synthetic \/ model-x: fail: mean recall@1 25\.0 % is below 70\.0 % \(the better baseline-prefix\/1 row plus 20 points\); 1 of 3 runs/,
  );
  assert.match(md, /### Musts missed/);
  // Without placement recordings the report is the relations report alone.
  assert.equal(
    renderReplayMarkdown({ recordings: [], liveGate: [] }),
    renderReplayMarkdown({ recordings: [], liveGate: [], placements: { recordings: [], baselines: [], liveGate: [] } }),
  );
});

// ------------------------------------------------------------------ live gate

const numbers = (recallAt1: number | null, traps = 0): PlacementNumbers => ({
  proposals: 10,
  precision: 0.8,
  recall: recallAt1,
  recallAt1,
  recallAt3: recallAt1,
  precisionAt1: 0.8,
  areaRecallAt1: 0.9,
  f1: 0.7,
  trapRate: 0,
  trapsHighConfidence: traps,
});

function gateRun(i: number, recallAt1: number | null, traps = 0, extra: Partial<PlacementGateInput> = {}): PlacementGateInput {
  return {
    file: `proa-placements@0.1.0/claude-code-${i}/model-x/nordwind-handel.jsonl`,
    procedure: 'proa-placements@0.1.0',
    agent: `claude-code-${i}`,
    llmModel: 'model-x',
    landscape: 'nordwind-handel',
    split: 'dev',
    numbers: numbers(recallAt1, traps),
    ...extra,
  };
}

const BASELINES: PlacementGateBaselines[] = [
  { landscape: 'nordwind-handel', withVotes: numbers(0.438), withoutVotes: numbers(0.469) },
];

test('the bar is the better baseline row plus 20 points', () => {
  assert.equal(PLACEMENT_RECALL_MARGIN, 0.2);
  assert.ok(Math.abs((placementBar(BASELINES[0]) ?? 0) - 0.669) < 1e-12);
  assert.equal(placementBar(undefined), null);
  assert.equal(
    placementBar({ landscape: 'x', withVotes: numbers(null), withoutVotes: numbers(0.5) }),
    0.7,
  );
});

test('passes with three live runs above the bar; the simulation agent is no live run', () => {
  const runs = [gateRun(1, 0.7), gateRun(2, 0.69), gateRun(3, 0.75), gateRun(4, 0.1, 5, { agent: 'agent-sim' })];
  const [g] = placementLiveGates(runs, BASELINES);
  assert.ok(g);
  assert.equal(g.status, 'pass');
  assert.equal(g.runs, 3);
  assert.ok(Math.abs((g.recallAt1 ?? 0) - 0.7133333) < 1e-6);
  assert.deepEqual(g.reasons, []);
  assert.match(formatPlacementLiveGate(g), /^placement live gate proa-placements@0\.1\.0 \/ nordwind-handel \/ model-x \(dev\): pass; 3 runs, recall@1 71\.3 % \(bar 66\.9 %/);
});

test('fails on a must_not placement at confidence 0.8 or more, or below the bar; incomplete below 3 runs', () => {
  const trap = placementLiveGates([gateRun(1, 0.9, 1)], BASELINES)[0];
  assert.equal(trap?.status, 'fail');
  assert.match(trap?.reasons[0] ?? '', /^1 must_not placement with confidence ≥ 0\.8 \(in 1 of 1 run\)$/);
  assert.match(trap?.reasons[1] ?? '', /^1 of 3 runs$/);
  const low = placementLiveGates([gateRun(1, 0.6), gateRun(2, 0.6), gateRun(3, 0.7)], BASELINES)[0];
  assert.equal(low?.status, 'fail');
  assert.match(low?.reasons[0] ?? '', /^mean recall@1 63\.3 % is below 66\.9 % \(the better baseline-prefix\/1 row plus 20 points\)$/);
  // Exactly on the bar passes.
  const exact = placementLiveGates([gateRun(1, 0.669), gateRun(2, 0.669), gateRun(3, 0.669)], BASELINES)[0];
  assert.equal(exact?.status, 'pass');
  const few = placementLiveGates([gateRun(1, 0.9), gateRun(2, 0.9)], BASELINES)[0];
  assert.equal(few?.status, 'incomplete');
  const none = placementLiveGates([gateRun(1, 0.9), gateRun(2, 0.9), gateRun(3, 0.9)], [])[0];
  assert.equal(none?.status, 'incomplete');
  assert.deepEqual(none?.reasons, ['no baseline-prefix/1 numbers for this landscape']);
});

test('gates every procedure, landscape and declared model on its own', () => {
  const gates = placementLiveGates(
    [gateRun(1, 0.9), gateRun(2, 0.9, 0, { llmModel: 'model-y' }), gateRun(3, 0.9, 0, { procedure: 'proa-placements@0.2.0' })],
    BASELINES,
  );
  assert.deepEqual(
    gates.map((g) => `${g.procedure} ${g.llmModel} ${g.runs}`),
    ['proa-placements@0.1.0 model-x 1', 'proa-placements@0.1.0 model-y 1', 'proa-placements@0.2.0 model-x 1'],
  );
});

// ------------------------------------------------------------ committed recordings

test('scores the committed placement recordings of the simulation agent on the golden chains', async () => {
  const report = await replay();
  const placements = report.placements;
  assert.ok(placements);
  const current = getProcedure('proa-placements');
  assert.ok(current);
  const dir = `${current.id}@${current.version}/agent-sim/sim-policy-1`;
  assert.deepEqual(
    placements.recordings.map((s) => s.file),
    [`${dir}/nordwind-handel.jsonl`, `${dir}/stadtwerke-auental.jsonl`],
  );
  for (const s of placements.recordings) {
    // Every process judged once in one task, nothing invalid, nothing skipped.
    assert.equal(s.tasks.lines, 1, s.file);
    assert.equal(s.tasks.submitted, 1, s.file);
    assert.equal(s.invalid, 0, s.file);
    assert.equal(s.skipped, 0, s.file);
    assert.equal(s.outside, 0, s.file);
    assert.equal(s.numbers.proposals + s.unsure, s.processes, s.file);
    // One home per process: recall@1 is recall.
    assert.equal(s.numbers.recallAt1, s.numbers.recall, s.file);
    if (s.split === 'holdout') {
      assert.equal(s.lists, undefined, s.file);
      assert.equal(s.system.items, undefined, s.file);
    }
  }
  // The baselines are the eval:placements rows.
  assert.deepEqual(placements.baselines.map((b) => b.landscape), ['nordwind-handel', 'stadtwerke-auental']);
  // The simulation agent is no live run.
  assert.deepEqual(placements.liveGate, []);
  // The holdout's placement sections carry no process ref of the holdout.
  const md = renderPlacementReplaySections(placements).join('\n\n');
  const holdout = md.slice(md.indexOf(`## ${dir.replaceAll('/', ' / ')} / stadtwerke-auental`));
  assert.doesNotMatch(holdout, /#Process_|#\w+_\w+/);
});
