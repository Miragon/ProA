/** Placement tiers (M4 §2 "Tiers", M4 S1): server-computed, never sent, never `rule`. */
import { describe, expect, it } from 'vitest';

import { placementTier } from '../../src/domain/value-chain/placements.ts';

describe('placementTier', () => {
  const all = [false, true] as const;

  it('is key for the rule tier and manual for humans, whatever matches', () => {
    for (const toOutside of all) {
      for (const lexicalMatch of all) {
        const x = { toOutside, lexicalMatch };
        expect(placementTier({ ...x, sourceKind: 'rule' })).toBe('key');
        expect(placementTier({ ...x, sourceKind: 'human' })).toBe('manual');
      }
    }
  });

  it('is lexical for an agent only with a lexical match and never for @outside', () => {
    const agent = (toOutside: boolean, lexicalMatch: boolean) =>
      placementTier({ sourceKind: 'agent', toOutside, lexicalMatch });
    expect(agent(false, false)).toBe('semantic');
    expect(agent(false, true)).toBe('lexical');
    for (const lexicalMatch of all) expect(agent(true, lexicalMatch)).toBe('semantic');
    // A step whose `link` names the process yields the rule tier's key proposal;
    // it does not make an agent's proposal lexical, so there is no key-match input.
    // @ts-expect-error -- `keyMatch` is not an input.
    placementTier({ sourceKind: 'agent', toOutside: false, lexicalMatch: false, keyMatch: true });
  });
});
