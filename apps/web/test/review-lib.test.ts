import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/lib/api';
import { correctionCandidates, endpointRole, labelSimilarity } from '../src/lib/endpoints';
import {
  bulkFlags,
  genericFlags,
  isGenericName,
  nameKey,
  nameUsage,
  nameWords,
} from '../src/lib/generic-names';
import { procedureText, provenanceOf } from '../src/lib/labels';
import {
  answersSinceHold,
  conflictOf,
  currentProposal,
  evidenceItems,
  finishesModels,
  heldList,
  neighbours,
  parseQueueFilters,
  isReviewItem,
  proposalsByTier,
  reviewQueue,
  stageCounts,
} from '../src/lib/review';
import { assertion, fact, model, provenance, relation } from './support/fixtures';

const models = [
  model({ key: 'a', stage: 'waiting_for_review', openItems: 3 }),
  model({ key: 'b', stage: 'waiting_for_review', openItems: 1 }),
  model({ key: 'c', stage: 'incorporated', openItems: 0 }),
  model({ key: 'd', stage: 'waiting_for_clarification', openItems: 1 }),
];

const r = (
  id: string,
  from: string,
  to: string,
  extra: Parameters<typeof relation>[0] | object = {},
) => relation({ id, from, to, ...extra });

describe('review queue', () => {
  const relations = [
    r('rel_low', 'a#x', 'c#y', { confidence: 0.4, tier: 'lexical' }),
    r('rel_key_a', 'a#m', 'c#n', { confidence: 1, tier: 'key' }),
    r('rel_key_b', 'a#k', 'b#l', { confidence: 1, tier: 'key' }),
    r('rel_mid', 'a#p', 'c#q', { confidence: 0.7, tier: 'semantic' }),
    r('rel_accepted', 'a#z', 'c#z', { status: 'accepted', tier: 'rule' }),
    r('rel_held', 'a#h', 'd#h', { status: 'held', tier: 'lexical' }),
  ];

  it('sorts open proposals by confidence, then by models a decision finishes', () => {
    const queue = reviewQueue(relations, models);
    expect(queue.map((q) => q.relation.id)).toEqual([
      'rel_key_b', // 1.0 and finishes model b (its only open item)
      'rel_key_a',
      'rel_mid',
      'rel_low',
    ]);
    expect(queue[0]!.finishes).toBe(1);
    expect(queue[1]!.finishes).toBe(0);
  });

  it('includes accepted relations whose endpoint changed or is missing, never in bulk', () => {
    const withChanged = [
      ...relations,
      r('rel_changed', 'a#c', 'b#c', { status: 'accepted', endpointState: 'changed', tier: 'key' }),
      r('rel_missing', 'a#g', 'x#g', {
        status: 'accepted',
        endpointState: 'missing',
        tier: 'lexical',
        confidence: 0.3,
      }),
    ];
    expect(isReviewItem(withChanged[4]!)).toBe(false);
    expect(isReviewItem(withChanged[5]!)).toBe(false);
    expect(isReviewItem(withChanged[6]!)).toBe(true);
    const queue = reviewQueue(withChanged, models);
    expect(queue.map((q) => q.relation.id)).toEqual([
      'rel_changed', // 1.0, finishes b like rel_key_b, and a#c sorts before a#k
      'rel_key_b',
      'rel_key_a',
      'rel_mid',
      'rel_low',
      'rel_missing',
    ]);
    expect(proposalsByTier(queue).map((g) => [g.tier, g.items.map((x) => x.id)])).toEqual([
      ['key', ['rel_key_b', 'rel_key_a']],
      ['lexical', ['rel_low']],
      ['semantic', ['rel_mid']],
    ]);
  });

  it('filters by tier, model and the stage of either model', () => {
    expect(reviewQueue(relations, models, { tier: 'key' }).map((q) => q.relation.id)).toEqual([
      'rel_key_b',
      'rel_key_a',
    ]);
    expect(reviewQueue(relations, models, { model: 'b' }).map((q) => q.relation.id)).toEqual([
      'rel_key_b',
    ]);
    // every proposal touches model a (waiting for review); none touches only incorporated models
    expect(reviewQueue(relations, models, { stage: 'incorporated' })).toHaveLength(3);
    expect(reviewQueue(relations, models, { stage: 'agent_failed' })).toHaveLength(0);
  });

  it('keeps held relations in their own list, oldest hold first', () => {
    const held = [
      r('rel_h2', 'a#1', 'b#1', {
        status: 'held',
        provenance: provenance({ kind: 'decision', verdict: 'hold', at: '2026-10-08T10:00:00Z' }),
      }),
      r('rel_h1', 'a#2', 'b#2', {
        status: 'held',
        provenance: provenance({ kind: 'decision', verdict: 'hold', at: '2026-10-07T10:00:00Z' }),
      }),
      ...relations,
    ];
    // without provenance the update time counts (09:00, before both holds)
    expect(heldList(held, models).map((x) => x.id)).toEqual(['rel_held', 'rel_h1', 'rel_h2']);
    expect(heldList(held, models, { stage: 'waiting_for_clarification' }).map((x) => x.id)).toEqual(
      ['rel_held'],
    );
  });

  it('counts models per stage, every stage present', () => {
    expect(stageCounts(models)).toEqual({
      waiting_for_agent: 0,
      agent_working: 0,
      agent_failed: 0,
      waiting_for_review: 2,
      waiting_for_clarification: 1,
      incorporated: 1,
    });
  });

  it('groups proposals per tier for the bulk actions', () => {
    const groups = proposalsByTier(reviewQueue(relations, models));
    expect(groups.map((g) => [g.tier, g.items.length])).toEqual([
      ['key', 2],
      ['lexical', 1],
      ['semantic', 1],
    ]);
  });

  it('finds the neighbours in the queue; outside of it, next is the first item', () => {
    const queue = reviewQueue(relations, models);
    expect(neighbours(queue, 'rel_key_a')).toMatchObject({
      index: 1,
      previous: { id: 'rel_key_b' },
      next: { id: 'rel_mid' },
    });
    expect(neighbours(queue, 'rel_low').next).toBeNull();
    expect(neighbours(queue, 'rel_held')).toMatchObject({
      index: -1,
      previous: null,
      next: { id: 'rel_key_b' },
    });
  });

  it('counts a model as finished only when the relation is its last open item', () => {
    const open = new Map([
      ['a', 1],
      ['b', 1],
    ]);
    expect(finishesModels({ from: 'a#1', to: 'b#1' }, open)).toBe(2);
    expect(finishesModels({ from: 'a#1', to: 'a#2' }, open)).toBe(1);
    expect(finishesModels({ from: 'c#1', to: 'b#1' }, open)).toBe(1);
  });

  it('parses only known filter values from the URL', () => {
    expect(
      parseQueueFilters({ stage: 'agent_failed', tier: 'key', model: 'x/y', other: 1 }),
    ).toEqual({ stage: 'agent_failed', tier: 'key', model: 'x/y' });
    expect(parseQueueFilters({ stage: 'nope', tier: 7, model: '' })).toEqual({});
  });
});

