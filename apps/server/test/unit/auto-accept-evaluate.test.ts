/**
 * Auto-accept rules (owner decision 19), pure part: the rule match (every
 * criterion, the inclusive boundary, the first match in creation order) and
 * every safeguard for relations and placements, in their order. Synthetic
 * data only.
 */
import type { AutoAcceptRuleId, PrincipalId } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import {
  evaluatePlacementAutoAccept,
  evaluateRelationAutoAccept,
  matchRule,
  type AutoAcceptRuleRev,
  type HistoryView,
  type PlacementSubjectView,
  type TriggerView,
} from '../../src/domain/auto-accept/evaluate.ts';

const OWNER = 'prn_00000000000000000000OWNER' as PrincipalId;
const AGENT = 'prn_000000000000000000000AGENT' as PrincipalId;
const OTHER = 'prn_000000000000000000000OTHER' as PrincipalId;
const RULES = 'prn_0000000000000000000000RULE' as PrincipalId;
const A1 = 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y1' as AutoAcceptRuleId;
const A2 = 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y2' as AutoAcceptRuleId;

function rule(extra: Partial<AutoAcceptRuleRev> = {}): AutoAcceptRuleRev {
  return {
    ruleId: A1,
    revision: 1,
    kind: 'relation',
    name: 'Schlüssel ab 90 %',
    enabled: true,
    tier: 'key',
    minConfidence: 0.9,
    relationType: null,
    agentPrincipalId: null,
    llmModel: null,
    includeAdHoc: false,
    authorId: OWNER,
    authorClientId: 'proa-web',
    authorIsOwner: true,
    order: 1,
    ...extra,
  };
}

function trigger(extra: Partial<TriggerView> = {}): TriggerView {
  return {
    id: 'asr_T',
    principalId: AGENT,
    sourceKind: 'agent',
    kind: 'proposal',
    tier: 'key',
    confidence: 0.95,
    question: null,
    llmModel: 'sim-1',
    pipeline: true,
    current: true,
    ...extra,
  };
}

let seq = 0;
function h(
  principalId: PrincipalId,
  kind: HistoryView['kind'],
  extra: Partial<HistoryView> = {},
): HistoryView {
  return {
    seq: ++seq,
    kind,
    verdict: kind === 'decision' ? 'accept' : null,
    sourceKind: principalId === RULES ? 'rule' : principalId === OWNER ? 'human' : 'agent',
    principalId,
    tier: kind === 'proposal' ? 'key' : null,
    confidence: kind === 'proposal' ? 0.95 : null,
    question: null,
    ...extra,
  };
}

const proposed = { status: 'proposed', endpointState: 'ok', type: 'message' } as const;

function relation(
  extra: Partial<Parameters<typeof evaluateRelationAutoAccept>[0]> = {},
): ReturnType<typeof evaluateRelationAutoAccept> {
  return evaluateRelationAutoAccept({
    relation: proposed,
    history: [h(AGENT, 'proposal')],
    trigger: trigger(),
    liveNoLinks: 0,
    competingCall: false,
    rules: [rule()],
    ...extra,
  });
}

const reason = (v: ReturnType<typeof relation>) => (v.accept ? 'accept' : v.reason);

describe('the rule match', () => {
  it('accepts at exactly the minimum confidence and not just below it', () => {
    expect(reason(relation({ trigger: trigger({ confidence: 0.9 }) }))).toBe('accept');
    expect(reason(relation({ trigger: trigger({ confidence: 0.8999 }) }))).toBe('no-matching-rule');
    expect(reason(relation({ trigger: trigger({ confidence: null }) }))).toBe('no-matching-rule');
  });

  it('needs the tier, the kind and an enabled rule of an owner', () => {
    expect(reason(relation({ trigger: trigger({ tier: 'lexical' }) }))).toBe('no-matching-rule');
    expect(reason(relation({ rules: [rule({ kind: 'placement', tier: 'lexical' })] }))).toBe(
      'no-matching-rule',
    );
    expect(reason(relation({ rules: [rule({ enabled: false })] }))).toBe('no-matching-rule');
    expect(reason(relation({ rules: [rule({ authorIsOwner: false })] }))).toBe('no-matching-rule');
  });

  it('narrows by relation type, agent and declared model', () => {
    expect(reason(relation({ rules: [rule({ relationType: 'message' })] }))).toBe('accept');
    expect(reason(relation({ rules: [rule({ relationType: 'signal' })] }))).toBe(
      'no-matching-rule',
    );
    expect(reason(relation({ rules: [rule({ agentPrincipalId: AGENT })] }))).toBe('accept');
    expect(reason(relation({ rules: [rule({ agentPrincipalId: OTHER })] }))).toBe(
      'no-matching-rule',
    );
    expect(reason(relation({ rules: [rule({ llmModel: 'sim-1' })] }))).toBe('accept');
    expect(reason(relation({ rules: [rule({ llmModel: 'sim-2' })] }))).toBe('no-matching-rule');
    expect(
      reason(
        relation({ rules: [rule({ llmModel: 'sim-1' })], trigger: trigger({ llmModel: null }) }),
      ),
    ).toBe('no-matching-rule');
  });

  it('takes ad-hoc proposals only when the rule includes them', () => {
    const adHoc = trigger({ pipeline: false });
    expect(reason(relation({ trigger: adHoc }))).toBe('no-matching-rule');
    expect(reason(relation({ trigger: adHoc, rules: [rule({ includeAdHoc: true })] }))).toBe(
      'accept',
    );
  });

  it('records the first matching rule in creation order', () => {
    const first = rule({ ruleId: A2, order: 1, minConfidence: 0.5 });
    const second = rule({ ruleId: A1, order: 2 });
    expect(
      matchRule([second, first], trigger(), { kind: 'relation', relationType: 'message' }),
    ).toBe(first);
    const v = relation({ rules: [second, rule({ ruleId: A2, order: 3, enabled: false })] });
    expect(v.accept && v.rule.ruleId).toBe(A1);
  });
});

