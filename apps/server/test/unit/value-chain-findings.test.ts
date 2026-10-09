/**
 * Findings of the value chain (M4 §3.4, S2), a pure function of the head
 * structure, the live step generations, the head processes, the placements
 * and the accepted calls: processes without a step (with their review state
 * and the steps of their callers), steps without a process at the topmost
 * level, unresolved links. Synthetic chains only.
 */
import type { Ref, RelationStatus } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import { prepareRevision } from '../../src/domain/value-chain/document.ts';
import {
  processHomes,
  unplacedState,
  valueChainFindings,
  type FindingsInput,
} from '../../src/domain/value-chain/findings.ts';
import { OUTSIDE } from '../../src/domain/value-chain/steps.ts';
import { chain } from '../support/value-chain.ts';

const A = 'vertrieb/auftrag#P_Auftrag' as Ref;
const R = 'finanzen/rechnung#P_Rechnung' as Ref;
const V = 'lager/versand#P_Versand' as Ref;
const X = 'archiv/alt#P_Alt' as Ref;

const structure = prepareRevision(
  chain({
    steps: [
      { id: 'step-vertrieb', name: 'Vertrieb' },
      { id: 'step-eingang', name: 'Auftragseingang', parent: 'step-vertrieb' },
      { id: 'step-pruefung', name: 'Prüfung', parent: 'step-vertrieb' },
      { id: 'step-logistik', name: 'Logistik', link: 'https://wiki.example.org/logistik' },
      { id: 'step-versand', name: 'Versand', parent: 'step-logistik' },
      { id: 'step-fakt', name: 'Fakturierung', link: 'operations-detail' },
      { id: 'step-rechnung', name: 'Rechnungsstellung', parent: 'step-fakt' },
      { id: 'step-mahn', name: 'Mahnwesen', parent: 'step-fakt', link: `proa:process/${R}` },
      { id: 'step-kasse', name: 'Kasse', parent: 'step-fakt', link: 'proa:process/x/fehlt#P' },
      { id: 'step-bank', name: 'Bank', parent: 'step-fakt', link: 'proa:process/kein ref' },
    ],
  }),
).structure;

const live = new Map<string, number>([
  ...structure.steps.map((s) => [s.elementId, 1] as const),
  [OUTSIDE, 1],
]);

const placement = (elementId: string, processRef: Ref, status: RelationStatus, generation = 1) => ({
  elementId,
  generation,
  processRef,
  status,
});

const input = (over: Partial<FindingsInput> = {}): FindingsInput => ({
  structure,
  live,
  processes: [A, R, V, X],
  placements: [],
  calls: [],
  ...over,
});

const kinds = (over: Partial<FindingsInput>, kind: string) =>
  valueChainFindings(input(over)).filter((f) => f.kind === kind);

describe('process-without-step', () => {
  it('lists every head process without an accepted placement on a live step, by ref', () => {
    const found = kinds(
      {
        placements: [
          placement('step-eingang', A, 'accepted'),
          // @outside counts as placed.
          placement(OUTSIDE, X, 'accepted'),
          // An accepted placement on a removed generation does not.
          placement('step-rechnung', R, 'accepted', 0),
          placement('step-versand', V, 'rejected'),
        ],
      },
      'process-without-step',
    );
    expect(found.map((f) => [f.process, f.state])).toEqual([
      [R, 'none'],
      [V, 'none'],
    ]);
    expect(found[0]).toMatchObject({ elementId: null, link: null, calledFrom: [] });
    expect(found[0]?.detail).toMatch(/no placement is proposed/);
  });

  it('reports a pending or held placement on a live step, held first', () => {
    const found = kinds(
      {
        placements: [
          placement('step-eingang', A, 'proposed'),
          placement('step-rechnung', R, 'proposed'),
          placement('step-mahn', R, 'held'),
          placement('step-versand', V, 'obsolete'),
          // On a removed generation, nothing is pending.
          placement('step-eingang', X, 'proposed', 0),
        ],
      },
      'process-without-step',
    );
    expect(found.map((f) => [f.process, f.state])).toEqual([
      [X, 'none'],
      [R, 'held'],
      [V, 'none'],
      [A, 'proposed'],
    ]);
  });

  it('names the steps of accepted callers as hints, never @outside', () => {
    const found = kinds(
      {
        placements: [
          placement('step-eingang', A, 'accepted'),
          placement('step-pruefung', A, 'accepted'),
          placement(OUTSIDE, X, 'accepted'),
          placement('step-rechnung', R, 'proposed'),
        ],
        calls: [
          { caller: A, callee: V },
          { caller: X, callee: V },
          // A caller without an accepted step gives no hint; a self-call is ignored.
          { caller: R, callee: V },
          { caller: V, callee: V },
        ],
      },
      'process-without-step',
    );
    const versand = found.find((f) => f.process === V);
    expect(versand?.calledFrom).toEqual([
      { elementId: 'step-eingang', process: A },
      { elementId: 'step-pruefung', process: A },
    ]);
    expect(versand?.detail).toMatch(/called from step-eingang, step-pruefung/);
  });
});

