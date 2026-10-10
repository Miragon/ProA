import type { Engine } from '@proa/client';

export type { Engine };

/** Display names of the target engines (`Model.engine`, from `modeler:executionPlatform`). */
export const ENGINE_LABELS: Record<Engine, string> = { c7: 'Camunda 7', c8: 'Camunda 8' };