describe('relation safeguards', () => {
  it('never lets humans or the rule tier trigger a rule', () => {
    expect(reason(relation({ trigger: trigger({ sourceKind: 'human' }) }))).toBe('not-agent');
    expect(reason(relation({ trigger: trigger({ sourceKind: 'rule' }) }))).toBe('not-agent');
    expect(reason(relation({ trigger: trigger({ kind: 'withdrawal' }) }))).toBe('not-agent');
  });

  it('refuses a stale pipeline proposal', () => {
    expect(reason(relation({ trigger: trigger({ current: false }) }))).toBe('stale-proposal');
  });

  it('accepts only open items with both ends unchanged', () => {
    for (const status of ['held', 'accepted', 'rejected', 'obsolete'] as const) {
      expect(reason(relation({ relation: { ...proposed, status } }))).toBe('not-open');
    }
    for (const endpointState of ['changed', 'missing'] as const) {
      expect(reason(relation({ relation: { ...proposed, endpointState } }))).toBe(
        'endpoint-not-ok',
      );
    }
  });

  it('refuses a call with a competing call, allows message fan-out', () => {
    const call = { ...proposed, type: 'call' };
    expect(reason(relation({ relation: call, competingCall: true }))).toBe('competing-call');
    expect(reason(relation({ relation: call, competingCall: false }))).toBe('accept');
    expect(reason(relation({ competingCall: true }))).toBe('accept');
  });

  it('refuses any human involvement', () => {
    const cases: HistoryView[][] = [
      [h(AGENT, 'proposal'), h(OWNER, 'decision', { verdict: 'accept' })],
      [h(AGENT, 'proposal'), h(OWNER, 'decision', { verdict: 'reject' })],
      [h(AGENT, 'proposal'), h(OWNER, 'decision', { verdict: 'hold' })],
      [h(AGENT, 'proposal'), h(OWNER, 'note')],
      [h(OWNER, 'proposal', { tier: 'manual' }), h(AGENT, 'proposal')],
      [
        h(AGENT, 'proposal'),
        h(OWNER, 'decision', { autoAcceptRuleId: A1 }),
        h(OWNER, 'withdrawal', { autoAcceptRuleId: A1 }),
      ],
    ];
    for (const history of cases) expect(reason(relation({ history }))).toBe('human-involved');
  });

  it('is not blocked by a rule-tier stance or another agent without a question', () => {
    const history = [h(RULES, 'proposal'), h(OTHER, 'proposal'), h(AGENT, 'proposal')];
    expect(reason(relation({ history }))).toBe('accept');
  });

  it('refuses a question on any live agent proposal, the trigger included', () => {
    expect(
      reason(relation({ history: [h(AGENT, 'proposal', { question: 'Welcher Prozess?' })] })),
    ).toBe('agent-question');
    expect(
      reason(
        relation({
          history: [h(OTHER, 'proposal', { question: 'Sicher?' }), h(AGENT, 'proposal')],
        }),
      ),
    ).toBe('agent-question');
    // A withdrawn question no longer counts; a blank one never does.
    expect(
      reason(
        relation({
          history: [
            h(OTHER, 'proposal', { question: 'Sicher?' }),
            h(OTHER, 'withdrawal'),
            h(AGENT, 'proposal', { question: '  ' }),
          ],
        }),
      ),
    ).toBe('accept');
  });

  it('refuses a pair with a live no-link', () => {
    expect(reason(relation({ liveNoLinks: 1 }))).toBe('no-link');
  });

  it('reports the first failing check', () => {
    expect(
      reason(
        relation({
          trigger: trigger({ current: false }),
          relation: { ...proposed, status: 'held' },
        }),
      ),
    ).toBe('stale-proposal');
    expect(
      reason(
        relation({
          history: [h(AGENT, 'proposal', { question: '?' }), h(OWNER, 'note')],
          liveNoLinks: 2,
        }),
      ),
    ).toBe('human-involved');
    expect(
      reason(relation({ history: [h(AGENT, 'proposal', { question: '?' })], liveNoLinks: 2 })),
    ).toBe('agent-question');
  });
});

