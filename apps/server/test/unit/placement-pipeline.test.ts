/**
 * The `placement` pipeline kind, pure part (M4 §3.2, judge each process
 * once): the per-process input hash and what moves it (only what a claim
 * shows), the open and due processes, the selection of one claim's processes
 * (count and byte caps), the supersession plan and the claim's rendering.
 * Synthetic data only.
 */
import {
  MAX_CLAIM_PLACEMENT_PROCESSES,
  type DeclaredProcedure,
  type PlacementId,
  type PrincipalId,
  type Ref,
  type RelationStatus,
} from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import type {
  HeadFact,
  PlacementRecord,
  StoredPlacementAssertion,
} from '../../src/domain/ports.ts';
import { prepareRevision } from '../../src/domain/value-chain/document.ts';
import {
  chainInputDigest,
  claimExamples,
  claimProcess,
  claimSteps,
  dueDigest,
  dueProcesses,
  lastNonAgentSeqs,
  liveProposals,
  openProcesses,
  placementInputHash,
  planPlacementSupersession,
  processInputDigest,
  selectClaimProcesses,
  type InputHashContext,
} from '../../src/domain/value-chain/pipeline.ts';
import { OUTSIDE } from '../../src/domain/value-chain/steps.ts';
import type { ChainStructure } from '../../src/domain/value-chain/structure.ts';
import { acceptedNeighbours, acceptedSteps } from '../../src/domain/value-chain/tiers.ts';
import { factsByProcess, processOwnFields } from '../../src/domain/value-chain/unplaced.ts';
import { toAnalysisTask } from '../../src/domain/views.ts';
import { chain } from '../support/value-chain.ts';

const P = 'verwaltung/antrag#P_Antrag' as Ref;
const Q = 'verwaltung/bescheid#P_Bescheid' as Ref;
const N = 'studium/einschreibung#P_Einschreibung' as Ref;
const PROC: DeclaredProcedure = { id: 'proa-placements', version: '0.1.0' };
const AGENT = 'prn_AGENT' as PrincipalId;
const OTHER = 'prn_OTHER' as PrincipalId;

const stepsOf = (stepName = 'Antrag') => [
  { id: 'step-verwaltung', name: 'Verwaltung' },
  { id: 'step-antrag', name: stepName, parent: 'step-verwaltung' },
  { id: 'step-bescheid', name: 'Bescheid', parent: 'step-verwaltung' },
  { id: 'step-studium', name: 'Studium', link: `proa:process/${N}` },
];
const doc = (stepName = 'Antrag') => chain({ steps: stepsOf(stepName) });

const structure = prepareRevision(doc()).structure;
const live = new Map<string, number>([
  ...structure.steps.map((s) => [s.elementId, 1] as const),
  [OUTSIDE, 1],
]);

const headProcesses = new Set<string>([P, Q, N]);
const digestOf = (s: ChainStructure, generations = live, processes = headProcesses) =>
  chainInputDigest(s, processes, generations);
const CHAIN = digestOf(structure);

const base: InputHashContext = {
  procedure: PROC,
  chainDigest: CHAIN,
  processDigests: new Map([
    [P, 'f'.repeat(64)],
    [Q, 'e'.repeat(64)],
    [N, 'd'.repeat(64)],
  ]),
  neighbours: new Map(),
  acceptedSteps: new Map(),
  lastNonAgentSeq: new Map(),
};