describe('evidence, proposals and answers', () => {
  it('turns refs into known models into clickable items, everything else stays text', () => {
    expect(
      evidenceItems(
        ['a#Task_1', 'unbekannt/modell#X', 'Laut Fachkonzept 4.2', '<b>a#y</b>'],
        new Set(['a']),
      ),
    ).toEqual([
      { kind: 'ref', text: 'a#Task_1', modelKey: 'a', elementId: 'Task_1' },
      { kind: 'text', text: 'unbekannt/modell#X' },
      { kind: 'text', text: 'Laut Fachkonzept 4.2' },
      { kind: 'text', text: '<b>a#y</b>' },
    ]);
  });

  it('takes the proposal the status rests on, else the latest proposal', () => {
    const history = [
      assertion({ id: 'ast_1', rationale: 'alt' }),
      assertion({ id: 'ast_2', rationale: 'neu' }),
      assertion({ id: 'ast_3', kind: 'decision', verdict: 'hold', sourceKind: 'human' }),
    ];
    expect(currentProposal({ provenance: provenance({ assertionId: 'ast_1' }) }, history)?.id).toBe(
      'ast_1',
    );
    expect(currentProposal({ provenance: provenance({ assertionId: 'ast_3' }) }, history)?.id).toBe(
      'ast_2',
    );
    expect(currentProposal({ provenance: null }, [])).toBeNull();
  });

  it('lists the notes given after the current hold', () => {
    const history = [
      assertion({ id: 'ast_n0', kind: 'note', sourceKind: 'human', rationale: 'vorher' }),
      assertion({ id: 'ast_hold', kind: 'decision', verdict: 'hold', sourceKind: 'human' }),
      assertion({ id: 'ast_n1', kind: 'note', sourceKind: 'human', rationale: 'Antwort' }),
    ];
    const held = { provenance: provenance({ assertionId: 'ast_hold' }) };
    expect(answersSinceHold(held, history).map((a) => a.id)).toEqual(['ast_n1']);
  });
});

