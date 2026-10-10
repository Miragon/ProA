/**
 * Auto-accept rules (owner decision 19), pure part: the checks of a draft
 * beyond its schema, the fields an edit compares, and decision 9 as the
 * read-only system rule. Synthetic data only.
 */
import { AutoAcceptRuleDraft, type PrincipalId } from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import {
  draftFields,
  nameKey,
  ruleDraftProblem,
  sameFields,
  systemRule,
} from '../../src/domain/auto-accept/rules.ts';

const AGENT = 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2A1' as PrincipalId;

const draft = (over: Record<string, unknown> = {}) =>
  AutoAcceptRuleDraft.parse({
    name: 'Schlüssel ab 90 %',
    kind: 'relation',
    tier: 'key',
    minConfidence: 0.9,
    ...over,
  });

describe('a draft', () => {
  it('defaults to off, pipeline proposals only, without narrowing', () => {
    expect(draft()).toMatchObject({
      enabled: false,
      includeAdHoc: false,
      relationType: null,
      agentPrincipalId: null,
      llmModel: null,
      note: null,
    });
  });

  it('is refused by the contract for a tier of another kind, a type on a placement rule, below 0.5', () => {
    expect(
      AutoAcceptRuleDraft.safeParse({ ...draft(), kind: 'placement', tier: 'key' }).success,
    ).toBe(false);
    expect(
      AutoAcceptRuleDraft.safeParse({
        ...draft(),
        kind: 'placement',
        tier: 'lexical',
        relationType: 'call',
      }).success,
    ).toBe(false);
    expect(AutoAcceptRuleDraft.safeParse({ ...draft(), minConfidence: 0.49 }).success).toBe(false);
    expect(AutoAcceptRuleDraft.safeParse({ ...draft(), minConfidence: 1.01 }).success).toBe(false);
    expect(AutoAcceptRuleDraft.safeParse({ ...draft(), name: '  ' }).success).toBe(false);
  });

  it('is checked in the domain as well, in a fixed order', () => {
    const agents = new Set([AGENT]);
    expect(ruleDraftProblem(draft(), [], agents)).toBeNull();
    expect(ruleDraftProblem({ ...draft(), kind: 'placement' }, [], agents)).toBe(
      'kind-tier-mismatch',
    );
    expect(
      ruleDraftProblem(
        { ...draft(), kind: 'placement', tier: 'lexical', relationType: 'call' },
        [],
        agents,
      ),
    ).toBe('type-not-for-placements');
    expect(ruleDraftProblem({ ...draft(), minConfidence: 0.3 }, [], agents)).toBe(
      'confidence-out-of-range',
    );
    expect(ruleDraftProblem({ ...draft(), note: 'a\u0000b' }, [], agents)).toBe(
      'control-characters',
    );
    expect(
      ruleDraftProblem(
        { ...draft(), agentPrincipalId: 'prn_01J9Z3N4X5Q6R7S8T9V0W1X2Z9' },
        [],
        agents,
      ),
    ).toBe('unknown-agent');
    expect(ruleDraftProblem({ ...draft(), agentPrincipalId: AGENT }, [], agents)).toBeNull();
    expect(ruleDraftProblem(draft(), ['SCHLÜSSEL AB 90 %'], agents)).toBe('name-taken');
  });

  it('compares names ignoring case and surrounding blanks', () => {
    expect(nameKey('  Schlüssel ')).toBe(nameKey('SCHLÜSSEL'));
  });
});

describe('an edit', () => {
  it('changes something only when a field differs (name and note trimmed)', () => {
    const head = draftFields(draft({ note: ' strenger ' }));
    expect(head.note).toBe('strenger');
    expect(sameFields(head, draftFields(draft({ note: 'strenger' })))).toBe(true);
    expect(sameFields(head, draftFields(draft({ note: 'strenger', enabled: true })))).toBe(false);
    expect(sameFields(head, draftFields(draft({ note: 'strenger', minConfidence: 0.95 })))).toBe(
      false,
    );
    expect(draftFields(draft({ note: '' })).note).toBeNull();
  });
});

describe('the system rule', () => {
  it('describes decision 9, read-only', () => {
    expect(systemRule(3)).toMatchObject({
      id: 'proa-rules/1.0.0',
      name: 'Eindeutige Aufrufe',
      kind: 'relation',
      relationType: 'call',
      readOnly: true,
      accepted: 3,
    });
  });
});
