import * as contracts from '@proa/contracts';
import { describe, expect, it } from 'vitest';

import * as limits from '../src/lib/limits';

describe('constants copied from @proa/contracts', () => {
  it('match the originals', () => {
    expect(limits.PROBLEM_TYPE_BASE).toBe(contracts.PROBLEM_TYPE_BASE);
    expect(limits.MAX_IMPORT_FILES).toBe(contracts.MAX_IMPORT_FILES);
    expect(limits.MAX_MODEL_BYTES).toBe(contracts.MAX_MODEL_BYTES);
    expect(limits.MAX_IMPORT_BYTES).toBe(contracts.MAX_IMPORT_BYTES);
    expect(limits.MAX_PAGE_LIMIT).toBe(contracts.MAX_PAGE_LIMIT);
    expect(limits.AGENT_TOKEN_PREFIX).toBe(contracts.AGENT_TOKEN_PREFIX);
    expect(limits.AGENT_TOKEN_DEFAULT_DAYS).toBe(contracts.AGENT_TOKEN_DEFAULT_DAYS);
    expect(limits.AGENT_TOKEN_MAX_DAYS).toBe(contracts.AGENT_TOKEN_MAX_DAYS);
    expect(limits.MAX_NOTE_CHARS).toBe(contracts.MAX_NOTE_CHARS);
    expect(limits.MAX_LABEL_CHARS).toBe(contracts.MAX_LABEL_CHARS);
    expect(limits.MAX_QUESTION_CHARS).toBe(contracts.MAX_QUESTION_CHARS);
    expect(limits.MAX_BULK_DECISIONS).toBe(contracts.MAX_BULK_DECISIONS);
  });

  it('match the value chain constants (M4)', () => {
    expect(limits.MAX_RATIONALE_CHARS).toBe(contracts.MAX_RATIONALE_CHARS);
    expect(limits.VALUE_CHAIN_KEY).toBe(contracts.VALUE_CHAIN_KEY);
    expect(limits.OUTSIDE_STEP).toBe(contracts.OUTSIDE_STEP);
    expect(limits.RESERVED_ELEMENT_IDS).toEqual(contracts.RESERVED_ELEMENT_IDS);
    expect(limits.PROA_PROCESS_LINK_PREFIX).toBe(contracts.PROA_PROCESS_LINK_PREFIX);
    expect(limits.STEP_KIND_COLORS).toEqual(contracts.STEP_KIND_COLORS);
    expect(limits.BIDI_CHARACTERS.source).toBe(contracts.BIDI_CHARACTERS.source);
    const names = [
      'BYTES',
      'BODY_BYTES',
      'ELEMENTS',
      'CONNECTIONS',
      'NAME_CHARS',
      'ID_CHARS',
      'LINK_CHARS',
      'DEPTH',
      'COORDINATE',
      'ELEMENT_SIZE',
      'REV',
      'VIOLATIONS',
    ] as const;
    for (const name of names) {
      const key = `MAX_VALUE_CHAIN_${name}` as const;
      expect([key, limits[key]]).toEqual([key, contracts[key]]);
    }
    // every MAX_VALUE_CHAIN_* of the contracts is mirrored
    expect(
      Object.keys(contracts)
        .filter((k) => k.startsWith('MAX_VALUE_CHAIN_'))
        .sort(),
    ).toEqual(names.map((n) => `MAX_VALUE_CHAIN_${n}`).sort());
  });

  it('label maps cover every enum value of the contracts', async () => {
    const labels = await import('../src/lib/labels');
    expect(Object.keys(labels.STAGES).sort()).toEqual([...contracts.ModelStage.options].sort());
    expect([...labels.STAGE_ORDER].sort()).toEqual([...contracts.ModelStage.options].sort());
    expect([...labels.STATUS_ORDER].sort()).toEqual([...contracts.RelationStatus.options].sort());
    expect([...labels.TIER_ORDER].sort()).toEqual([...contracts.Tier.options].sort());
    expect([...labels.TYPE_ORDER].sort()).toEqual([...contracts.RelationType.options].sort());
    expect([...labels.FINDING_ORDER].sort()).toEqual([...contracts.FindingKind.options].sort());
    expect(Object.keys(labels.SCOPES).sort()).toEqual([...contracts.AgentScope.options].sort());
    expect(Object.keys(labels.VERDICT_DONE).sort()).toEqual([...contracts.Verdict.options].sort());
    expect(Object.keys(labels.SOURCE_KINDS).sort()).toEqual(
      [...contracts.SourceKind.options].sort(),
    );
    expect(Object.keys(labels.ASSERTION_KINDS).sort()).toEqual(
      [...contracts.AssertionKind.options].sort(),
    );
    // value chain (M4)
    expect(Object.keys(labels.STEP_KINDS).sort()).toEqual([...contracts.StepKind.options].sort());
    expect([...labels.STEP_KIND_ORDER].sort()).toEqual([...contracts.StepKind.options].sort());
    expect(Object.keys(labels.LINK_KINDS).sort()).toEqual([...contracts.LinkKind.options].sort());
    expect(Object.keys(labels.VALUE_CHAIN_FINDING_KINDS).sort()).toEqual(
      [...contracts.VALUE_CHAIN_FINDING_KINDS].sort(),
    );
    expect([...labels.VALUE_CHAIN_FINDING_ORDER].sort()).toEqual(
      [...contracts.VALUE_CHAIN_FINDING_KINDS].sort(),
    );
    expect(Object.keys(labels.UNPLACED_STATES).sort()).toEqual(
      [...contracts.UnplacedState.options].sort(),
    );
    expect(Object.keys(labels.VALUE_CHAIN_VIOLATION_TEXTS).sort()).toEqual(
      [...contracts.VALUE_CHAIN_VIOLATIONS].sort(),
    );
    for (const text of Object.values(labels.VALUE_CHAIN_VIOLATION_TEXTS)) {
      expect(text).toMatch(/^[A-ZÄÖÜ].*\.$/);
    }
  });
});
