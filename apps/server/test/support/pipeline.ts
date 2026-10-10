/** REST helpers for the analysis pipeline and review tests. */
import { randomUUID } from 'node:crypto';

import type {
  AnalysisKind,
  AnalysisSubmissionResult,
  ClaimResult,
  ClaimedAnalysis,
  ClaimedPlacementAnalysis,
  ClaimedRelationsAnalysis,
  DeclaredProcedure,
  PlacementSubmissionResult,
  SubmissionResult,
  SubmitAnalysisInput,
} from '@proa/contracts';
import { getProcedure } from '@proa/procedures';

import type { TestApp } from './app.ts';

export type Caller = (path: string, init?: RequestInit) => Promise<Response>;

const JSON_HEADERS = { 'content-type': 'application/json' };

/** The procedure claims name: `proa-relations` at its current version (`@proa/procedures`). */
export const RELATIONS_PROCEDURE: DeclaredProcedure = (() => {
  const p = getProcedure('proa-relations');
  if (!p) throw new Error('the proa-relations procedure is missing');
  return { id: p.id, version: p.version };
})();

/** The procedure placement claims name: `proa-placements` at its current version. */
export const PLACEMENTS_PROCEDURE: DeclaredProcedure = (() => {
  const p = getProcedure('proa-placements');
  if (!p) throw new Error('the proa-placements procedure is missing');
  return { id: p.id, version: p.version };
})();

export function post(call: Caller, path: string, body: unknown): Promise<Response> {
  return call(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/** A caller acting with an agent token. */
export function asAgent(t: TestApp, secret: string): Caller {
  return (path, init) => t.asToken(secret, path, init);
}

/** Claims relations tasks (the default kinds). */
export async function claim(
  call: Caller,
  body: { projectId?: string; modelKey?: string; max?: number } = {},
): Promise<ClaimedRelationsAnalysis[]> {
  const items = await claimKinds(call, body);
  if (items.some((i) => i.kind !== 'relations')) throw new Error('claimed a non-relations task');
  return items as ClaimedRelationsAnalysis[];
}

/** Claims tasks of any kinds (`kinds` passed as given). */
export async function claimKinds(
  call: Caller,
  body: { projectId?: string; modelKey?: string; max?: number; kinds?: AnalysisKind[] } = {},
): Promise<ClaimedAnalysis[]> {
  const res = await post(call, '/api/v1/analyses/claim', body);
  if (res.status !== 200) throw new Error(`claim: ${res.status} ${await res.text()}`);
  return ((await res.json()) as ClaimResult).items;
}

/** Claims placement tasks only. */
export async function claimPlacement(
  call: Caller,
  body: { projectId?: string; max?: number } = {},
): Promise<ClaimedPlacementAnalysis[]> {
  const items = await claimKinds(call, { ...body, kinds: ['placement'] });
  if (items.some((i) => i.kind !== 'placement')) throw new Error('claimed a non-placement task');
  return items as ClaimedPlacementAnalysis[];
}

/** A submission body with defaults for the declared procedure and a fresh submission id. */
export function submission(
  claimed: Pick<ClaimedAnalysis, 'leaseToken'>,
  relations: SubmitAnalysisInput['relations'],
  extra: Partial<SubmitAnalysisInput> = {},
): SubmitAnalysisInput {
  return {
    leaseToken: claimed.leaseToken,
    submissionId: randomUUID(),
    procedure: RELATIONS_PROCEDURE,
    llmModel: 'sim-1',
    relations,
    ...extra,
  };
}

export function submitRaw(call: Caller, taskId: string, body: unknown): Promise<Response> {
  return post(call, `/api/v1/analyses/${taskId}/submission`, body);
}

export async function submit(
  call: Caller,
  taskId: string,
  body: SubmitAnalysisInput,
): Promise<SubmissionResult> {
  const res = await submitRaw(call, taskId, body);
  if (res.status !== 200) throw new Error(`submit: ${res.status} ${await res.text()}`);
  const result = (await res.json()) as AnalysisSubmissionResult;
  if ('kind' in result) throw new Error('a placement result for a relations submission');
  return result;
}

/** A placement task's submission body with defaults and a fresh submission id. */
export function placementSubmission(
  claimed: Pick<ClaimedPlacementAnalysis, 'leaseToken'>,
  placements: NonNullable<SubmitAnalysisInput['placements']>,
  extra: Partial<SubmitAnalysisInput> = {},
): SubmitAnalysisInput {
  return {
    leaseToken: claimed.leaseToken,
    submissionId: randomUUID(),
    procedure: PLACEMENTS_PROCEDURE,
    llmModel: 'sim-1',
    placements,
    ...extra,
  };
}

export async function submitPlacement(
  call: Caller,
  taskId: string,
  body: SubmitAnalysisInput,
): Promise<PlacementSubmissionResult> {
  const res = await submitRaw(call, taskId, body);
  if (res.status !== 200) throw new Error(`submit: ${res.status} ${await res.text()}`);
  const result = (await res.json()) as AnalysisSubmissionResult;
  if (!('kind' in result)) throw new Error('a relations result for a placement submission');
  return result;
}

export function release(
  call: Caller,
  taskId: string,
  leaseToken: string,
  reason?: string,
): Promise<Response> {
  return post(call, `/api/v1/analyses/${taskId}/release`, {
    leaseToken,
    ...(reason ? { reason } : {}),
  });
}

/** An item of a submission or an ad-hoc proposal. */
export function item(
  type: string,
  from: string,
  to: string,
  extra: {
    confidence?: number;
    rationale?: string;
    question?: string | null;
    evidence?: string[];
  } = {},
) {
  return {
    type,
    from,
    to,
    confidence: extra.confidence ?? 0.8,
    rationale: extra.rationale ?? `${from} → ${to}`,
    ...(extra.question === undefined ? {} : { question: extra.question }),
    ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
  };
}

export async function problemOf(
  res: Response,
): Promise<{ code: string; status: number } & Record<string, unknown>> {
  return (await res.json()) as { code: string; status: number } & Record<string, unknown>;
}
