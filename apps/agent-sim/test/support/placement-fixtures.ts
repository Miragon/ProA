/**
 * Hand-built placement claim inputs (`proa-claim-placement/1`) for the
 * placement policy, recorder and agent tests. An invented university chain
 * (no corpus data): one process per verdict of the policy.
 */
import {
  CLAIM_PLACEMENT_FORMAT,
  LEASE_TOKEN_PREFIX,
  PlacementClaimInput,
  newId,
  type ClaimPlacementProcess,
  type ClaimPlacementStep,
  type ClaimedPlacementAnalysis,
} from '@proa/contracts';

const AT = '2026-10-01T10:00:00.000Z';

function step(
  id: string,
  name: string,
  parentId: string | null,
  extra: Partial<ClaimPlacementStep> = {},
): ClaimPlacementStep {
  return {
    id,
    name,
    path: parentId === null ? [name] : [PARENTS[parentId] ?? parentId, name],
    kind: 'core',
    rank: 0,
    depth: parentId === null ? 0 : 1,
    parentId,
    children: [],
    ...extra,
  };
}

const PARENTS: Record<string, string> = {
  'step-bewerbung-zulassung': 'Bewerbung & Zulassung',
  'step-studium': 'Studium',
};

export const STEPS: ClaimPlacementStep[] = [
  step('step-bewerbung', 'Bewerbung', 'step-bewerbung-zulassung', { rank: 0 }),
  step('step-bewerbung-zulassung', 'Bewerbung & Zulassung', null, {
    children: ['step-bewerbung', 'step-zulassung'],
  }),
  step('step-lehre', 'Lehre', 'step-studium', { rank: 0 }),
  step('step-pruefungen', 'Prüfungen', 'step-studium', { rank: 1 }),
  step('step-studium', 'Studium', null, {
    rank: 1,
    children: ['step-lehre', 'step-pruefungen'],
  }),
  step('step-zulassung', 'Zulassung', 'step-bewerbung-zulassung', { rank: 1 }),
];

/** Process refs by the verdict the policy gives them. */
export const P = {
  rule: 'zulassung/zulassung#Process_Zulassung',
  strong: 'lehre/vorlesungsplanung#Process_Lehrplanung',
  tie: 'pruefungsamt/pruefungsanmeldung#Process_Anmeldung',
  weak: 'studium/beurlaubung#Process_Beurlaubung',
  rejectedTop: 'pruefungsamt/notenverbuchung#Process_Noten',
  ruleRejected: 'bewerbung/bewerbung#Process_Bewerbung',
  none: 'verwaltung/foerdermittel#Process_Antrag',
  allRejected: 'verwaltung/raumvergabe#Process_Raum',
} as const;

function processOf(
  ref: string,
  name: string | null,
  extra: Partial<ClaimPlacementProcess> = {},
): ClaimPlacementProcess {
  return {
    process: ref as ClaimPlacementProcess['process'],
    name,
    modelKey: ref.slice(0, ref.indexOf('#')),
    lanes: [],
    starts: [],
    ends: [],
    neighbours: [],
    calls: { out: [], in: [] },
    hints: [],
    proposals: [],
    decisions: [],
    ...extra,
  };
}

const hint = (s: string, score: number) => ({
  step: s,
  name: STEPS.find((x) => x.id === s)?.name ?? s,
  score,
});

/** One process per verdict, in ref order as the server sends them. */
export function placementProcesses(): ClaimPlacementProcess[] {
  return [
    processOf(P.ruleRejected, 'Bewerbung', {
      hints: [hint('step-bewerbung', 6), hint('step-bewerbung-zulassung', 4)],
      // The rule proposal's placement was rejected: the policy follows the next hint.
      proposals: [
        {
          placementId: newId('placement'),
          step: 'step-bewerbung',
          status: 'rejected',
          tier: 'key',
          confidence: 1,
          by: 'proa-rules',
          source: 'rule',
        },
      ],
      decisions: [
        {
          placementId: newId('placement'),
          step: 'step-bewerbung',
          stepLive: true,
          verdict: 'reject',
          note: 'gehört zur Zulassung',
          at: AT,
        },
      ],
    }),
    processOf(P.strong, 'Lehrplanung', {
      hints: [hint('step-lehre', 4), hint('step-studium', 1)],
    }),
    processOf(P.rejectedTop, 'Notenverbuchung', {
      hints: [hint('step-lehre', 4), hint('step-pruefungen', 3.5)],
      decisions: [
        {
          placementId: newId('placement'),
          step: 'step-lehre',
          stepLive: true,
          verdict: 'reject',
          at: AT,
        },
      ],
    }),
    processOf(P.tie, 'Prüfungsanmeldung', {
      hints: [hint('step-pruefungen', 3), hint('step-zulassung', 3), hint('step-lehre', 1)],
    }),
    processOf(P.weak, null, { hints: [hint('step-studium', 2)] }),
    processOf(P.none, 'Fördermittelantrag'),
    processOf(P.allRejected, 'Raumvergabe', {
      hints: [hint('step-lehre', 1)],
      decisions: [
        {
          placementId: newId('placement'),
          step: 'step-lehre',
          stepLive: true,
          verdict: 'reject',
          at: AT,
        },
      ],
    }),
    processOf(P.rule, 'Zulassung', {
      hints: [hint('step-zulassung', 3), hint('step-bewerbung-zulassung', 2)],
      proposals: [
        {
          placementId: newId('placement'),
          step: 'step-zulassung',
          status: 'proposed',
          tier: 'key',
          confidence: 1,
          by: 'proa-rules',
          source: 'rule',
          rationale: 'Schlüsselregel',
        },
      ],
    }),
  ];
}

/** A placement claim input (parsed with the contract, so it stays valid). */
export function placementInput(overrides: Partial<PlacementClaimInput> = {}): PlacementClaimInput {
  return PlacementClaimInput.parse({
    format: CLAIM_PLACEMENT_FORMAT,
    valueChain: {
      id: newId('valueChain'),
      key: 'main',
      name: 'Hochschule',
      revisionId: newId('valueChainRevision'),
      rev: 3,
      contentHash: 'a'.repeat(64),
      structureHash: 'b'.repeat(64),
    },
    steps: STEPS,
    processes: placementProcesses(),
    examples: [],
    truncated: false,
    remaining: 0,
    ...overrides,
  });
}

/** A claimed placement task around {@link placementInput}. */
export function claimedPlacement(
  projectKey = 'demo',
  input: PlacementClaimInput = placementInput(),
): ClaimedPlacementAnalysis {
  return {
    kind: 'placement',
    taskId: newId('analysisTask'),
    projectId: newId('project'),
    projectKey,
    valueChainId: input.valueChain.id,
    valueChainKey: input.valueChain.key,
    revisionId: input.valueChain.revisionId,
    rev: input.valueChain.rev,
    attempt: 1,
    leaseToken: `${LEASE_TOKEN_PREFIX}${'B'.repeat(43)}`,
    leaseUntil: '2026-10-01T10:15:00.000Z',
    procedure: { id: 'proa-placements', version: '0.0.1' },
    input,
  };
}
