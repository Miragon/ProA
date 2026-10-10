// Tests for the auto-accept what-if of eval:replay (src/auto-accept-whatif.ts,
// owner decision 19): relations on synthetic lines over the `_sample`
// landscape (tiers from the pair assessor, the safeguards in recording order:
// what the rule accepted stays accepted, later competitors and the agent's
// later change of mind do not undo it), placements on a synthetic chain, the
// holdout redaction (aggregate rows only, no tier split, „< 5“, rows hidden
// when a difference between thresholds would reveal a small group, no item
// lists), determinism, and the report sections of the fixture replay.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  RECORDING_FORMAT,
  recordingPath,
  type PlacementRecordingLine,
  type RelationRecordingLine,
} from '@proa/contracts';

import {
  WHAT_IF_HOLDOUT_NOTE,
  WHAT_IF_THRESHOLDS,
  placementWhatIf,
  redactSeries,
  relationWhatIf,
  renderPlacementWhatIf,
  renderRelationWhatIf,
  type WhatIfRow,
} from '../src/auto-accept-whatif.ts';
import { CORPUS_DIR } from '../src/corpus.ts';
import { runLandscape, type LandscapeRun } from '../src/landscape.ts';
import { OUTSIDE, type Golden, type PlacementRun } from '../src/placements-score.ts';
import { parseRecording } from '../src/recordings.ts';
import { renderReplayMarkdown } from '../src/replay-report.ts';
import { replay } from '../src/replay.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/recordings', import.meta.url));
const A = 'vertrieb/auftragsabwicklung';
const R = 'finanzen/rechnungsstellung';
const P = 'finance/payment-collection';

type RelItem = {
  type: string;
  from: string;
  to: string;
  confidence: number;
  question?: string | null;
};
type Answer = NonNullable<RelationRecordingLine['result']>['items'][number]['result'];

function relationLine(
  modelKey: string,
  items: Array<[RelItem, Answer]>,
  noLinks: Array<{ type: string; from: string; to: string }> = [],
  rev = 1,
): RelationRecordingLine {
  return {
    format: RECORDING_FORMAT,
    landscape: 'sample',
    modelKey,
    rev,
    agent: 'whatif-agent',
    procedure: { id: 'proa-relations', version: '9.9.9' },
    llmModel: 'model-x',
    submission: {
      relations: items.map(([i]) => ({
        type: i.type,
        from: i.from,
        to: i.to,
        confidence: i.confidence,
        rationale: 'r',
        evidence: [],
        question: i.question ?? null,
      })),
      noLinks: noLinks.map((n) => ({ ...n, reason: 'unrelated' })),
      summary: null,
      costUsd: null,
    },
    outcome: 'submitted',
    result: {
      replayed: false,
      counts: { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 },
      withdrawn: 0,
      items: items.map(([, result], index) => ({ index, result, status: 'proposed' })),
      noLinks: {
        items: noLinks.map((_, index) => ({ index, result: 'stored' })),
        counts: { stored: noLinks.length, duplicate: 0, invalid: 0 },
      },
      withdrawnNoLinks: 0,
      uncovered: { count: 0 },
    },
  } as unknown as RelationRecordingLine;
}

