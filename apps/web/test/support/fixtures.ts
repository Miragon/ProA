import type {
  AgentToken,
  Fact,
  Model,
  Placement,
  PlacementAssertion,
  PlacementSummary,
  Relation,
  RelationAssertion,
  RelationNoLink,
  RelationProvenance,
  ValueChainDetail,
  ValueChainImpact,
  ValueChainStep,
} from '@proa/client';

import { buildRefIndex, resolverOf } from '../../src/lib/refs';

const NOW = '2026-10-07T09:00:00.000Z';

export function relation(
  overrides: Partial<Relation> & Pick<Relation, 'id' | 'from' | 'to'>,
): Relation {
  return {
    type: 'message',
    status: 'proposed',
    endpointState: 'ok',
    tier: 'key',
    confidence: 1,
    version: 1,
    attrs: {},
    // Without provenance the UI falls back to tier and attributes (relations from before M2).
    source: null,
    provenance: null,
    noLinks: [],
    updatedAt: NOW,
    ...overrides,
  };
}

/** The relations of eval/corpus/_sample, as the rule tier produces them. */
export const sampleRelations: Relation[] = [
  relation({
    id: 'rel_01SIGNAL0000000000000000001',
    type: 'signal',
    from: 'finanzen/rechnungsstellung#End_RechnungsstellungAbgeschlossen',
    to: 'vertrieb/auftragsabwicklung#Start_RechnungsstellungAbgeschlossen',
    attrs: { signalName: 'RechnungsstellungAbgeschlossen' },
  }),
  relation({
    id: 'rel_01MESSAGE000000000000000001',
    type: 'message',
    from: 'vertrieb/auftragsabwicklung#Event_WareVersandbereit',
    to: 'finanzen/rechnungsstellung#Start_WareVersandbereit',
    attrs: { messageName: 'WareVersandbereit' },
  }),
  relation({
    id: 'rel_01CALL000000000000000000001',
    type: 'call',
    from: 'vertrieb/auftragsabwicklung#Call_ZahlungAbwickeln',
    to: 'finance/payment-collection#Process_PaymentCollection',
    status: 'accepted',
    tier: 'rule',
    confidence: 1,
    attrs: { binding: 'latest' },
  }),
  relation({
    id: 'rel_01STEM000000000000000000001',
    type: 'call',
    from: 'finanzen/rechnungsstellung#Call_Mahnwesen',
    to: 'finance/payment-collection#Process_PaymentCollection',
    tier: 'key',
    confidence: 0.8,
    endpointState: 'changed',
    attrs: { calledElement: 'Process_Mahnwesen', match: 'file-stem' },
  }),
];

export const sampleResolver = resolverOf(
  buildRefIndex(
    [
      {
        modelKey: 'vertrieb/auftragsabwicklung',
        ref: 'vertrieb/auftragsabwicklung#Call_ZahlungAbwickeln',
        kind: 'call',
        label: 'Zahlung abwickeln',
        processId: 'Process_Auftragsabwicklung',
      },
      {
        modelKey: 'vertrieb/auftragsabwicklung',
        ref: 'vertrieb/auftragsabwicklung#Event_WareVersandbereit',
        kind: 'msg_throw',
        label: 'Ware versandbereit',
        processId: 'Process_Auftragsabwicklung',
      },
      {
        modelKey: 'finanzen/rechnungsstellung',
        ref: 'finanzen/rechnungsstellung#Start_WareVersandbereit',
        kind: 'msg_catch',
        label: 'Ware versandbereit',
        processId: 'Process_Rechnungsstellung',
      },
    ],
    [
      {
        ref: 'vertrieb/auftragsabwicklung#Process_Auftragsabwicklung',
        processId: 'Process_Auftragsabwicklung',
        name: 'Auftragsabwicklung',
        participantName: 'Vertrieb',
        isExecutable: true,
      },
      {
        ref: 'finanzen/rechnungsstellung#Process_Rechnungsstellung',
        processId: 'Process_Rechnungsstellung',
        name: 'Rechnungsstellung',
        participantName: null,
        isExecutable: true,
      },
      {
        ref: 'finance/payment-collection#Process_PaymentCollection',
        processId: 'Process_PaymentCollection',
        name: 'Payment collection',
        participantName: null,
        isExecutable: true,
      },
    ],
  ),
);

