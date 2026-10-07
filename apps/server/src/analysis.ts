/**
 * Binds the domain's {@link AnalysisPort} to the deterministic libraries
 * (`@proa/bpmn-facts`, `@proa/relations`). Hostile, oversized or malformed
 * input comes back as a value (→ 413/422 per file); any other error is a
 * bug and propagates (→ 500 `internal`, logged).
 */
import { BpmnInputError, DEFAULT_PARSE_LIMITS, extractFacts, factsHash } from '@proa/bpmn-facts';
import { runRules } from '@proa/relations';

import type { AnalysisPort } from './domain/ports.ts';

export const libraryAnalysis: AnalysisPort = {
  async extract(xml, modelKey) {
    try {
      const result = await extractFacts(xml, { modelKey, limits: DEFAULT_PARSE_LIMITS });
      return {
        ok: true,
        value: {
          factsVersion: result.factsVersion,
          processes: result.processes,
          facts: result.facts,
          messageFlows: result.messageFlows,
        },
      };
    } catch (err) {
      if (err instanceof BpmnInputError) {
        return { ok: false, error: { code: err.code, message: err.message } };
      }
      throw err;
    }
  },
  factsHash: (facts) => factsHash(facts),
  runRules: (projectFacts) => runRules(projectFacts),
};
