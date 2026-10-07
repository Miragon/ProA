/**
 * The domain's use cases (CONCEPT §1: "every capability is a domain use
 * case"). REST and MCP both call these with the caller's {@link Actor}; each
 * starts with `policy.require(actor, permission, project)`.
 */
import type { IngestDeps } from '../ingest.ts';
import { agentTokenUseCases } from './agent-tokens.ts';
import type { UseCaseDeps } from './deps.ts';
import { identityUseCases } from './identity.ts';
import { landscapeUseCases } from './landscape.ts';
import { modelUseCases } from './models.ts';
import { projectUseCases } from './projects.ts';

export type { UseCaseDeps } from './deps.ts';
export { EVENT_KINDS, USAGE_KINDS, type EventKind, type UsageKind } from './landscape.ts';
export type { ModelXml, UploadFile } from './models.ts';

export function createUseCases(deps: UseCaseDeps) {
  const identity = identityUseCases(deps);
  const ingestDeps: IngestDeps = {
    store: deps.store,
    analysis: deps.analysis,
    rulesPrincipal: identity.rulesPrincipal,
  };
  return {
    ...identity,
    ...projectUseCases(deps),
    ...modelUseCases(deps, ingestDeps),
    ...landscapeUseCases(deps),
    ...agentTokenUseCases(deps),
  };
}

export type UseCases = ReturnType<typeof createUseCases>;