let ids = 0;
function placement(
  elementId: string,
  processRef: Ref,
  status: RelationStatus,
  generation = 1,
): PlacementRecord {
  ids++;
  return {
    id: `plc_${String(ids).padStart(26, '0')}`,
    projectId: 'prj_X',
    valueChainId: 'vch_X',
    elementId,
    generation,
    processRef,
    status,
    endpointState: 'ok',
    tier: 'semantic',
    confidence: 0.8,
    version: 1,
    stepFp: null,
    processFp: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function assertion(
  p: PlacementRecord,
  seq: number,
  over: Partial<StoredPlacementAssertion> = {},
): StoredPlacementAssertion {
  return {
    id: `pas_${seq}` as StoredPlacementAssertion['id'],
    projectId: p.projectId,
    placementId: p.id,
    seq,
    kind: 'proposal',
    verdict: null,
    sourceKind: 'agent',
    principalId: AGENT,
    clientId: null,
    declared: { procedure: PROC, llmModel: 'sim' },
    submissionId: 'sub_1' as StoredPlacementAssertion['submissionId'],
    tier: 'semantic',
    confidence: 0.8,
    rationale: 'Begründung',
    evidence: [],
    question: null,
    label: null,
    linkedPlacementId: null,
    stepFp: null,
    processFp: null,
    stepHash: CHAIN,
    processHash: 'f'.repeat(64),
    handle: 'agent:sim',
    createdAt: new Date(seq * 1000),
    ...over,
  };
}

describe('placementInputHash', () => {
  const hash = (ctx: Partial<InputHashContext> = {}, ref: string = P) =>
    placementInputHash({ ...base, ...ctx }, ref);

  it('is stable and per process', () => {
    expect(hash()).toBe(hash());
    expect(hash()).toMatch(/^[0-9a-f]{64}$/);
    expect(hash({}, Q)).not.toBe(hash());
  });

  it('ignores a layout-only save and a change of case, also a move past an unconnected sibling', () => {
    const relaid = prepareRevision(
      chain({
        steps: [
          { id: 'step-verwaltung', name: 'VERWALTUNG', x: 999 },
          { id: 'step-antrag', name: 'Antrag', parent: 'step-verwaltung', y: 500 },
          { id: 'step-bescheid', name: 'Bescheid', parent: 'step-verwaltung' },
          { id: 'step-studium', name: 'Studium', link: `proa:process/${N}` },
        ],
      }),
    ).structure;
    // step-verwaltung moved behind step-studium: another rank, the same chain.
    expect(claimSteps(relaid, headProcesses).find((x) => x.id === 'step-verwaltung')?.rank).toBe(1);
    expect(digestOf(relaid)).toBe(CHAIN);
    // A sequence connection orders the steps: it counts.
    const sequenced = prepareRevision(
      chain({ steps: stepsOf(), sequence: [['step-verwaltung', 'step-studium']] }),
    ).structure;
    expect(digestOf(sequenced)).not.toBe(CHAIN);
  });

  it('ignores what a claim does not show: org units, their assignments, unresolved links', () => {
    const owned = prepareRevision(
      chain({
        steps: stepsOf(),
        orgUnits: [{ id: 'org-amt', name: 'Studierendenamt', owns: ['step-verwaltung'] }],
      }),
    ).structure;
    // The structure hash counts the org unit, the claim does not show it.
    expect(owned.structureHash).not.toBe(structure.structureHash);
    expect(digestOf(owned)).toBe(CHAIN);
    // A link to no head process is not shown either; once it resolves, it is.
    const relinked = prepareRevision(
      chain({
        steps: [
          { id: 'step-verwaltung', name: 'Verwaltung' },
          { id: 'step-antrag', name: 'Antrag', parent: 'step-verwaltung' },
          { id: 'step-bescheid', name: 'Bescheid', parent: 'step-verwaltung' },
          { id: 'step-studium', name: 'Studium', link: 'proa:process/x/y#P_Fehlt' },
        ],
      }),
    ).structure;
    const withoutN = new Set<string>([P, Q]);
    expect(digestOf(relinked, live, withoutN)).toBe(digestOf(structure, live, withoutN));
    expect(digestOf(structure)).not.toBe(digestOf(structure, live, withoutN));
  });

  it('ignores agent proposals and withdrawals, but not human or rule assertions', () => {
    const p = placement('step-antrag', P, 'proposed');
    const agentOnly = lastNonAgentSeqs(
      [p],
      new Map([[p.id, [assertion(p, 5), assertion(p, 9, { kind: 'withdrawal' })]]]),
    );
    expect(agentOnly.get(P)).toBeUndefined();
    expect(hash({ lastNonAgentSeq: agentOnly })).toBe(hash());
    for (const over of [
      { kind: 'decision', verdict: 'reject', sourceKind: 'human' },
      { kind: 'decision', verdict: 'hold', sourceKind: 'human' },
      { kind: 'note', sourceKind: 'human' },
      { kind: 'proposal', sourceKind: 'rule' },
      { kind: 'withdrawal', sourceKind: 'rule' },
    ] as const) {
      const seqs = lastNonAgentSeqs(
        [p],
        new Map([[p.id, [assertion(p, 5), assertion(p, 12, over)]]]),
      );
      expect(seqs.get(P), over.kind).toBe(12);
      expect(hash({ lastNonAgentSeq: seqs }), over.kind).not.toBe(hash());
    }
  });

  it('ignores auto-accept acceptances and their revocations (owner decision 19)', () => {
    const p = placement('step-antrag', P, 'accepted');
    const ruleId = 'aar_01J9Z3N4X5Q6R7S8T9V0W1X2Y1' as const;
    const history = [
      assertion(p, 5),
      assertion(p, 7, {
        kind: 'decision',
        verdict: 'accept',
        sourceKind: 'human',
        autoAcceptRuleId: ruleId,
        autoAcceptRuleRevision: 1,
      }),
      assertion(p, 9, {
        kind: 'withdrawal',
        sourceKind: 'human',
        autoAcceptRuleId: ruleId,
        autoAcceptRuleRevision: 1,
      }),
    ];
    const seqs = lastNonAgentSeqs([p], new Map([[p.id, history]]));
    expect(seqs.get(P)).toBeUndefined();
    expect(hash({ lastNonAgentSeq: seqs })).toBe(hash());
    // A human's own decision after them counts as before.
    const decided = lastNonAgentSeqs(
      [p],
      new Map([
        [
          p.id,
          [
            ...history,
            assertion(p, 11, { kind: 'decision', verdict: 'accept', sourceKind: 'human' }),
          ],
        ],
      ]),
    );
    expect(decided.get(P)).toBe(11);
  });

  it('ignores notes on obsolete placements, which no claim shows', () => {
    const gone = placement('step-antrag', P, 'obsolete');
    const seqs = lastNonAgentSeqs(
      [gone],
      new Map([
        [
          gone.id,
          [
            assertion(gone, 5),
            assertion(gone, 6, { kind: 'withdrawal', sourceKind: 'rule' }),
            assertion(gone, 9, { kind: 'note', sourceKind: 'human' }),
          ],
        ],
      ]),
    );
    // The rule withdrawal took a shown proposal away; the later note shows nowhere.
    expect(seqs.get(P)).toBe(6);
  });

  it('moves with a neighbour’s acceptance, a structure change, new generations, the process and the procedure', () => {
    const accepted = acceptedSteps([placement('step-bescheid', Q, 'accepted')], live);
    const neighbours = acceptedNeighbours(
      [{ status: 'accepted', fromRef: `${P}`, toRef: `${Q}` }],
      new Map([
        [`${P}`, P],
        [`${Q}`, Q],
      ]),
    );
    expect(hash({ neighbours })).not.toBe(hash());
    expect(hash({ neighbours, acceptedSteps: accepted })).not.toBe(hash({ neighbours }));
    // A proposed (not accepted) neighbour step does not count.
    expect(acceptedSteps([placement('step-bescheid', Q, 'proposed')], live).size).toBe(0);
    const renamed = prepareRevision(doc('Antragsprüfung')).structure;
    expect(hash({ chainDigest: digestOf(renamed) })).not.toBe(hash());
    const revived = new Map([...live].map(([id, g]) => [id, g + 1]));
    expect(hash({ chainDigest: digestOf(structure, revived) })).not.toBe(hash());
    const digests = (ref: Ref) => new Map([...base.processDigests, [ref, '0'.repeat(64)]]);
    expect(hash({ processDigests: digests(P) })).not.toBe(hash());
    // Another process (of the same model or another) does not move it.
    expect(hash({ processDigests: digests(Q) })).toBe(hash());
    expect(hash({ procedure: { id: 'proa-placements', version: '0.2.0' } })).not.toBe(hash());
  });
});

describe('processInputDigest', () => {
  const fact = (over: Partial<HeadFact>): HeadFact => ({
    ref: `verwaltung/antrag#${over.elementId ?? 'X'}` as Ref,
    modelKey: 'verwaltung/antrag',
    kind: 'task',
    elementId: 'X',
    processId: 'P_Antrag',
    scope: 'process',
    eventDef: null,
    label: '',
    keyRaw: '',
    keyNorm: '',
    fingerprint: '000000000000',
    attrs: {},
    processName: 'Antrag stellen',
    ...over,
  });
  const process = fact({
    ref: P,
    kind: 'process',
    elementId: 'P_Antrag',
    label: 'Antrag stellen',
    processId: null,
    attrs: { documentation: 'Ein Antrag geht ein.' },
  });
  const facts = (taskLabel: string, lane = 'Sachbearbeitung') => [
    process,
    fact({ kind: 'lane', elementId: 'Lane_1', label: lane }),
    fact({
      kind: 'evt_start',
      elementId: 'Start_1',
      label: 'Antrag eingegangen',
      attrs: { elementType: 'bpmn:StartEvent' },
    }),
    fact({ elementId: 'Task_1', label: taskLabel }),
  ];
  const digest = (all: HeadFact[]) =>
    processInputDigest(processOwnFields(process, factsByProcess(all).get(P) ?? []));

  it('covers what the claim shows of the process: name, lanes, starts, ends, documentation', () => {
    const fields = processOwnFields(process, factsByProcess(facts('Prüfen')).get(P) ?? []);
    expect(fields).toEqual({
      name: 'Antrag stellen',
      lanes: ['Sachbearbeitung'],
      starts: ['Antrag eingegangen'],
      ends: [],
      doc: 'Ein Antrag geht ein.',
    });
    expect(digest(facts('Prüfen'))).toBe(digest(facts('Prüfen')));
    expect(digest(facts('Prüfen', 'Leitung'))).not.toBe(digest(facts('Prüfen')));
    expect(processInputDigest({ ...fields, doc: 'Anders.' })).not.toBe(processInputDigest(fields));
  });

  it('ignores the rest of the model: a task label, another process', () => {
    expect(digest(facts('Umbenannt'))).toBe(digest(facts('Prüfen')));
    const other = fact({ elementId: 'Task_9', label: 'Fremd', processId: 'P_Anderer' });
    expect(digest([...facts('Prüfen'), other])).toBe(digest(facts('Prüfen')));
  });
});

describe('open and due processes', () => {
  it('is open without an accepted or held placement on a live generation', () => {
    const placements = [
      placement('step-antrag', P, 'accepted'),
      placement('step-bescheid', Q, 'held'),
      placement(OUTSIDE, N, 'accepted'),
    ];
    expect(openProcesses([P, Q, N], placements, live)).toEqual([]);
    // A removed step homes nothing; a proposal or a rejection leaves the process open.
    expect(
      openProcesses(
        [N, P, Q],
        [
          placement('step-antrag', P, 'accepted', 2),
          placement('step-bescheid', Q, 'proposed'),
          placement('step-bescheid', N, 'rejected'),
        ],
        live,
      ),
    ).toEqual([N, P, Q]);
  });

  it('is due without a verdict on the current input, sorted by ref', () => {
    const hashes = new Map([
      [P, 'h1'],
      [Q, 'h2'],
      [N, 'h3'],
    ]);
    expect(
      dueProcesses(
        [Q, P, N],
        hashes,
        new Map([
          [Q, { inputHash: 'h2' }],
          [P, { inputHash: 'old' }],
        ]),
      ),
    ).toEqual(
      [
        { process: P, inputHash: 'h1' },
        { process: N, inputHash: 'h3' },
      ].sort((a, b) => (a.process < b.process ? -1 : 1)),
    );
    expect(dueDigest([{ process: P, inputHash: 'h1' }])).toMatch(/^[0-9a-f]{64}$/);
    expect(dueDigest([{ process: P, inputHash: 'h1' }])).not.toBe(
      dueDigest([{ process: P, inputHash: 'h2' }]),
    );
  });
});

describe('selectClaimProcesses', () => {
  const due = Array.from({ length: 60 }, (_, i) => `m/p${String(i).padStart(2, '0')}#P`);

  it('takes at most 50 processes and reports the rest', () => {
    const r = selectClaimProcesses(due, (d) => ({ d }), 100);
    expect(r.selected).toHaveLength(MAX_CLAIM_PLACEMENT_PROCESSES);
    expect(r.truncated).toBe(true);
    expect(r.remaining).toBe(10);
    expect(r.selected[0]?.due).toBe(due[0]);
  });

  it('stops at the byte budget, but always takes the first process', () => {
    const big = (d: string) => ({ d, pad: 'x'.repeat(1000) });
    const r = selectClaimProcesses(due, big, 100, { maxBytes: 3500 });
    expect(r.selected).toHaveLength(3);
    expect(r.remaining).toBe(57);
    const huge = selectClaimProcesses(due, big, 100, { maxBytes: 10 });
    expect(huge.selected).toHaveLength(1);
    expect(huge.truncated).toBe(true);
    const all = selectClaimProcesses(due.slice(0, 2), big, 100);
    expect(all).toMatchObject({ truncated: false, remaining: 0 });
  });
});

describe('planPlacementSupersession', () => {
  const claimed = new Map([
    [P, { processDigest: 'f'.repeat(64) }],
    [Q, { processDigest: 'e'.repeat(64) }],
  ]);
  const plan = (
    proposals: ReturnType<typeof liveProposals>,
    over: Partial<Parameters<typeof planPlacementSupersession>[0]> = {},
  ) =>
    planPlacementSupersession({
      inputProcesses: claimed,
      chainDigest: CHAIN,
      procedure: PROC,
      caller: AGENT,
      submissionId: 'sub_NEW',
      proposals,
      repeated: new Set(),
      verdicts: new Set([P, Q]),
      ...over,
    }).map((x) => [x.placement.processRef, x.stance.principalId, x.reason]);

  it('withdraws any principal’s stale pipeline proposals and the caller’s unrepeated ones', () => {
    const a = placement('step-antrag', P, 'proposed');
    const b = placement('step-bescheid', P, 'proposed');
    const c = placement('step-antrag', Q, 'proposed');
    const histories = new Map<PlacementId, StoredPlacementAssertion[]>([
      // Another agent, current basis: stays.
      [a.id, [assertion(a, 1, { principalId: OTHER })]],
      // Another agent, made on another chain structure: stale.
      [b.id, [assertion(b, 2, { principalId: OTHER, stepHash: '0'.repeat(64) })]],
      // The caller's own, current, not repeated: replaced.
      [c.id, [assertion(c, 3, { processHash: 'e'.repeat(64) })]],
    ]);
    expect(plan(liveProposals([a, b, c], histories))).toEqual([
      [Q, AGENT, 'replaced'],
      [P, OTHER, 'stale'],
    ]);
    // Repeated by this submission: stays; no verdict on the process: stays.
    expect(plan(liveProposals([c], histories), { repeated: new Set([c.id]) })).toEqual([]);
    expect(plan(liveProposals([c], histories), { verdicts: new Set([P]) })).toEqual([]);
  });

  it('leaves ad-hoc and rule proposals, other processes, this submission and obsolete placements alone', () => {
    const a = placement('step-antrag', P, 'proposed');
    const b = placement('step-bescheid', N, 'proposed');
    const o = placement('step-studium', P, 'obsolete');
    const histories = new Map<PlacementId, StoredPlacementAssertion[]>([
      [
        a.id,
        [
          assertion(a, 1, { submissionId: null, stepHash: null, processHash: null }),
          assertion(a, 2, {
            principalId: 'prn_RULES',
            sourceKind: 'rule',
            submissionId: null,
            stepHash: null,
            processHash: null,
          }),
          assertion(a, 3, {
            principalId: OTHER,
            submissionId: 'sub_NEW' as StoredPlacementAssertion['submissionId'],
            stepHash: '0'.repeat(64),
          }),
        ],
      ],
      [b.id, [assertion(b, 4, { stepHash: '0'.repeat(64) })]],
      [o.id, [assertion(o, 5, { stepHash: '0'.repeat(64) })]],
    ]);
    expect(plan(liveProposals([a, b, o], histories))).toEqual([]);
  });

  it('counts another procedure as stale', () => {
    const a = placement('step-antrag', P, 'proposed');
    const histories = new Map([
      [
        a.id,
        [
          assertion(a, 1, {
            principalId: OTHER,
            declared: { procedure: { id: 'proa-placements', version: '0.0.9' }, llmModel: null },
          }),
        ],
      ],
    ]);
    expect(plan(liveProposals([a], histories))).toEqual([[P, OTHER, 'stale']]);
  });
});

describe('claim rendering', () => {
  it('lists steps without geometry, with resolved process links only', () => {
    const steps = claimSteps(structure, new Set([N]));
    expect(steps.map((s) => s.id)).toEqual([
      'step-antrag',
      'step-bescheid',
      'step-studium',
      'step-verwaltung',
    ]);
    expect(steps.find((s) => s.id === 'step-studium')).toMatchObject({ link: N, depth: 0 });
    expect(steps.find((s) => s.id === 'step-antrag')).toMatchObject({
      parentId: 'step-verwaltung',
      path: ['Verwaltung', 'Antrag'],
      children: [],
    });
    expect(
      claimSteps(structure, new Set()).find((s) => s.id === 'step-studium'),
    ).not.toHaveProperty('link');
  });

  it('gives up to 5 accepted examples per live step', () => {
    const refs = Array.from({ length: 7 }, (_, i) => `m/p${i}#P` as Ref);
    const examples = claimExamples(
      [
        ...refs.map((r) => placement('step-antrag', r, 'accepted')),
        placement('step-bescheid', P, 'accepted', 2),
        placement(OUTSIDE, Q, 'accepted'),
        placement('step-bescheid', N, 'proposed'),
      ],
      live,
      new Map([[Q, 'Bescheid']]),
    );
    expect(examples.filter((e) => e.step === 'step-antrag')).toHaveLength(5);
    expect(examples.some((e) => e.step === 'step-bescheid')).toBe(false);
    expect(examples).toContainEqual({ step: OUTSIDE, process: Q, name: 'Bescheid' });
  });

  it('shows proposals on live steps (with notes while undecided), human decisions with notes, and an earlier unsure verdict', () => {
    const live1 = placement('step-antrag', P, 'proposed');
    const rejected = placement('step-bescheid', P, 'rejected');
    const removed = placement('step-alt', P, 'accepted', 1);
    const histories = new Map<PlacementId, StoredPlacementAssertion[]>([
      [
        live1.id,
        [
          assertion(live1, 1, { rationale: 'x'.repeat(500), question: 'Wirklich?' }),
          assertion(live1, 6, {
            kind: 'note',
            sourceKind: 'human',
            principalId: 'prn_HUMAN',
            rationale: 'n'.repeat(400),
          }),
        ],
      ],
      [
        rejected.id,
        [
          assertion(rejected, 2, { principalId: OTHER }),
          assertion(rejected, 3, {
            kind: 'decision',
            verdict: 'reject',
            sourceKind: 'human',
            principalId: 'prn_HUMAN',
            rationale: 'Gehört zur Studienverwaltung.',
          }),
          assertion(rejected, 4, {
            kind: 'note',
            sourceKind: 'human',
            principalId: 'prn_HUMAN',
            rationale: 'Antwort',
          }),
        ],
      ],
      [
        removed.id,
        [
          assertion(removed, 5, {
            kind: 'decision',
            verdict: 'accept',
            sourceKind: 'human',
            principalId: 'prn_HUMAN',
            rationale: null,
          }),
        ],
      ],
    ]);
    const rendered = claimProcess({
      unplaced: {
        process: P,
        name: 'Antrag',
        modelKey: 'verwaltung/antrag',
        lanes: [],
        starts: [],
        ends: [],
        neighbours: Array.from({ length: 25 }, (_, i) => ({
          process: `m/n${i}#P` as Ref,
          via: Array.from({ length: 5 }, (__, j) => ({
            relationId: `rel_${i}_${j}` as never,
            type: 'message' as const,
            direction: 'out' as const,
          })),
          steps: [],
        })),
        calls: { out: [], in: [] },
        hints: [],
      },
      placements: [live1, rejected, removed],
      histories,
      live,
      row: {
        projectId: 'prj_X',
        valueChainId: 'vch_X',
        processRef: P,
        inputHash: 'old',
        taskId: null,
        principalId: AGENT,
        outcome: 'unsure',
        reason: 'r'.repeat(400),
        seq: 1,
        handle: 'agent:sim',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      claimant: AGENT,
    });
    expect(rendered.neighbours).toHaveLength(20);
    expect(rendered.neighbours[0]?.via).toHaveLength(3);
    // A stance on a rejected placement is still its proposer's: listed with the status.
    expect(rendered.proposals).toEqual([
      expect.objectContaining({ step: 'step-antrag', mine: true, question: 'Wirklich?' }),
      expect.objectContaining({ step: 'step-bescheid', status: 'rejected', by: 'agent:sim' }),
    ]);
    expect(rendered.proposals[1]).not.toHaveProperty('mine');
    expect(rendered.proposals[0]?.rationale).toHaveLength(200);
    // A note on the undecided placement reaches the agent on its proposal (cut at 300); a
    // decided placement's notes come with its decision only.
    expect(rendered.proposals[0]?.notes).toEqual([
      { text: 'n'.repeat(300), at: new Date(6000).toISOString() },
    ]);
    expect(rendered.proposals[1]).not.toHaveProperty('notes');
    expect(rendered.decisions).toEqual([
      expect.objectContaining({ step: 'step-alt', stepLive: false, verdict: 'accept' }),
      expect.objectContaining({
        step: 'step-bescheid',
        stepLive: true,
        verdict: 'reject',
        note: 'Gehört zur Studienverwaltung.',
        notes: [{ text: 'Antwort', at: new Date(4000).toISOString() }],
      }),
    ]);
    expect(rendered.unsure?.reason).toHaveLength(300);
    expect(rendered.unsure?.by).toBe('agent:sim');
  });
});

describe('the task view of both subjects', () => {
  const lease = {
    state: 'claimed' as const,
    seq: 3,
    attempts: 1,
    leaseTokenHash: null,
    claimedBy: AGENT,
    claimedByHandle: 'agent:sim',
    leaseUntil: new Date(60_000),
    lastError: null,
    submissionId: null,
    claimedSeq: 4,
    requeueAfter: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };

  it('fills the subject’s fields and nulls the other’s', () => {
    expect(
      toAnalysisTask({
        ...lease,
        id: 'ana_M',
        projectId: 'prj_X',
        subjectKind: 'model',
        kind: 'relations',
        modelId: 'mdl_M',
        modelKey: 'a/b',
        revisionId: 'rev_M',
        factsHash: 'f'.repeat(64),
        assignment: null,
      }),
    ).toMatchObject({
      kind: 'relations',
      subjectKind: 'model',
      modelKey: 'a/b',
      factsHash: 'f'.repeat(64),
      valueChainId: null,
      valueChainKey: null,
      valueChainRevisionId: null,
      inputHash: null,
      claimedBy: 'agent:sim',
    });
    expect(
      toAnalysisTask({
        ...lease,
        id: 'ana_C',
        projectId: 'prj_X',
        subjectKind: 'value_chain',
        kind: 'placement',
        valueChainId: 'vch_C',
        valueChainKey: 'main',
        valueChainRevisionId: 'vcr_C',
        inputHash: 'e'.repeat(64),
        placementClaim: null,
      }),
    ).toMatchObject({
      kind: 'placement',
      subjectKind: 'value_chain',
      valueChainKey: 'main',
      inputHash: 'e'.repeat(64),
      modelId: null,
      modelKey: null,
      revisionId: null,
      factsHash: null,
    });
  });
});
