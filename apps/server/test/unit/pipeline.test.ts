/**
 * Pure parts of the pipeline and review: lease tokens, item validation,
 * the findings filter, the claim input rendering, If-Match parsing and the
 * notifier's fallbacks.
 */
import { createHash } from 'node:crypto';

import { ClaimInput, type Fact, type Finding, type ProjectFacts, type Ref } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { createNotifier } from '../../src/db/notifications.ts';
import { claimInputBytes, renderClaimInput } from '../../src/domain/claim-input.ts';
import { visibleFindings } from '../../src/domain/findings.ts';
import { leaseTokenHash, newLeaseToken, sameLeaseHash } from '../../src/domain/lease.ts';
import type { PairAssessment, RelationRecord, StoredAssertion } from '../../src/domain/ports.ts';
import { validateProposal, type ProposalDraft } from '../../src/domain/proposals.ts';
import { jsonBytes, storablePayload } from '../../src/domain/payload.ts';
import { ifMatchVersion } from '../../src/http/etag.ts';

describe('lease tokens', () => {
  it('carry 256 random bits behind a recognizable prefix', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => newLeaseToken()));
    expect(tokens.size).toBe(200);
    for (const t of tokens) {
      expect(t).toMatch(/^proa_lt_[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(t.slice(8), 'base64url')).toHaveLength(32);
    }
  });

  it('are stored as a hash bound to the task and the principal', () => {
    const token = newLeaseToken();
    const h = leaseTokenHash('ana_1', 'prn_1', token);
    expect(h).toBe(createHash('sha256').update(`ana_1|prn_1|${token}`).digest('hex'));
    expect(h).not.toBe(leaseTokenHash('ana_2', 'prn_1', token));
    expect(h).not.toBe(leaseTokenHash('ana_1', 'prn_2', token));
    expect(sameLeaseHash(h, leaseTokenHash('ana_1', 'prn_1', token))).toBe(true);
    expect(sameLeaseHash(h, null)).toBe(false);
    expect(sameLeaseHash(h, h.slice(1))).toBe(false);
  });
});

describe('validateProposal', () => {
  const ok: PairAssessment = { ok: true, tier: 'lexical', score: 0.5, signals: {} };
  const assess = (result: PairAssessment) => () => result;
  const draft = (extra: Partial<ProposalDraft> = {}): ProposalDraft => ({
    type: 'message',
    from: 'a/m#E',
    to: 'b/n#S',
    confidence: 0.5,
    rationale: 'r',
    evidence: [],
    question: null,
    ...extra,
  });

  it('checks type, refs, limits, the task model, then the head facts, in that order', () => {
    const cases: [Partial<ProposalDraft>, string][] = [
      [{ type: 'manual', from: 'x' }, 'type-not-allowed'],
      [{ from: 'x', confidence: 9 }, 'malformed-ref'],
      [{ confidence: Number.NaN }, 'confidence-out-of-range'],
      [{ confidence: -0.1 }, 'confidence-out-of-range'],
      [{ rationale: 'x'.repeat(1001) }, 'rationale-too-long'],
      [{ question: 'x'.repeat(501) }, 'question-too-long'],
      [{ evidence: Array.from({ length: 21 }, () => 'e') }, 'too-much-evidence'],
      [{ rationale: 'a\u0000b' }, 'control-characters'],
      [{ question: 'warum\u001b?' }, 'control-characters'],
      [{ evidence: ['ok', 'x\u0085'] }, 'control-characters'],
      [{ from: 'c/o#E', to: 'b/n#S' }, 'outside-task-model'],
    ];
    for (const [extra, reason] of cases) {
      expect(validateProposal(draft(extra), assess(ok), 'a/m'), reason).toEqual({
        ok: false,
        reason,
      });
    }
    expect(validateProposal(draft(), assess({ ok: false, reason: 'unknown-ref' }), 'a/m')).toEqual({
      ok: false,
      reason: 'unknown-ref',
    });
  });

  it('accepts the limits exactly and takes the tier from the assessment', () => {
    const v = validateProposal(
      draft({
        rationale: 'x'.repeat(1000),
        question: '',
        confidence: 1,
        evidence: Array(20).fill('e') as string[],
      }),
      assess(ok),
      'b/n',
    );
    expect(v).toMatchObject({ ok: true, value: { tier: 'lexical', question: null } });
    // Ad-hoc proposals have no task model.
    expect(validateProposal(draft({ from: 'c/o#E' }), assess(ok)).ok).toBe(true);
  });
});