describe('placement safeguards', () => {
  const placementRule = rule({ kind: 'placement', tier: 'lexical' });
  const own: PlacementSubjectView = {
    id: 'plc_A',
    status: 'proposed',
    endpointState: 'ok',
    elementId: 'step-antrag',
    generation: 1,
  };
  const other = (extra: Partial<PlacementSubjectView>): PlacementSubjectView => ({
    ...own,
    id: 'plc_B',
    elementId: 'step-bescheid',
    ...extra,
  });
  const lexical = (principalId: PrincipalId, extra: Partial<HistoryView> = {}) =>
    h(principalId, 'proposal', { tier: 'lexical', ...extra });

  function placement(
    extra: Partial<Parameters<typeof evaluatePlacementAutoAccept>[0]> = {},
  ): string {
    const v = evaluatePlacementAutoAccept({
      placement: own,
      stepLive: true,
      processPlacements: [{ placement: own, history: [lexical(AGENT)] }],
      trigger: trigger({ tier: 'lexical' }),
      priorVerdict: null,
      rules: [placementRule],
      ...extra,
    });
    return v.accept ? 'accept' : v.reason;
  }

  it('accepts a lone agent proposal on a live step', () => {
    expect(placement()).toBe('accept');
  });

  it('never accepts @outside or a removed step', () => {
    const outside = { ...own, elementId: '@outside' };
    expect(
      placement({ placement: outside, processPlacements: [{ placement: outside, history: [] }] }),
    ).toBe('outside');
    expect(placement({ stepLive: false })).toBe('step-removed');
  });

  it('respects decision 18: no second home step', () => {
    for (const status of ['accepted', 'held'] as const) {
      expect(
        placement({
          processPlacements: [
            { placement: own, history: [lexical(AGENT)] },
            { placement: other({ status }), history: [] },
          ],
        }),
      ).toBe('has-home-step');
    }
    // Also an acceptance on a removed step generation.
    expect(
      placement({
        processPlacements: [
          { placement: own, history: [lexical(AGENT)] },
          { placement: other({ status: 'accepted', endpointState: 'missing' }), history: [] },
        ],
      }),
    ).toBe('has-home-step');
  });

  it('refuses a process with live proposals on another step (agent, own or rule tier)', () => {
    for (const p of [lexical(OTHER), lexical(AGENT), h(RULES, 'proposal')]) {
      expect(
        placement({
          processPlacements: [
            { placement: own, history: [lexical(AGENT)] },
            { placement: other({}), history: [p] },
          ],
        }),
      ).toBe('competing-step');
    }
  });

  it('allows two agents on the same step', () => {
    expect(
      placement({
        processPlacements: [{ placement: own, history: [lexical(OTHER), lexical(AGENT)] }],
      }),
    ).toBe('accept');
  });

  it('refuses any human assertion on any placement of the process', () => {
    expect(
      placement({
        processPlacements: [
          { placement: own, history: [lexical(AGENT)] },
          { placement: other({ status: 'rejected' }), history: [h(OWNER, 'note')] },
        ],
      }),
    ).toBe('human-involved');
  });

  it('refuses a question on a live agent proposal of the process', () => {
    expect(
      placement({
        processPlacements: [{ placement: own, history: [lexical(AGENT, { question: '?' })] }],
      }),
    ).toBe('agent-question');
  });

  it('refuses another agent’s current unsure verdict, not a stale or its own', () => {
    expect(
      placement({ priorVerdict: { principalId: OTHER, outcome: 'unsure', current: true } }),
    ).toBe('agent-unsure');
    expect(
      placement({ priorVerdict: { principalId: OTHER, outcome: 'unsure', current: false } }),
    ).toBe('accept');
    expect(
      placement({ priorVerdict: { principalId: AGENT, outcome: 'unsure', current: true } }),
    ).toBe('accept');
    expect(
      placement({ priorVerdict: { principalId: OTHER, outcome: 'skipped', current: true } }),
    ).toBe('accept');
  });

  it('needs a placement rule of the proposal’s tier', () => {
    expect(placement({ rules: [rule()] })).toBe('no-matching-rule');
    expect(placement({ trigger: trigger({ tier: 'semantic' }) })).toBe('no-matching-rule');
  });
});