describe('step-without-process', () => {
  it('reports the topmost steps without an accepted placement on them or below them', () => {
    const found = kinds(
      {
        placements: [
          placement('step-eingang', A, 'accepted'),
          // Proposed, held and removed placements do not count.
          placement('step-versand', V, 'proposed'),
          placement('step-logistik', R, 'held'),
          placement('step-mahn', R, 'accepted', 0),
        ],
      },
      'step-without-process',
    );
    expect(found.map((f) => f.elementId)).toEqual(['step-fakt', 'step-logistik', 'step-pruefung']);
    expect(found[0]?.detail).toBe('No process is accepted on "Fakturierung" or its sub-steps.');
    expect(found[2]?.detail).toBe('No process is accepted on "Prüfung".');
  });

  it('does not count an accepted placement of a process that left the head', () => {
    const found = kinds(
      { processes: [A, R, X], placements: [placement('step-versand', V, 'accepted')] },
      'step-without-process',
    );
    expect(found.map((f) => f.elementId)).toContain('step-logistik');
  });

  it('reports nothing for a chain whose leaves all have a process', () => {
    const leaves = structure.steps.filter((s) => s.childIds.length === 0);
    const found = kinds(
      { placements: leaves.map((s) => placement(s.elementId, A, 'accepted')) },
      'step-without-process',
    );
    expect(found).toEqual([]);
  });
});

describe('unresolved-link', () => {
  it('reports opaque links and proa: links without a head process, never URLs', () => {
    const found = kinds({}, 'unresolved-link');
    expect(found.map((f) => [f.elementId, f.link])).toEqual([
      ['step-bank', 'proa:process/kein ref'],
      ['step-fakt', 'operations-detail'],
      ['step-kasse', 'proa:process/x/fehlt#P'],
    ]);
    expect(found.map((f) => f.detail)).toEqual([
      'The link does not name a process as proa:process/<model key>#<process id>.',
      'The link is neither a proa:process/<model key>#<process id> link nor an http(s) URL.',
      'The linked process x/fehlt#P is not in the head revisions.',
    ]);
    // A link to a head process resolves; without the process it does not.
    expect(kinds({ processes: [A, V, X] }, 'unresolved-link').map((f) => f.elementId)).toContain(
      'step-mahn',
    );
  });
});

describe('order and helpers', () => {
  it('lists processes, then steps, then links, deterministically', () => {
    const all = valueChainFindings(input());
    expect([...new Set(all.map((f) => f.kind))]).toEqual([
      'process-without-step',
      'step-without-process',
      'unresolved-link',
    ]);
    expect(valueChainFindings(input())).toEqual(all);
  });

  it('homes processes by status on live generations only', () => {
    const homes = processHomes(
      [
        placement('step-eingang', A, 'accepted'),
        placement(OUTSIDE, A, 'accepted'),
        placement('step-rechnung', R, 'held'),
        placement('step-versand', V, 'proposed'),
        placement('step-versand', X, 'accepted', 2),
      ],
      live,
    );
    expect(homes.accepted.get(A)).toEqual([OUTSIDE, 'step-eingang']);
    expect(homes.accepted.has(X)).toBe(false);
    expect(unplacedState(homes, R)).toBe('held');
    expect(unplacedState(homes, V)).toBe('proposed');
    expect(unplacedState(homes, X)).toBe('none');
  });
});