describe('storablePayload', () => {
  it('replaces U+0000 in strings and keys, and nothing else', () => {
    const payload = {
      summary: 'a\u0000b',
      'k\u0000': [1, null, true, { reason: '\u0000\u0000', tab: 'x\ty' }],
    };
    expect(storablePayload(payload)).toEqual({
      summary: 'a\uFFFDb',
      'k\uFFFD': [1, null, true, { reason: '\uFFFD\uFFFD', tab: 'x\ty' }],
    });
    expect(payload.summary).toBe('a\u0000b');
    expect(jsonBytes({ a: 'ä' })).toBe(Buffer.byteLength('{"a":"ä"}'));
  });
});

describe('visibleFindings', () => {
  const findings = [
    { kind: 'dangling-throw' as const, refs: ['a/m#E' as const], detail: '' },
    { kind: 'unmatched-catch' as const, refs: ['b/n#S' as const], detail: '' },
    { kind: 'unresolved-call' as const, refs: ['a/m#C' as const], detail: '' },
  ];

  it('hides endpoint findings a live relation answers, and keeps the others', () => {
    const rel = (status: RelationRecord['status']) => [
      { fromRef: 'a/m#E', toRef: 'b/n#S', status },
    ];
    for (const status of ['proposed', 'accepted', 'held'] as const) {
      expect(
        visibleFindings(findings, rel(status)).map((f) => f.kind),
        status,
      ).toEqual(['unresolved-call']);
    }
    for (const status of ['rejected', 'obsolete'] as const) {
      expect(visibleFindings(findings, rel(status)), status).toEqual(findings);
    }
    // A call relation never hides unresolved-call (the rule tier decides that).
    expect(
      visibleFindings(findings, [{ fromRef: 'a/m#C', toRef: 'x/y#P', status: 'accepted' }]),
    ).toEqual(findings);
  });
});