describe('conflicts', () => {
  const problem = (extras: Record<string, unknown>, code = 'conflict', status = 409) =>
    new ApiError(
      { type: `urn:proa:problem:${code}`, title: 'Conflict', status, code, ...extras } as never,
      status,
    );

  it('names the versions of a single decision', () => {
    const c = conflictOf(problem({ version: 5, detail: 'the relation is at version 5' }), 3);
    expect(c?.title).toBe('Die Relation wurde inzwischen geändert');
    expect(c?.description).toContain('Version 5');
    expect(c?.description).toContain('du hast Version 3 gesehen');
    expect(c?.description).toContain('nicht gespeichert');
    expect(conflictOf(problem({ version: 4 }, 'precondition-failed', 412))?.title).toBe(
      'Die Relation wurde inzwischen geändert',
    );
  });

  it('explains bulk mismatches and obsolete relations', () => {
    expect(
      conflictOf(problem({ mismatches: [{ id: 'rel_1', reason: 'version' }, { id: 'rel_2' }] }))
        ?.description,
    ).toContain('2 Relationen haben sich');
    expect(conflictOf(problem({ expectedCount: 3, received: 2 }))?.title).toBe(
      'Die Liste hat sich geändert',
    );
    expect(
      conflictOf(problem({ detail: 'an obsolete relation cannot be decided' }))?.description,
    ).toContain('an obsolete relation cannot be decided');
  });

  it('ignores everything that is not a conflict', () => {
    expect(conflictOf(problem({}, 'validation-failed', 422))).toBeNull();
    expect(conflictOf(new Error('offline'))).toBeNull();
  });
});

