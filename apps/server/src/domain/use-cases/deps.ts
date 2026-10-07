import type { AnalysisPort, Clock, Store } from '../ports.ts';

/** What every use case gets injected. */
export interface UseCaseDeps {
  store: Store;
  analysis: AnalysisPort;
  clock: Clock;
}

/** Upper bound for "all rows" reads (landscape, process lookups). */
export const ALL = 100_000;
