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
  });
});
