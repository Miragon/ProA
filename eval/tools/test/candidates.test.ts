// Tests for the eval:candidates gate (src/candidates.ts, score.ts, report.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Fact, Ref } from '@proa/contracts';

import { evaluate } from '../src/candidates.ts';
import type { LandscapeRun } from '../src/landscape.ts';
import { renderMarkdown } from '../src/report.ts';
import { scoreLandscape } from '../src/score.ts';

test('every scored landscape passes the gate', async () => {
  const report = await evaluate();
  assert.deepEqual(
    report.landscapes.map((s) => [s.name, s.split]),
    [
      ['nordwind-handel', 'dev'],
      ['stadtwerke-auental', 'holdout'],
    ],
  );
  for (const s of report.landscapes) {
    for (const g of s.gates) assert.ok(g.pass, `${s.name}: ${g.title}: ${g.value}`);
    assert.equal(s.ruleTier.precision, 1);
    assert.ok(s.ruleTier.accepted > 0);
  }
  assert.equal(report.pass, true);
  // Deterministic: a second run renders byte-identical output.
  assert.equal(renderMarkdown(await evaluate()), renderMarkdown(report));
});

function fact(ref: Ref, kind: Fact['kind'], processId: string): Fact {
  const [modelKey, elementId] = ref.split('#') as [string, string];
  return {
    modelKey,
    ref,
    kind,
    elementId,
    processId,
    scope: 'process',
    eventDef: null,
    label: '',
    keyRaw: elementId,
    keyNorm: elementId.toLowerCase(),
    fingerprint: '000000000000',
    attrs: {},
  };
}

/** A two-model landscape with one accepted call, one key proposal and a few findings. */
function syntheticRun(): LandscapeRun {
  return {
    meta: { name: 'synthetic', lang: 'en', split: 'dev', closed_world: true },
    expected: {
      relations: [
        { type: 'call', from: 'a/x#Call_1', to: 'b/y#Process_Y', expect: 'must_link', tags: ['call-unique'], rationale: '' },
        { type: 'message', from: 'a/x#Throw_1', to: 'b/y#Catch_1', expect: 'must_link', tags: ['exact-key'], rationale: '' },
        { type: 'message', from: 'a/x#Throw_2', to: 'b/y#Catch_2', expect: 'must_link', tags: ['de-en'], rationale: '' },
        { type: 'message', from: 'a/x#Throw_1', to: 'b/y#Catch_2', expect: 'must_not_link', tags: ['near-miss'], rationale: '' },
      ],
      expected_findings: [
        { kind: 'dangling-throw', refs: ['a/x#Throw_3', 'a/x#Throw_4'], rationale: '' },
        { kind: 'dynamic-call', refs: ['a/x#Call_2'], rationale: '' },
      ],
    },
    facts: {
      models: [
        {
          modelKey: 'a/x',
          factsVersion: '1',
          processes: [],
          messageFlows: [],
          facts: [
            fact('a/x#Call_1', 'call', 'Process_X'),
            fact('a/x#Throw_1', 'msg_throw', 'Process_X'),
            fact('a/x#Throw_2', 'msg_throw', 'Process_X'),
          ],
        },
        {
          modelKey: 'b/y',
          factsVersion: '1',
          processes: [],
          messageFlows: [],
          facts: [fact('b/y#Catch_1', 'msg_catch', 'Process_Y'), fact('b/y#Catch_2', 'msg_catch', 'Process_Y')],
        },
      ],
    },
    rules: {
      relations: [
        { type: 'call', from: 'a/x#Call_1', to: 'b/y#Process_Y', status: 'accepted', tier: 'rule', confidence: 1, attrs: {} },
        { type: 'message', from: 'a/x#Throw_1', to: 'b/y#Catch_1', status: 'proposed', tier: 'key', confidence: 1, attrs: {} },
      ],
      findings: [
        { kind: 'dangling-throw', refs: ['a/x#Throw_3'], detail: '' },
        { kind: 'dangling-throw', refs: ['a/x#Throw_4'], detail: '' },
        { kind: 'dangling-throw', refs: ['a/x#Throw_2'], detail: '' },
        { kind: 'dynamic-call', refs: ['a/x#Call_2'], detail: '' },
      ],
    },
    candidates: [
      {
        type: 'message',
        from: 'a/x#Throw_2',
        to: 'b/y#Catch_2',
        basis: 'compatible',
        score: 0.1,
        signals: {},
      },
    ],
    baseline: [
      { type: 'message', from: 'a/x#Throw_1', to: 'b/y#Catch_2', status: 'proposed', tier: 'lexical', confidence: 1, attrs: {} },
      { type: 'message', from: 'a/x#Throw_1', to: 'a/x#Throw_2', status: 'proposed', tier: 'lexical', confidence: 1, attrs: {} },
    ],
    extraEvents: [],
  };
}

test('scores a passing synthetic landscape', () => {
  const s = scoreLandscape(syntheticRun());
  assert.equal(s.pass, true, JSON.stringify(s.gates));
  assert.deepEqual(s.ruleTier, { accepted: 1, correct: 1, precision: 1, wrong: [] });
  assert.equal(s.systems.candidates.recall, 1);
  assert.equal(s.systems.keyLexical.recall, 2 / 3);
  assert.deepEqual(
    s.mustLinkOnlyCompatible.map((r) => r.from),
    ['a/x#Throw_2'],
  );
  // Expected findings may group refs; they are compared per ref.
  const dangling = s.findings.find((f) => f.kind === 'dangling-throw');
  assert.deepEqual(dangling?.missing, []);
  assert.deepEqual(dangling?.unexpected, []);
  assert.deepEqual(dangling?.explained.map((e) => e.finding), ['a/x#Throw_2']);
  // Baseline: one must_not_link hit, one same-process pair, no must_link.
  assert.equal(s.systems.baseline.mustNotLink, 1);
  assert.equal(s.systems.baseline.sameProcess, 1);
  assert.equal(s.systems.baseline.precision, 0);
  assert.deepEqual(s.byType.message?.mustNotLinkBaseline, 1);
});

test('fails the gates on a wrong acceptance, a missed must_link and an unexplained finding', () => {
  const run = syntheticRun();
  run.rules.relations.push({
    type: 'message',
    from: 'a/x#Throw_1',
    to: 'b/y#Catch_2',
    status: 'accepted',
    tier: 'rule',
    confidence: 1,
    attrs: {},
  });
  run.candidates = [];
  run.rules.findings.push({ kind: 'unmatched-catch', refs: ['b/y#Catch_9'], detail: '' });
  run.rules.findings.push({ kind: 'unresolved-call', refs: ['a/x#Call_1'], detail: '' });
  const s = scoreLandscape(run);
  const failed = s.gates.filter((g) => !g.pass).map((g) => g.id);
  assert.deepEqual(failed, [
    'rule-precision',
    'rule-must-not-link',
    'must-link-recall',
    'findings-exact',
    'findings-judged',
  ]);
  assert.equal(s.pass, false);
  assert.match(renderMarkdown({ pass: false, landscapes: [s] }), /\*\*Result: FAIL\*\*/);
});