describe('renderClaimInput', () => {
  const fact = (modelKey: string, elementId: string, extra: Partial<Fact>): Fact => ({
    modelKey,
    ref: `${modelKey}#${elementId}`,
    kind: 'task',
    elementId,
    processId: 'P',
    scope: 'process',
    eventDef: null,
    label: elementId,
    keyRaw: elementId,
    keyNorm: elementId.toLowerCase(),
    fingerprint: '000000000000',
    attrs: {},
    ...extra,
  });
  const projectFacts: ProjectFacts = {
    models: [
      {
        modelKey: 'a/m',
        factsVersion: '1',
        processes: [
          {
            ref: 'a/m#P',
            processId: 'P',
            name: 'Alpha',
            participantName: null,
            isExecutable: true,
          },
        ],
        facts: [
          fact('a/m', 'E', {
            kind: 'msg_throw',
            eventDef: 'message',
            label: 'Sent',
            keyRaw: 'Msg',
            attrs: { documentation: 'd'.repeat(400) },
          }),
          fact('a/m', 'S', {
            kind: 'evt_start',
            eventDef: 'none',
            label: 'Start',
            keyRaw: 'Start',
            scope: 'subprocess',
          }),
          // A message flow from the throw to another pool of the same file.
          fact('a/m', 'F', {
            kind: 'message_flow',
            processId: null,
            label: '',
            keyRaw: 'Msg',
            attrs: { sourceRef: 'a/m#E', targetRef: 'a/m#Pool_Bank', messageName: 'Msg' },
          }),
        ],
        messageFlows: [],
      },
      {
        modelKey: 'b/n',
        factsVersion: '1',
        processes: [
          {
            ref: 'b/n#Q',
            processId: 'Q',
            name: null,
            participantName: 'Pool B',
            isExecutable: true,
          },
        ],
        facts: [
          fact('b/n', 'Q', {
            kind: 'process',
            processId: 'Q',
            label: 'Pool B',
            keyRaw: 'Q',
            attrs: { documentation: 'q'.repeat(301) },
          }),
          // One element, two facts: the message catch is the partner of a message candidate.
          fact('b/n', 'C', {
            kind: 'sig_catch',
            eventDef: 'signal',
            label: 'Got',
            keyRaw: 'Sig',
            processId: 'Q',
          }),
          fact('b/n', 'C', {
            kind: 'msg_catch',
            eventDef: 'message',
            label: 'Got',
            keyRaw: 'Msg',
            processId: 'Q',
            attrs: { documentation: 'Wartet auf die Nachricht.' },
          }),
        ],
        messageFlows: [],
      },
      {
        // A partner whose process has neither a name nor documentation.
        modelKey: 'c/o',
        factsVersion: '1',
        processes: [
          { ref: 'c/o#R', processId: 'R', name: null, participantName: null, isExecutable: true },
        ],
        facts: [fact('c/o', 'T', { kind: 'msg_catch', eventDef: 'message', processId: 'R' })],
        messageFlows: [],
      },
    ],
  };
  const finding = (kind: Finding['kind'], ...refs: Ref[]): Finding => ({
    kind,
    refs,
    detail: kind,
  });
  const relation: RelationRecord = {
    id: 'rel_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
    projectId: 'prj_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
    type: 'message',
    fromRef: 'a/m#E',
    toRef: 'b/n#C',
    status: 'rejected',
    endpointState: 'ok',
    tier: 'key',
    confidence: 1,
    version: 3,
    attrs: {},
    fromFp: null,
    toFp: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const at = new Date('2026-10-08T08:00:00.000Z');
  const assertion = (seq: number, extra: Partial<StoredAssertion>): StoredAssertion => ({
    id: `asr_0000000000000000000000000${seq}`,
    projectId: relation.projectId,
    relationId: relation.id,
    seq,
    kind: 'proposal',
    verdict: null,
    sourceKind: 'agent',
    principalId: 'prn_agent',
    clientId: 'agt_x',
    declared: null,
    submissionId: null,
    tier: 'key',
    confidence: 1,
    rationale: 'r',
    evidence: [],
    question: 'Gilt das immer?',
    label: null,
    linkedRelationId: null,
    fromFp: null,
    toFp: null,
    fromHash: null,
    toHash: null,
    handle: 'agent:x',
    createdAt: at,
    ...extra,
  });
  const input = renderClaimInput({
    model: {
      key: 'a/m',
      name: 'Alpha',
      revisionId: 'rev_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
      rev: 2,
      engine: 'c8',
      processes: projectFacts.models[0]?.processes ?? [],
    },
    projectFacts,
    candidates: [
      { type: 'message', from: 'a/m#E', to: 'b/n#C', basis: 'key', score: 1, signals: {} },
      {
        type: 'message',
        from: 'a/m#E',
        to: 'b/n#C2',
        basis: 'compatible',
        score: 0.123456,
        signals: {},
      },
      { type: 'message', from: 'a/m#E', to: 'c/o#T', basis: 'compatible', score: 0.1, signals: {} },
    ],
    relations: [relation],
    histories: new Map([
      [
        relation.id,
        [
          assertion(1, {}),
          assertion(2, {
            kind: 'decision',
            verdict: 'reject',
            sourceKind: 'human',
            principalId: 'prn_owner',
            rationale: 'nein',
            question: null,
          }),
          assertion(3, {
            kind: 'note',
            sourceKind: 'human',
            principalId: 'prn_owner',
            rationale: 'weil',
            question: null,
          }),
        ],
      ],
    ]),
    // Any order; only those with a ref in a/m stay.
    findings: [
      finding('unmatched-catch', 'b/n#C'),
      finding('duplicate-process-id', 'a/m#P', 'c/o#P'),
      finding('unresolved-call', 'b/n#K'),
      finding('dangling-throw', 'a/m#E'),
    ],
  });

  it('renders facts compactly: defaults left out, documentation cut', () => {
    expect(input.facts).toEqual([
      {
        ref: 'a/m#E',
        kind: 'msg_throw',
        eventDef: 'message',
        label: 'Sent',
        key: 'Msg',
        process: 'P',
        doc: `${'d'.repeat(299)}…`,
      },
      {
        ref: 'a/m#S',
        kind: 'evt_start',
        eventDef: 'none',
        label: 'Start',
        scope: 'subprocess',
        process: 'P',
      },
      // Collaboration level: no process, but the ends of the flow.
      {
        ref: 'a/m#F',
        kind: 'message_flow',
        label: '',
        key: 'Msg',
        from: 'a/m#E',
        to: 'a/m#Pool_Bank',
      },
    ]);
    expect(input.model).toEqual({
      key: 'a/m',
      name: 'Alpha',
      revisionId: 'rev_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
      rev: 2,
      engine: 'c8',
      processes: [{ processId: 'P', name: 'Alpha', participantName: null }],
    });
  });

  it('renders candidates as tuples and their partners once, by the fact kind of the side', () => {
    expect(input.candidates).toEqual([
      ['message', 'a/m#E', 'b/n#C', 'key', 1],
      ['message', 'a/m#E', 'b/n#C2', 'compatible', 0.1235],
      ['message', 'a/m#E', 'c/o#T', 'compatible', 0.1],
    ]);
    expect(input.partners).toEqual({
      'b/n#C': {
        kind: 'msg_catch',
        eventDef: 'message',
        label: 'Got',
        key: 'Msg',
        process: 'b/n#Q',
        processName: 'Pool B',
        doc: 'Wartet auf die Nachricht.',
      },
      'c/o#T': { kind: 'msg_catch', eventDef: 'message', label: 'T', process: 'c/o#R' },
    });
  });

  it('describes the process of every partner endpoint, documentation cut', () => {
    expect(input.partnerProcesses).toEqual({
      'b/n#Q': { name: 'Pool B', doc: `${'q'.repeat(299)}…` },
      'c/o#R': {},
    });
    expect(Object.keys(input.partnerProcesses ?? {})).toEqual(['b/n#Q', 'c/o#R']);
  });

  it('lists the findings with a ref in the model, sorted by kind and refs', () => {
    expect(input.findings).toEqual([
      finding('dangling-throw', 'a/m#E'),
      finding('duplicate-process-id', 'a/m#P', 'c/o#P'),
    ]);
  });

  it('leaves the additions out when there is nothing to say', () => {
    const bare = renderClaimInput({
      model: {
        key: 'c/o',
        name: null,
        revisionId: 'rev_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
        rev: 1,
        engine: null,
        processes: projectFacts.models[2]?.processes ?? [],
      },
      projectFacts,
      candidates: [],
      relations: [],
      histories: new Map(),
      findings: [finding('dangling-throw', 'a/m#E'), finding('unmatched-catch', 'c/o2#T')],
    });
    expect(bare.facts).toEqual([
      { ref: 'c/o#T', kind: 'msg_catch', eventDef: 'message', label: 'T', process: 'R' },
    ]);
    expect(bare.partners).toEqual({});
    expect(bare).not.toHaveProperty('partnerProcesses');
    expect(bare).not.toHaveProperty('findings');
    expect(ClaimInput.parse(bare)).toEqual(bare);
    expect(ClaimInput.parse(input)).toEqual(input);
  });

  it('shows the human decision, the agent’s open question and the notes', () => {
    expect(input.relations).toEqual([
      {
        id: relation.id,
        type: 'message',
        from: 'a/m#E',
        to: 'b/n#C',
        status: 'rejected',
        tier: 'key',
        confidence: 1,
        source: 'human',
        endpointState: 'ok',
        decision: { verdict: 'reject', note: 'nein', at: at.toISOString() },
        question: 'Gilt das immer?',
        notes: [{ text: 'weil', at: at.toISOString() }],
      },
    ]);
    expect(claimInputBytes(input)).toBe(Buffer.byteLength(JSON.stringify(input)));
  });
});

describe('If-Match', () => {
  it('names a relation version', () => {
    expect(ifMatchVersion(undefined)).toBeUndefined();
    expect(ifMatchVersion('*')).toBeUndefined();
    expect(ifMatchVersion('"3"')).toBe(3);
    expect(ifMatchVersion('W/"3"')).toBe(3);
    expect(ifMatchVersion('"v12"')).toBe(12);
    for (const bad of ['3', '"x"', '"3", "4"', '']) {
      expect(() => ifMatchVersion(bad), bad).toThrow(/If-Match/);
    }
  });
});

describe('notifier fallbacks', () => {
  it('never waits when the listener cannot connect or the limit is reached', async () => {
    const unreachable = createNotifier('postgres://nobody@127.0.0.1:1/none');
    const sub = await unreachable.subscribe(['prj_01J9Z3N4X5Q6R7S8T9V0W1X2Y3'], 'prn_a');
    const started = Date.now();
    expect(await sub.wait(5000)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(unreachable.subscribers()).toBe(0);
    await unreachable.close();
    const full = createNotifier('postgres://nobody@127.0.0.1:1/none', { maxSubscribers: 0 });
    expect(await (await full.subscribe([], 'prn_a')).wait(5000)).toBe(false);
    await full.close();
    expect(await (await full.subscribe([], 'prn_a')).wait(5000)).toBe(false);
    const perOwner = createNotifier('postgres://nobody@127.0.0.1:1/none', { maxPerOwner: 0 });
    const started2 = Date.now();
    expect(await (await perOwner.subscribe([], 'prn_a')).wait(5000)).toBe(false);
    expect(Date.now() - started2).toBeLessThan(1000);
    expect(perOwner.subscribers()).toBe(0);
    await perOwner.close();
  });
});