function recordingOf(lines: Array<RelationRecordingLine | PlacementRecordingLine>) {
  const first = lines[0];
  assert.ok(first);
  return parseRecording(recordingPath(first), lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
}

let sampleRun: LandscapeRun | undefined;
async function sample(): Promise<LandscapeRun> {
  sampleRun ??= await runLandscape(path.join(CORPUS_DIR, '_sample'));
  return sampleRun;
}

function relationRecording() {
  return recordingOf([
    relationLine(A, [
      // must_link, key tier: accepted at every threshold.
      [
        {
          type: 'message',
          from: `${A}#Event_WareVersandbereit`,
          to: `${R}#Start_WareVersandbereit`,
          confidence: 0.97,
        },
        'applied',
      ],
      // must_link, accepted from 0.8 to 0.9.
      [
        {
          type: 'signal',
          from: `${R}#End_RechnungsstellungAbgeschlossen`,
          to: `${A}#Start_RechnungsstellungAbgeschlossen`,
          confidence: 0.92,
        },
        'applied',
      ],
      // A question: never accepted (unlisted, it would be wrong).
      [
        {
          type: 'message',
          from: `${A}#Task_AbsageSenden`,
          to: `${P}#Event_PaymentReceived`,
          confidence: 0.95,
          question: 'Wirklich?',
        },
        'applied',
      ],
      // Competes with the rule tier's call from the same element.
      [
        {
          type: 'call',
          from: `${A}#Call_ZahlungAbwickeln`,
          to: `${R}#Process_Rechnungsstellung`,
          confidence: 0.99,
        },
        'applied',
      ],
      // The rule tier accepted it: a duplicate is no new proposal.
      [
        {
          type: 'call',
          from: `${A}#Call_ZahlungAbwickeln`,
          to: `${P}#Process_PaymentCollection`,
          confidence: 1,
        },
        'duplicate',
      ],
      // Same process: the assessor refuses it (the server never records it).
      [
        {
          type: 'trigger',
          from: `${P}#End_InvoicePaid`,
          to: `${P}#Event_InvoiceSent`,
          confidence: 0.99,
        },
        'applied',
      ],
    ]),
    relationLine(
      R,
      [
        // must_link, but a valid no-link on the pair: never accepted.
        [
          {
            type: 'message',
            from: `${R}#Event_RechnungVersendet`,
            to: `${P}#Event_InvoiceSent`,
            confidence: 0.96,
          },
          'applied',
        ],
        // Unlisted in a closed world: wrong, from 0.8 only.
        [
          {
            type: 'call',
            from: `${R}#Call_Mahnwesen`,
            to: `${P}#Process_PaymentCollection`,
            confidence: 0.85,
          },
          'applied',
        ],
        // must_link, reopened counts like applied; 0.5 is below every threshold first, then 0.96.
        [
          {
            type: 'signal',
            from: `${R}#End_RechnungsstellungAbgeschlossen`,
            to: `${P}#Start_InvoicingCompleted`,
            confidence: 0.5,
          },
          'applied',
        ],
        [
          {
            type: 'signal',
            from: `${R}#End_RechnungsstellungAbgeschlossen`,
            to: `${P}#Start_InvoicingCompleted`,
            confidence: 0.96,
          },
          'reopened',
        ],
        [
          {
            type: 'message',
            from: `${A}#End_WareVersandbereit`,
            to: `${R}#Start_WareVersandbereit`,
            confidence: 1,
          },
          'invalid:type-mismatch',
        ],
      ],
      [{ type: 'message', from: `${R}#Event_RechnungVersendet`, to: `${P}#Event_InvoiceSent` }],
    ),
  ]);
}

const rowOf = (rows: readonly WhatIfRow[], threshold: number, tier: string) =>
  rows.find((r) => r.threshold === threshold && r.tier === tier)?.counts;

test('relations: the first new proposal at the threshold, the tier of the assessor, the offline safeguards', async () => {
  const w = relationWhatIf(relationRecording(), await sample());
  assert.equal(w.split, 'dev');
  assert.equal(w.rows.length, WHAT_IF_THRESHOLDS.length * 4);
  assert.deepEqual(rowOf(w.rows, 0.8, 'all'), {
    wouldAccept: 4,
    correct: 3,
    acceptable: 0,
    wrong: 1,
    traps: 0,
    unknown: 0,
    precision: 0.75,
  });
  assert.deepEqual(rowOf(w.rows, 0.9, 'all'), {
    wouldAccept: 3,
    correct: 3,
    acceptable: 0,
    wrong: 0,
    traps: 0,
    unknown: 0,
    precision: 1,
  });
  assert.equal(rowOf(w.rows, 0.95, 'all')?.wouldAccept, 2);
  // The tiers partition `all` here (no pair competes with a pair of another tier).
  for (const t of WHAT_IF_THRESHOLDS) {
    const sum = ['key', 'lexical', 'semantic'].reduce(
      (n, tier) => n + (rowOf(w.rows, t, tier)?.wouldAccept ?? 0),
      0,
    );
    assert.equal(sum, rowOf(w.rows, t, 'all')?.wouldAccept, String(t));
  }
  // The rule tier's own pairs are key pairs for the assessor.
  assert.equal(rowOf(w.rows, 0.95, 'key')?.wouldAccept, 2);
  assert.deepEqual(w.excluded, { competingCall: 1, question: 1, noLink: 1 });
  assert.deepEqual(
    w.items?.map((i) => [i.type, i.from, i.to, i.class, i.expect, i.confidence]),
    [['call', `${R}#Call_Mahnwesen`, `${P}#Process_PaymentCollection`, 'wrong', 'unlisted', 0.85]],
  );
  assert.equal(w.note, undefined);
  // Deterministic.
  assert.deepEqual(relationWhatIf(relationRecording(), await sample()), w);
});

test('relations, holdout: aggregate rows only, small rows and exclusions redacted, no items', async () => {
  const run = await sample();
  const w = relationWhatIf(relationRecording(), {
    ...run,
    meta: { ...run.meta, split: 'holdout' },
  });
  assert.equal(w.split, 'holdout');
  assert.equal(w.items, undefined);
  assert.equal(w.note, WHAT_IF_HOLDOUT_NOTE);
  // The `all` tier only, and every row holds fewer than 5 would-accept items here.
  assert.deepEqual(
    w.rows.map((r) => [r.threshold, r.tier, r.redacted]),
    WHAT_IF_THRESHOLDS.map((t) => [t, 'all', 'small']),
  );
  assert.ok(w.rows.every((r) => r.counts === null));
  assert.deepEqual(w.excluded, { competingCall: null, question: null, noLink: null });
  const md = renderRelationWhatIf([w]);
  assert.match(md, /\| 0\.8 \| all \| < 5 \| – \| – \| – \| – \| – \|/);
  assert.match(
    md,
    /excluded at ≥ 0\.8: < 5 competing calls, < 5 with a question, < 5 with a no-link\./,
  );
  assert.doesNotMatch(md, /Call_Mahnwesen|Event_WareVersandbereit|Wrong and trap pairs/);
});

const MAHNWESEN = `${R}#Call_Mahnwesen`;
const callTo = (to: string, confidence = 0.95): RelItem => ({
  type: 'call',
  from: MAHNWESEN,
  to,
  confidence,
});
const SENT: RelItem = {
  type: 'message',
  from: `${R}#Event_RechnungVersendet`,
  to: `${P}#Event_InvoiceSent`,
  confidence: 0.96,
};

test('relations in recording order: an accepted call blocks a later competing call', async () => {
  const w = relationWhatIf(
    recordingOf([
      relationLine(R, [[callTo(`${P}#Process_PaymentCollection`), 'applied']]),
      relationLine(R, [[callTo(`${A}#Process_Auftragsabwicklung`), 'applied']]),
    ]),
    await sample(),
  );
  // The first call is accepted when it is recorded; the second competes with it.
  assert.equal(rowOf(w.rows, 0.8, 'all')?.wouldAccept, 1);
  assert.deepEqual(w.excluded, { competingCall: 1, question: 0, noLink: 0 });
  assert.deepEqual(
    w.items?.map((i) => i.to),
    [`${P}#Process_PaymentCollection`],
  );
  // Proposed together, neither is accepted (each competes with the other, as on the server).
  const together = relationWhatIf(
    recordingOf([
      relationLine(R, [
        [callTo(`${P}#Process_PaymentCollection`), 'applied'],
        [callTo(`${A}#Process_Auftragsabwicklung`), 'applied'],
      ]),
    ]),
    await sample(),
  );
  assert.equal(rowOf(together.rows, 0.8, 'all')?.wouldAccept, 0);
  assert.equal(together.excluded.competingCall, 2);
});

test('relations in recording order: a later no-link of the agent does not undo an acceptance', async () => {
  const later = relationWhatIf(
    recordingOf([
      relationLine(R, [[SENT, 'applied']]),
      relationLine(R, [], [{ type: SENT.type, from: SENT.from, to: SENT.to }]),
    ]),
    await sample(),
  );
  assert.deepEqual(rowOf(later.rows, 0.95, 'all'), {
    wouldAccept: 1,
    correct: 1,
    acceptable: 0,
    wrong: 0,
    traps: 0,
    unknown: 0,
    precision: 1,
  });
  assert.equal(later.excluded.noLink, 0);
  // A no-link recorded before (from the partner model's analysis) is live and blocks.
  const before = relationWhatIf(
    recordingOf([
      relationLine(P, [], [{ type: SENT.type, from: SENT.from, to: SENT.to }]),
      relationLine(R, [[SENT, 'applied']]),
    ]),
    await sample(),
  );
  assert.equal(rowOf(before.rows, 0.8, 'all')?.wouldAccept, 0);
  assert.equal(before.excluded.noLink, 1);
  // A new revision of that model withdraws the no-link first.
  const superseded = relationWhatIf(
    recordingOf([
      relationLine(P, [], [{ type: SENT.type, from: SENT.from, to: SENT.to }]),
      relationLine(P, [], [], 2),
      relationLine(R, [[SENT, 'applied']]),
    ]),
    await sample(),
  );
  assert.equal(rowOf(superseded.rows, 0.8, 'all')?.wouldAccept, 1);
  // The agent's own no-link from the same model's analysis replaces its proposal: not live, not accepted.
  const replaced = relationWhatIf(
    recordingOf([
      relationLine(R, [[{ ...SENT, confidence: 0.7 }, 'applied']]),
      relationLine(R, [], [{ type: SENT.type, from: SENT.from, to: SENT.to }]),
      relationLine(P, [[SENT, 'applied']]),
    ]),
    await sample(),
  );
  assert.equal(rowOf(replaced.rows, 0.8, 'all')?.wouldAccept, 0);
  assert.equal(replaced.excluded.noLink, 1);
});

test('holdout rows: small ones and those a difference between thresholds would reveal are redacted', () => {
  const counts = (wouldAccept: number) => ({
    wouldAccept,
    correct: wouldAccept,
    acceptable: 0,
    wrong: 0,
    traps: 0,
    unknown: 0,
    precision: wouldAccept === 0 ? null : 1,
  });
  const series = (...ns: number[]): WhatIfRow[] =>
    ns.map((n, i) => ({
      threshold: WHAT_IF_THRESHOLDS[i] ?? 1,
      tier: 'all',
      counts: counts(n),
    }));
  const shown = (r: WhatIfRow[]) =>
    r.map((x) => (x.counts === null ? (x.redacted ?? 'missing') : x.counts.wouldAccept));
  // 12 − 9 = 3 would reveal 3 items between 0.8 and 0.9; 12 − 7 = 5 does not.
  assert.deepEqual(shown(redactSeries(series(12, 9, 7))), [12, 'difference', 7]);
  assert.deepEqual(shown(redactSeries(series(12, 10, 3))), [12, 'difference', 'small']);
  assert.deepEqual(shown(redactSeries(series(20, 20, 6))), [20, 20, 6]);
  assert.deepEqual(shown(redactSeries(series(30, 26, 21))), [30, 'difference', 21]);
  assert.deepEqual(shown(redactSeries(series(4, 0, 0))), ['small', 'small', 'small']);
  // The marker tells a hidden row from a small one in the report.
  const md = renderRelationWhatIf([
    {
      file: 'x.jsonl',
      procedure: 'proa-relations@9.9.9',
      agent: 'a',
      llmModel: 'm',
      landscape: 'l',
      split: 'holdout',
      rows: redactSeries(series(12, 9, 3)),
      excluded: { competingCall: null, question: 5, noLink: null },
      note: WHAT_IF_HOLDOUT_NOTE,
    },
  ]);
  assert.match(md, /\| 0\.8 \| all \| 12 \|/);
  assert.match(md, /\| 0\.9 \| all \| hidden \| – \|/);
  assert.match(md, /\| 0\.95 \| all \| < 5 \| – \|/);
});

// ---------------------------------------------------------------- placements

const HASH = '0'.repeat(64);
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
    {
      process: 'm/p1#P1',
      name: 'Prozess Eins',
      must: 'a-1',
      may: [],
      mustNot: ['a-2'],
      tags: [],
      supersededBy: null,
    },
    {
      process: 'm/p2#P2',
      name: 'Archiv',
      must: OUTSIDE,
      may: [],
      mustNot: [],
      tags: [],
      supersededBy: null,
    },
    // Named like step b-2: the rule tier proposes b-2.
    {
      process: 'm/p3#P3',
      name: 'Bravo Zwei',
      must: 'b-2',
      may: [],
      mustNot: [],
      tags: [],
      supersededBy: null,
    },
    {
      process: 'm/p4#P4',
      name: 'Vier',
      must: 'area-c',
      may: [],
      mustNot: [],
      tags: [],
      supersededBy: null,
    },
    {
      process: 'm/p5#P5',
      name: 'Fünf',
      must: 'b-1',
      may: ['b-2'],
      mustNot: ['area-a'],
      tags: [],
      supersededBy: null,
    },
    {
      process: 'm/p6#P6',
      name: 'Sechs',
      must: 'a-2',
      may: [],
      mustNot: [],
      tags: [],
      supersededBy: null,
    },
    {
      process: 'm/p7#P7',
      name: 'Sieben',
      must: 'a-1',
      may: [],
      mustNot: [],
      tags: [],
      supersededBy: null,
    },
    {
      process: 'm/p8#P8',
      name: 'Acht',
      must: 'b-1',
      may: ['b-2'],
      mustNot: [],
      tags: [],
      supersededBy: null,
    },
  ],
};