describe('generic names', () => {
  it('splits camelCase, folds umlauts and drops punctuation', () => {
    expect(nameWords('ZahlungZugeordnet')).toEqual(['zahlung', 'zugeordnet']);
    expect(nameWords('Großstörung beendet!')).toEqual(['grossstoerung', 'beendet']);
    expect(nameKey('Ware_versandbereit')).toBe(nameKey('WareVersandbereit'));
  });

  it('flags names made of generic words only', () => {
    expect(isGenericName('Antwort erhalten')).toBe(true);
    expect(isGenericName('Daten aktualisiert')).toBe(true);
    expect(isGenericName('Antwort')).toBe(true);
    expect(isGenericName('Rueckmeldung')).toBe(true);
    expect(isGenericName('Die Daten wurden aktualisiert')).toBe(false); // "wurden" is not a stop word
    expect(isGenericName('Rechnung erstellt')).toBe(false);
    expect(isGenericName('LieferungVersendet')).toBe(false);
    expect(isGenericName('')).toBe(false);
  });

  it('flags generic message names and names more than two processes share', () => {
    const facts = [
      fact({
        modelKey: 'a',
        elementId: 'T',
        kind: 'msg_throw',
        processId: 'P_a',
        label: 'Antwort senden',
        attrs: { messageName: 'Antwort' },
      }),
      fact({
        modelKey: 'b',
        elementId: 'C',
        kind: 'msg_catch',
        processId: 'P_b',
        label: 'Antwort erhalten',
        attrs: { messageName: 'Antwort' },
      }),
      fact({
        modelKey: 'c',
        elementId: 'C',
        kind: 'msg_catch',
        processId: 'P_c',
        label: 'Antwort da',
        attrs: { messageName: 'antwort' },
      }),
      fact({
        modelKey: 'a',
        elementId: 'R',
        kind: 'msg_throw',
        processId: 'P_a',
        label: 'Rechnung versenden',
        attrs: { messageName: 'RechnungVersendet' },
      }),
      fact({
        modelKey: 'b',
        elementId: 'R',
        kind: 'msg_catch',
        processId: 'P_b',
        label: 'Rechnung erhalten',
        attrs: { messageName: 'RechnungVersendet' },
      }),
    ];
    const usage = nameUsage(facts);
    const labels = new Map(facts.map((f) => [f.ref, f.label]));
    const labelOf = (ref: string) => labels.get(ref) ?? null;

    const generic = genericFlags(
      relation({ id: 'rel_1', from: 'a#T', to: 'b#C', attrs: { messageName: 'Antwort' } }),
      labelOf,
      usage,
    );
    expect(generic.map((f) => [f.kind, f.text])).toEqual([
      ['generic-word', 'Antwort'],
      ['generic-word', 'Antwort senden'],
      ['generic-word', 'Antwort erhalten'],
      ['shared-name', 'Antwort'],
    ]);
    expect(generic[3]!.detail).toContain('in 3 Prozessen vor (1 sendet, 2 empfangen)');

    expect(
      genericFlags(
        relation({
          id: 'rel_2',
          from: 'a#R',
          to: 'b#R',
          attrs: { messageName: 'RechnungVersendet' },
        }),
        labelOf,
        usage,
      ),
    ).toEqual([]);
  });
});

describe('bulk accept flags', () => {
  const none = () => null;
  const usage = nameUsage([]);

  it('adds an open agent question, cut for the preview', () => {
    const long = `Gilt das ${'auch für Teillieferungen und '.repeat(10)}Rücksendungen?`;
    const flags = bulkFlags(
      relation({
        id: 'rel_q',
        from: 'a#T',
        to: 'b#C',
        attrs: { messageName: 'RechnungVersendet' },
        provenance: provenance({ question: long }),
      }),
      none,
      usage,
    );
    expect(flags.map((f) => f.kind)).toEqual(['agent-question']);
    expect(flags[0]!.text).toBe(long);
    expect(flags[0]!.detail.startsWith('Der Agent fragt nach: „Gilt das auch')).toBe(true);
    expect(flags[0]!.detail.endsWith('…“')).toBe(true);
    expect(flags[0]!.detail.length).toBeLessThan(200);
  });

  it('adds an ambiguous call target, and nothing for a plain pair', () => {
    const call = relation({
      id: 'rel_c',
      type: 'call',
      from: 'a#Call',
      to: 'b#P',
      attrs: { match: 'duplicate-process-id', calledElement: 'P' },
    });
    expect(bulkFlags(call, none, usage).map((f) => [f.kind, f.text])).toEqual([
      ['ambiguous-target', 'P'],
    ]);
    expect(
      bulkFlags(
        { ...call, attrs: { calledElement: 'P' }, provenance: provenance({ question: '  ' }) },
        none,
        usage,
      ),
    ).toEqual([]);
  });
});