export function agentToken(
  overrides: Partial<AgentToken> & Pick<AgentToken, 'id' | 'name'>,
): AgentToken {
  return {
    prefix: 'Ab3dE5gH',
    scopes: ['proa:read', 'proa:propose'],
    expiresAt: '2027-01-05T09:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

/** Provenance of an agent proposal (override for rule or human decisions). */
export function provenance(overrides: Partial<RelationProvenance> = {}): RelationProvenance {
  return {
    assertionId: 'ast_01PROPOSAL',
    kind: 'proposal',
    verdict: null,
    sourceKind: 'agent',
    principalId: 'prn_01AGENT',
    handle: 'agent:claude code',
    clientId: 'agt_01CLAUDE',
    procedure: { id: 'proa-relations', version: '0.1.0' },
    llmModel: 'claude-sonnet-5-5',
    tier: 'semantic',
    confidence: 0.82,
    rationale: 'Beide Ereignisse beschreiben die versandbereite Ware.',
    question: null,
    label: null,
    at: NOW,
    ...overrides,
  };
}

/** A current agent no-link on a relation's pair (judge each pair once). */
export function noLink(overrides: Partial<RelationNoLink> = {}): RelationNoLink {
  return {
    id: 'nlk_01NOLINK',
    handle: 'agent:claude code',
    origin: 'finanzen/debitoren',
    reason: 'no-evidence: Die Ereignisse betreffen verschiedene Vorgänge.',
    at: NOW,
    ...overrides,
  };
}

export function assertion(
  overrides: Partial<RelationAssertion> & Pick<RelationAssertion, 'id'>,
): RelationAssertion {
  return {
    seq: 1,
    kind: 'proposal',
    verdict: null,
    sourceKind: 'agent',
    principalId: 'prn_01AGENT',
    handle: 'agent:claude code',
    clientId: 'agt_01CLAUDE',
    procedure: { id: 'proa-relations', version: '0.1.0' },
    llmModel: 'claude-sonnet-5-5',
    submissionId: null,
    tier: 'semantic',
    confidence: 0.82,
    rationale: null,
    evidence: [],
    question: null,
    label: null,
    linkedRelationId: null,
    fromFp: 'aaaaaaaaaaaa',
    toFp: 'bbbbbbbbbbbb',
    at: NOW,
    ...overrides,
  };
}

/** A head fact; `ref` defaults to `<modelKey>#<elementId>`. */
export function fact(
  overrides: Partial<Fact> & Pick<Fact, 'modelKey' | 'elementId' | 'kind'>,
): Fact {
  return {
    ref: `${overrides.modelKey}#${overrides.elementId}`,
    processId: 'Process_1',
    scope: 'process',
    eventDef: null,
    label: '',
    keyRaw: '',
    keyNorm: '',
    fingerprint: 'abcdefabcdef',
    attrs: {},
    ...overrides,
  };
}

export function model(overrides: Partial<Model> & Pick<Model, 'key'>): Model {
  return {
    id: `mdl_${overrides.key.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`,
    projectId: 'prj_01DEMO',
    name: null,
    headRevisionId: `rev_${overrides.key.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`,
    headRev: 1,
    engine: 'c8',
    stage: 'waiting_for_review',
    openItems: 1,
    updatedAt: NOW,
    ...overrides,
  };
}

// ------------------------------------------------------------ value chain (M4)

/** A step of the head revision; `path` defaults to its name. */
export function step(
  overrides: Partial<ValueChainStep> & Pick<ValueChainStep, 'elementId' | 'name'>,
): ValueChainStep {
  return {
    generation: 1,
    kind: 'core',
    depth: overrides.parentId ? 1 : 0,
    rank: 0,
    parentId: null,
    path: [overrides.name],
    childIds: [],
    link: null,
    linkKind: 'none',
    linkProcess: null,
    linkResolved: false,
    owners: [],
    fingerprint: 'aaaaaaaaaaaa',
    counts: { accepted: 0, proposed: 0, held: 0 },
    ...overrides,
  };
}

/** A placement with an agent proposal's provenance (override for rule or human). */
export function placement(
  overrides: Partial<Placement> & Pick<Placement, 'id' | 'elementId' | 'process'>,
): Placement {
  return {
    valueChainId: 'vch_01DEMO',
    generation: 1,
    stepName: overrides.elementId === '@outside' ? null : overrides.elementId,
    stepLive: true,
    processName: overrides.process.split('#')[1] ?? null,
    status: 'proposed',
    endpointState: 'ok',
    endpoints: { step: 'ok', process: 'ok' },
    tier: 'semantic',
    confidence: 0.8,
    version: 1,
    source: 'agent',
    provenance: {
      assertionId: 'pas_01PROPOSAL',
      kind: 'proposal',
      verdict: null,
      sourceKind: 'agent',
      principalId: 'prn_01AGENT',
      handle: 'agent:claude code',
      clientId: 'agt_01CLAUDE',
      procedure: { id: 'proa-placements', version: '0.1.0' },
      llmModel: 'claude-sonnet-5-5',
      tier: 'semantic',
      confidence: 0.8,
      rationale: 'Passt fachlich.',
      question: null,
      label: null,
      at: NOW,
    },
    updatedAt: NOW,
    ...overrides,
  };
}

/** The compact form of a placement in `ValueChainDetail`. */
export function summary(p: Placement): PlacementSummary {
  return {
    id: p.id,
    elementId: p.elementId,
    generation: p.generation,
    stepLive: p.stepLive,
    process: p.process,
    status: p.status,
    endpointState: p.endpointState,
    tier: p.tier,
    confidence: p.confidence,
    version: p.version,
    source: p.source,
  };
}

export function placementAssertion(
  overrides: Partial<PlacementAssertion> & Pick<PlacementAssertion, 'id'>,
): PlacementAssertion {
  return {
    seq: 1,
    kind: 'proposal',
    verdict: null,
    sourceKind: 'agent',
    principalId: 'prn_01AGENT',
    handle: 'agent:claude code',
    clientId: 'agt_01CLAUDE',
    procedure: { id: 'proa-placements', version: '0.1.0' },
    llmModel: 'claude-sonnet-5-5',
    submissionId: null,
    tier: 'semantic',
    confidence: 0.8,
    rationale: null,
    evidence: [],
    question: null,
    label: null,
    linkedPlacementId: null,
    stepFp: 'aaaaaaaaaaaa',
    processFp: 'bbbbbbbbbbbb',
    at: NOW,
    ...overrides,
  };
}

export function chainDetail(
  overrides: Partial<Omit<ValueChainDetail, 'placements'>> & { placements?: Placement[] } = {},
): ValueChainDetail {
  const { placements = [], ...rest } = overrides;
  return {
    valueChain: {
      id: 'vch_01DEMO',
      key: 'main',
      name: 'Demo – Wertschöpfungskette',
      headRevisionId: 'vcr_01HEAD',
      headRev: 3,
      contentHash: 'a'.repeat(64),
      structureHash: 'b'.repeat(64),
      schemaVersion: 1,
      updatedAt: NOW,
    },
    steps: [],
    orgUnits: [],
    findings: [],
    pipeline: {
      stage: 'incorporated',
      task: null,
      reviewItems: 0,
      heldItems: 0,
      due: 0,
      unsure: 0,
    },
    unsure: [],
    ...rest,
    placements: placements.map(summary),
  };
}

export function impact(overrides: Partial<ValueChainImpact> = {}): ValueChainImpact {
  return {
    structureChanged: true,
    steps: { added: [], removed: [], changed: [] },
    placements: { stranded: 0, toReconfirm: 0, proposalsWithdrawn: 0 },
    ...overrides,
  };
}