function placementRun(split: 'dev' | 'holdout' = 'dev'): PlacementRun {
  return {
    name: 'synthetic',
    split,
    golden: GOLDEN,
    chainSteps: GOLDEN.steps.map((s) => ({
      id: s.id,
      name: s.name,
      parentId: s.parent,
      link: null,
    })),
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

type PlItem = { process: string; step: string; confidence: number; question?: string | null };
type PlAnswer = NonNullable<PlacementRecordingLine['result']>['items'][number]['result'];

function placementLine(items: Array<[PlItem, PlAnswer]>): PlacementRecordingLine {
  return {
    format: RECORDING_FORMAT,
    kind: 'placement',
    landscape: 'synthetic',
    valueChain: { key: 'main', rev: 1, contentHash: HASH },
    agent: 'whatif-agent',
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
      unsure: [],
      summary: null,
      costUsd: null,
    },
    outcome: 'submitted',
    result: {
      replayed: false,
      counts: { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 },
      withdrawn: 0,
      items: items.map(([, result], index) => ({ index, result, status: 'proposed' })),
      unsure: { items: [], counts: { stored: 0, duplicate: 0, invalid: 0 } },
      skipped: { count: 0 },
      followUp: false,
    },
  } as unknown as PlacementRecordingLine;
}

function placementRecording() {
  return recordingOf([
    placementLine([
      [{ process: 'm/p1#P1', step: 'a-1', confidence: 0.96 }, 'applied'], // hit, every threshold
      [{ process: 'm/p2#P2', step: OUTSIDE, confidence: 0.99 }, 'applied'], // never @outside
      [{ process: 'm/p3#P3', step: 'b-1', confidence: 0.9 }, 'applied'], // the rule tier names b-2
      [{ process: 'm/p4#P4', step: 'area-c', confidence: 0.85 }, 'applied'], // hit at 0.8
      [{ process: 'm/p5#P5', step: 'a-2', confidence: 0.88 }, 'applied'], // trap at 0.8
      [
        { process: 'm/p6#P6', step: 'a-2', confidence: 0.93, question: 'Welcher Schritt?' },
        'applied',
      ],
      [{ process: 'm/p7#P7', step: 'a-1', confidence: 0.9 }, 'applied'], // two steps
      [{ process: 'm/p7#P7', step: 'b-1', confidence: 0.7 }, 'applied'],
      [{ process: 'm/p8#P8', step: 'b-2', confidence: 0.91 }, 'reopened'], // may: acceptable
      [{ process: 'm/p1#P1', step: 'b-2', confidence: 0.5 }, 'invalid:unknown-step'],
    ]),
    placementLine([
      // A duplicate of P4 with a higher confidence is no new proposal.
      [{ process: 'm/p4#P4', step: 'area-c', confidence: 0.99 }, 'duplicate'],
    ]),
  ]);
}

test('placements: first new item per process, never @outside, competing steps, questions', () => {
  const w = placementWhatIf(placementRecording(), placementRun());
  assert.deepEqual(
    w.rows.map((r) => [r.threshold, r.tier, r.counts]),
    [
      [
        0.8,
        'all',
        {
          wouldAccept: 4,
          correct: 2,
          acceptable: 1,
          wrong: 0,
          traps: 1,
          unknown: 0,
          precision: 2 / 3,
        },
      ],
      [
        0.9,
        'all',
        { wouldAccept: 2, correct: 1, acceptable: 1, wrong: 0, traps: 0, unknown: 0, precision: 1 },
      ],
      [
        0.95,
        'all',
        { wouldAccept: 1, correct: 1, acceptable: 0, wrong: 0, traps: 0, unknown: 0, precision: 1 },
      ],
    ],
  );
  assert.deepEqual(w.excluded, { outside: 1, competingStep: 2, question: 1 });
  assert.deepEqual(
    w.items?.map((i) => [i.process, i.step, i.class, i.placement, i.confidence]),
    [['m/p5#P5', 'a-2', 'trap', 'trap', 0.88]],
  );
  assert.deepEqual(placementWhatIf(placementRecording(), placementRun()), w);
  const md = renderPlacementWhatIf([w]);
  assert.match(md, /## Auto-accept what-if \(placements\)/);
  assert.match(
    md,
    /excluded at ≥ 0\.8: 1 on `@outside`, 2 with a competing step, 1 with a question\./,
  );
  assert.match(md, /- m\/p5#P5 → `a-2` \(trap: trap; confidence 0\.88\)/);
});

test('placements in recording order: the accepted step stays home; a re-judgement withdraws the old one first', () => {
  const run = placementRun();
  const recording = recordingOf([
    placementLine([
      [{ process: 'm/p1#P1', step: 'a-1', confidence: 0.95 }, 'applied'], // hit
      [{ process: 'm/p7#P7', step: 'a-1', confidence: 0.85 }, 'applied'], // hit, below 0.9
    ]),
    // A later task judges both again on other steps (its submission withdraws the old ones).
    placementLine([
      [{ process: 'm/p1#P1', step: 'a-2', confidence: 0.95 }, 'applied'], // trap
      [{ process: 'm/p7#P7', step: 'b-1', confidence: 0.92 }, 'applied'], // wrong
    ]),
  ]);
  const w = placementWhatIf(recording, run);
  const counts = (t: number) => w.rows.find((r) => r.threshold === t)?.counts;
  // At 0.8 both first steps are accepted and stay home: the re-judgements are blocked.
  assert.deepEqual(
    [counts(0.8)?.wouldAccept, counts(0.8)?.correct, counts(0.8)?.wrong, counts(0.8)?.traps],
    [2, 2, 0, 0],
  );
  // At 0.9 P7's first step did not qualify and was withdrawn: its second one is accepted.
  assert.deepEqual(
    [counts(0.9)?.wouldAccept, counts(0.9)?.correct, counts(0.9)?.wrong],
    [2, 1, 1],
  );
  assert.deepEqual(w.excluded, { outside: 0, competingStep: 0, question: 0 });
  assert.deepEqual(w.items, []);
});

test('placements, holdout: aggregate rows only, redacted, no items', () => {
  const w = placementWhatIf(placementRecording(), placementRun('holdout'));
  assert.equal(w.items, undefined);
  assert.equal(w.note, WHAT_IF_HOLDOUT_NOTE);
  assert.ok(w.rows.every((r) => r.counts === null));
  assert.deepEqual(w.excluded, { outside: null, competingStep: null, question: null });
  const md = renderPlacementWhatIf([w]);
  assert.doesNotMatch(md, /m\/p\d#P\d|Wrong and trap/);
  assert.match(md, /\| 0\.95 \| all \| < 5 \| – \| – \| – \| – \| – \|/);
});

test('eval:replay adds the what-if: replay.json key and the section after the relation recordings', async () => {
  const report = await replay(FIXTURES, CORPUS_DIR);
  assert.deepEqual(report.autoAcceptWhatIf?.thresholds, [...WHAT_IF_THRESHOLDS]);
  assert.equal(report.autoAcceptWhatIf?.relations.length, 1);
  assert.deepEqual(report.autoAcceptWhatIf?.placements, []);
  const md = renderReplayMarkdown(report);
  const at = md.indexOf('## Auto-accept what-if (relations)');
  assert.ok(at > md.indexOf('## proa-relations@0.0.1 / fixture-agent / fixture-model / sample'));
  assert.match(md, /### proa-relations@0\.0\.1 \/ fixture-agent \/ fixture-model \/ sample\n/);
  assert.equal(renderReplayMarkdown(await replay(FIXTURES, CORPUS_DIR)), md);
});