describe('endpoints for corrections', () => {
  it('mirrors the endpoint roles of @proa/relations', () => {
    const f = (o: Partial<Parameters<typeof fact>[0]>) =>
      endpointRole(fact({ modelKey: 'm', elementId: 'e', kind: 'msg_catch', ...o }));
    expect(f({ kind: 'msg_catch', eventDef: 'message' })).toEqual({ type: 'message', side: 'to' });
    expect(f({ kind: 'msg_throw', eventDef: null })).toEqual({ type: 'message', side: 'from' });
    expect(f({ kind: 'sig_throw', eventDef: 'signal' })).toEqual({ type: 'signal', side: 'from' });
    expect(f({ kind: 'sig_catch', eventDef: null })).toBeNull();
    expect(f({ kind: 'call', eventDef: null })).toEqual({ type: 'call', side: 'from' });
    expect(f({ kind: 'process', eventDef: null })).toEqual({ type: 'call', side: 'to' });
    // trigger: labelled none ends and starts directly in a process
    expect(
      f({
        kind: 'evt_end',
        eventDef: 'none',
        label: 'Fertig',
        attrs: { elementType: 'bpmn:EndEvent' },
      }),
    ).toEqual({ type: 'trigger', side: 'from' });
    expect(f({ kind: 'evt_end', eventDef: 'none', label: '' })).toBeNull();
    expect(f({ kind: 'evt_end', eventDef: 'terminate', label: 'Ende' })).toBeNull();
    expect(f({ kind: 'evt_start', eventDef: 'timer', label: 'Täglich' })).toBeNull();
    expect(
      f({ kind: 'evt_start', eventDef: 'none', label: 'Los', scope: 'subprocess' }),
    ).toBeNull();
    // scope rule: no starts/ends inside embedded subprocesses, no ends in event subprocesses
    expect(
      f({
        kind: 'msg_catch',
        eventDef: 'message',
        scope: 'subprocess',
        attrs: { elementType: 'bpmn:StartEvent' },
      }),
    ).toBeNull();
    expect(
      f({
        kind: 'msg_catch',
        eventDef: 'message',
        scope: 'event_subprocess',
        attrs: { elementType: 'bpmn:StartEvent' },
      }),
    ).toEqual({ type: 'message', side: 'to' });
    expect(
      f({
        kind: 'msg_throw',
        eventDef: 'message',
        scope: 'event_subprocess',
        attrs: { elementType: 'bpmn:EndEvent' },
      }),
    ).toBeNull();
    expect(
      f({
        kind: 'msg_catch',
        eventDef: 'message',
        scope: 'subprocess',
        attrs: { elementType: 'bpmn:IntermediateCatchEvent' },
      }),
    ).toEqual({ type: 'message', side: 'to' });
    expect(f({ kind: 'task' })).toBeNull();
  });

  const facts = [
    fact({
      modelKey: 'shop',
      elementId: 'Throw',
      kind: 'msg_throw',
      eventDef: 'message',
      processId: 'P_shop',
      label: 'Ware versandbereit',
    }),
    fact({
      modelKey: 'billing',
      elementId: 'Wrong',
      kind: 'msg_catch',
      eventDef: 'message',
      processId: 'P_bill',
      label: 'Zahlung eingegangen',
    }),
    fact({
      modelKey: 'billing',
      elementId: 'Right',
      kind: 'msg_catch',
      eventDef: 'message',
      processId: 'P_bill',
      label: 'Ware ist versandbereit',
    }),
    fact({
      modelKey: 'shipping',
      elementId: 'Other',
      kind: 'msg_catch',
      eventDef: 'message',
      processId: 'P_ship',
      label: 'Versand starten',
    }),
    fact({
      modelKey: 'shop',
      elementId: 'Own',
      kind: 'msg_catch',
      eventDef: 'message',
      processId: 'P_shop',
      label: 'Ware versandbereit',
    }),
    fact({
      modelKey: 'billing',
      elementId: 'Sig',
      kind: 'sig_catch',
      eventDef: 'signal',
      processId: 'P_bill',
      label: 'Ware versandbereit',
    }),
    fact({
      modelKey: 'billing',
      elementId: 'P_bill',
      kind: 'process',
      processId: 'P_bill',
      label: 'Rechnung',
    }),
  ];

  it('offers compatible elements in other processes, the most similar first', () => {
    const rel = { type: 'message' as const, from: 'shop#Throw', to: 'billing#Wrong' };
    const withMore = [
      ...facts,
      fact({
        modelKey: 'accounting',
        elementId: 'Mahnung',
        kind: 'msg_catch',
        eventDef: 'message',
        processId: 'P_acc',
        label: 'Mahnung erhalten',
      }),
    ];
    const ranked = correctionCandidates(rel, 'to', withMore);
    // "Ware ist versandbereit" shares words with the sender that stays; the rest by model key
    expect(ranked.map((c) => c.fact.ref)).toEqual([
      'billing#Right',
      'accounting#Mahnung',
      'shipping#Other',
    ]);
    expect(ranked[0]!.score).toBeGreaterThan(0);
    // replacing the sender: only throws, never in the receiver's process
    expect(correctionCandidates(rel, 'from', facts).map((c) => c.fact.ref)).toEqual([]);
  });

  it('allows any endpoint for a manual relation', () => {
    const rel = { type: 'manual' as const, from: 'shop#Throw', to: 'billing#Wrong' };
    const refs = correctionCandidates(rel, 'to', facts).map((c) => c.fact.ref);
    expect(refs).toContain('billing#Sig');
    expect(refs).toContain('billing#P_bill');
    expect(refs).not.toContain('shop#Own');
    expect(refs).not.toContain('billing#Wrong');
  });

  it('measures label similarity by shared words', () => {
    expect(labelSimilarity('Ware versandbereit', 'Ware ist versandbereit')).toBeCloseTo(2 / 3);
    expect(labelSimilarity('Ware', '')).toBe(0);
  });
});

