import type { DeclaredProcedure } from '@proa/contracts';

import type { AnalysisPort, Clock, Notifier, Store } from '../ports.ts';

/** What every use case gets injected. */
export interface UseCaseDeps {
  store: Store;
  analysis: AnalysisPort;
  clock: Clock;
  /** Wake-ups for the pending long-poll (LISTEN/NOTIFY). */
  notifier: Notifier;
  /** The procedure a claim names (`proa-relations` and its current version). */
  expectedProcedure: () => DeclaredProcedure;
}

/** Upper bound for "all rows" reads (landscape, process lookups). */
export const ALL = 100_000;