describe('provenance from the API', () => {
  const base = { tier: 'semantic' as const, type: 'message' as const, attrs: {} };

  it('shows the agent handle with declared procedure and model', () => {
    expect(provenanceOf({ ...base, provenance: provenance() })).toEqual({
      source: 'agent',
      label: 'agent:claude code',
      detail: 'proa-relations@0.1.0 · claude-sonnet-5-5',
    });
  });

  it('shows the rule tier as proa-rules/1.0.0 and human decisions with their verdict', () => {
    expect(
      provenanceOf({
        tier: 'key',
        type: 'message',
        attrs: {},
        provenance: provenance({
          sourceKind: 'rule',
          handle: 'proa-rules',
          clientId: null,
          procedure: { id: 'proa-rules', version: '1.0.0' },
          llmModel: null,
        }),
      }),
    ).toEqual({ source: 'rule', label: 'proa-rules/1.0.0', detail: 'gleicher Nachrichtenname' });
    const human = provenance({
      sourceKind: 'human',
      handle: 'owner',
      kind: 'decision',
      verdict: 'reject',
      procedure: null,
      llmModel: null,
    });
    expect(provenanceOf({ ...base, provenance: human })).toEqual({
      source: 'human',
      label: 'owner',
      detail: 'abgelehnt',
    });
    expect(
      provenanceOf({ ...base, tier: 'manual', provenance: { ...human, verdict: 'accept' } }).detail,
    ).toBe('manuell angelegt');
  });

  it('writes procedures like the concept does', () => {
    expect(procedureText({ id: 'proa-rules', version: '1.0.0' })).toBe('proa-rules/1.0.0');
    expect(procedureText({ id: 'proa-relations', version: '0.1.0' })).toBe('proa-relations@0.1.0');
    expect(procedureText(null)).toBeNull();
  });
});
