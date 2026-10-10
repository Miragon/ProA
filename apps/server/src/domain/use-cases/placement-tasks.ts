/**
 * The `placement` pipeline kind (M4 §3.2): the claim input of a chain task
 * and its submission, called by the analysis use cases (`analyses.ts`) inside
 * their transaction, under the project lock. Judge each process once: a
 * claim lists the due processes (input changed since an agent's last
 * verdict), a submission records a verdict per process (`placement_input`),
 * and a process is offered again only when its input changes.
 */
import {
  MAX_SKIPPED_PROCESSES,
  MAX_UNSURE_REASON_CHARS,
  hasControlCharacters,
  isRef,
  type ClaimedPlacementAnalysis,
  type DeclaredProcedure,
  type PlacementSubmissionResult,
  type Ref,
  type SubmissionId,
  type SubmitAnalysisBody,
  type UnsureOutcome,
} from '@proa/contracts';

import { sourceKindOf, type Actor } from '../actor.ts';
import { autoAcceptPlacements, type PlacementTrigger } from '../auto-accept/apply.ts';
import { DomainError } from '../errors.ts';
import type {
  ChainTaskDetail,
  HeadFact,
  PlacementInputRecord,
  PlacementRecord,
  ProjectRecord,
  Tx,
} from '../ports.ts';
import { currentStances } from '../status.ts';
import { loadChainState } from '../value-chain/chain-state.ts';
import {
  stepGenerationKey,
  validatePipelinePlacementItem,
  type PlacementItemContext,
} from '../value-chain/items.ts';
import {
  claimExamples,
  claimProcess,
  claimSteps,
  dueProcesses,
  liveProposals,
  planPlacementSupersession,
  renderPlacementClaimInput,
  selectClaimProcesses,
  type DueProcess,
} from '../value-chain/pipeline.ts';
import { placementKey } from '../value-chain/placement-state.ts';
import {
  applyPlacementProposal,
  withdrawPlacementStance,
  type PlacementContext,
} from '../value-chain/placements.ts';
import {
  insertPlacementTask,
  loadPipelineInputs,
  type PipelineInputs,
} from '../value-chain/queue.ts';
import { lexicalMatcher, processOfRefs } from '../value-chain/tiers.ts';
import { unplacedProcess } from '../value-chain/unplaced.ts';
import { processNamesOf } from './value-chains.ts';

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The lexical matcher of the head (the tier of agent proposals, the hints of processes). */
function matcherOf(inputs: PipelineInputs) {
  const { state } = inputs;
  return lexicalMatcher({
    structure: state.structure,
    processes: new Map(
      state.processFacts.map((f) => [
        f.ref,
        { name: f.label === '' ? null : f.label, modelKey: f.modelKey },
      ]),
    ),
    neighbours: inputs.hashContext.neighbours,
    known: inputs.hashContext.acceptedSteps,
  });
}

/** A freshly claimed chain task of this call, with its lease token. */
export interface ClaimedChainTask {
  task: ChainTaskDetail;
  token: string;
  project: ProjectRecord;
}

/**
 * Renders the input of a freshly claimed placement task (M4 §3.2) at the
 * chain's head: the due processes in ref order, as many as fit one claim
 * (`selectClaimProcesses`), each with its proposals, the human decisions
 * and an earlier unsure verdict; the steps and the examples. Stores what the
 * claim showed (`placement_claim`, the head as the task's revision).
 *
 * @returns `null` when nothing is due any more (or the chain is gone): the caller cancels the task
 */
export async function renderPlacementClaim(
  tx: Tx,
  procedure: DeclaredProcedure,
  actor: Actor,
  claimed: ClaimedChainTask,
  leaseUntil: Date,
): Promise<ClaimedPlacementAnalysis | null> {
  const { task, token, project } = claimed;
  const chain = await tx.valueChains.findInProject(project.id, task.valueChainId);
  if (!chain || chain.headRevisionId === null) return null;
  const inputs = await loadPipelineInputs(tx, await loadChainState(tx, chain), procedure);
  if (inputs.due.length === 0) return null;
  const { state } = inputs;
  const processOf = processOfRefs(inputs.facts);
  const unplacedCtx = {
    facts: inputs.facts,
    byProcess: inputs.byProcess,
    processOf,
    // As list_unplaced_processes: live relations that are not rejected.
    relations: inputs.relations.filter((r) => r.status !== 'rejected' && r.status !== 'obsolete'),
    known: inputs.hashContext.acceptedSteps,
    matcher: matcherOf(inputs),
    structure: state.structure,
  };
  const factOf = new Map<string, HeadFact>(state.processFacts.map((f) => [f.ref, f]));
  const placementsOf = new Map<string, PlacementRecord[]>();
  for (const p of inputs.placements) {
    if (p.status === 'obsolete') continue;
    placementsOf.set(p.processRef, [...(placementsOf.get(p.processRef) ?? []), p]);
  }
  const render = (d: DueProcess) => {
    const fact = factOf.get(d.process);
    if (!fact) throw new Error(`due process ${d.process} is not a head process`);
    return claimProcess({
      unplaced: unplacedProcess(fact, unplacedCtx),
      placements: placementsOf.get(d.process) ?? [],
      histories: inputs.histories,
      live: state.live,
      row: inputs.rows.get(d.process),
      claimant: actor.principalId,
    });
  };
  const headProcesses = new Set(state.processFacts.map((f) => f.ref));
  const parts = {
    chain,
    head: state.head,
    steps: claimSteps(state.structure, headProcesses),
    examples: claimExamples(inputs.placements, state.live, processNamesOf(state.processFacts)),
  };
  const empty = renderPlacementClaimInput({
    ...parts,
    processes: [],
    truncated: true,
    remaining: 0,
  });
  const selection = selectClaimProcesses(
    inputs.due,
    render,
    new TextEncoder().encode(JSON.stringify(empty)).length,
  );
  const input = renderPlacementClaimInput({
    ...parts,
    processes: selection.selected.map((s) => s.rendered),
    truncated: selection.truncated,
    remaining: selection.remaining,
  });
  await tx.tasks.setPlacementClaim(
    project.id,
    task.id,
    {
      structureHash: state.head.structureHash,
      chainDigest: inputs.hashContext.chainDigest,
      truncated: selection.truncated,
      remaining: selection.remaining,
      processes: selection.selected.map(({ due }) => {
        const processDigest = inputs.hashContext.processDigests.get(due.process);
        if (processDigest === undefined) throw new Error(`${due.process} is not a head process`);
        return { process: due.process, inputHash: due.inputHash, processDigest };
      }),
    },
    state.head.id,
  );
  return {
    kind: 'placement',
    taskId: task.id,
    projectId: project.id,
    projectKey: project.key,
    valueChainId: chain.id,
    valueChainKey: chain.key,
    revisionId: state.head.id,
    rev: state.head.rev,
    attempt: task.attempts,
    leaseToken: token,
    leaseUntil: leaseUntil.toISOString(),
    procedure,
    input,
  };
}

/** What `submitPlacementAnalysis` needs besides the transaction. */
export interface PlacementSubmitContext {
  tx: Tx;
  actor: Actor;
  project: ProjectRecord;
  task: ChainTaskDetail;
  body: SubmitAnalysisBody;
  /** The request as stored (verbatim minus the lease token). */
  payload: Record<string, unknown>;
  /** The id of the stored submission (`sub_…`), already allocated. */
  submissionId: SubmissionId;
  procedure: DeclaredProcedure;
  now: Date;
}

/**
 * Records a placement task's submission (M4 §3.2) inside the caller's
 * transaction: validates and applies the placement items against the head
 * (the basis: the claim's chain structure and each process's `facts_hash`),
 * checks the unsure items, withdraws the stale and replaced pipeline
 * proposals of the claim's processes, writes each claimed process's verdict
 * (`proposed`, `unsure`, `skipped`; none after only invalid items, so it is
 * offered again), marks the task done, stores the submission and queues a
 * follow-up when the claim was truncated and the submission recorded a
 * verdict, or when the chain or the models changed during the lease
 * (`requeue_after`), and something is still due.
 *
 * @throws {DomainError} `wrong-task-kind` for relations items, `task-cancelled` when the chain is gone
 */
export async function submitPlacementAnalysis(
  c: PlacementSubmitContext,
): Promise<PlacementSubmissionResult> {
  const { tx, actor, project, task, body } = c;
  if (body.relations.length > 0 || body.noLinks.length > 0) {
    throw new DomainError(
      'wrong-task-kind',
      'this is a placement task: submit placements and unsure, not relations or noLinks',
      { kind: 'placement' },
    );
  }
  const chain = await tx.valueChains.findInProject(project.id, task.valueChainId);
  const claim = task.placementClaim;
  if (!chain || chain.headRevisionId === null) {
    throw new DomainError('task-cancelled', 'the value chain was deleted');
  }
  if (!claim) throw new Error(`placement task ${task.id} has no claim`);
  const inputs = await loadPipelineInputs(tx, await loadChainState(tx, chain), c.procedure);
  const { state } = inputs;
  const claimed = new Map(claim.processes.map((p) => [p.process, p]));
  const inputProcesses = new Set(claimed.keys());

  // 1. Placement items, validated against the head.
  const ctx: PlacementContext = {
    tx,
    projectId: project.id,
    actor,
    valueChainId: chain.id,
    endpoints: state.endpoints,
    placements: new Map(
      inputs.placements.map((p) => [
        placementKey(chain.id, p.elementId, p.generation, p.processRef),
        p,
      ]),
    ),
    histories: new Map(inputs.histories),
    declared: { procedure: body.procedure, llmModel: body.llmModel },
    submissionId: c.submissionId,
    basisOf: (processRef) => {
      const p = claimed.get(processRef);
      if (!p) throw new Error(`${processRef} is not in the claim`);
      // What the claim showed of the chain and of the process (M4 §3.2).
      return { stepHash: claim.chainDigest, processHash: p.processDigest };
    },
  };
  const byProcess = new Map<string, Set<string>>();
  for (const p of inputs.placements) {
    const key = placementKey(chain.id, p.elementId, p.generation, p.processRef);
    byProcess.set(p.processRef, (byProcess.get(p.processRef) ?? new Set()).add(key));
  }
  // The submission's own steps per process so far (too-many-steps counts them).
  const submissionSteps = new Map<string, Set<string>>();
  const itemCtx: PlacementItemContext = {
    structure: state.structure,
    live: state.live,
    processes: new Set(state.processFacts.map((f) => f.ref)),
    factRefs: new Set(inputs.facts.map((f) => f.ref)),
    relationIds: new Set<string>(inputs.relations.map((r) => r.id)),
    sourceKind: sourceKindOf(actor),
    lexical: matcherOf(inputs),
    liveProposalSteps(processRef: string) {
      // The caller's live ad-hoc proposals of the process (its pipeline proposals on input
      // processes are superseded or repeated by this submission) plus this submission's steps.
      const out = new Set(submissionSteps.get(processRef) ?? []);
      for (const key of byProcess.get(processRef) ?? []) {
        const p = ctx.placements.get(key);
        if (!p || state.live.get(p.elementId) !== p.generation) continue;
        const adHoc = currentStances(ctx.histories.get(p.id) ?? []).some(
          (a) =>
            a.principalId === actor.principalId && a.kind === 'proposal' && a.submissionId === null,
        );
        if (adHoc) out.add(stepGenerationKey(p.elementId, p.generation));
      }
      return out;
    },
  };
  const placementItems: PlacementSubmissionResult['placements']['items'] = [];
  const recorded: PlacementTrigger[] = [];
  const counts = { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 };
  const seen = new Map<string, PlacementRecord>();
  const placed = new Set<string>();
  const invalidOnly = new Set<string>();
  const repeated = new Set<PlacementRecord['id']>();
  for (const [index, item] of (body.placements ?? []).entries()) {
    const valid = validatePipelinePlacementItem(
      {
        step: item.step,
        process: item.process,
        confidence: item.confidence,
        rationale: item.rationale,
        evidence: item.evidence,
        question: item.question,
      },
      itemCtx,
      inputProcesses,
    );
    if (!valid.ok) {
      placementItems.push({
        index,
        result: `invalid:${valid.reason}`,
        placementId: null,
        status: null,
      });
      counts.invalid++;
      if (inputProcesses.has(item.process)) invalidOnly.add(item.process);
      continue;
    }
    const v = valid.value;
    placed.add(v.processRef);
    const steps = submissionSteps.get(v.processRef) ?? new Set<string>();
    steps.add(stepGenerationKey(v.elementId, v.generation));
    submissionSteps.set(v.processRef, steps);
    const k = placementKey(chain.id, v.elementId, v.generation, v.processRef);
    const earlier = seen.get(k);
    if (earlier) {
      const current = ctx.placements.get(k) ?? earlier;
      placementItems.push({ index, result: 'duplicate', placementId: current.id, status: null });
      counts.duplicate++;
      continue;
    }
    const { effect, placement, assertion } = await applyPlacementProposal(ctx, v);
    if (assertion) recorded.push({ placement, assertion });
    byProcess.set(v.processRef, (byProcess.get(v.processRef) ?? new Set()).add(k));
    seen.set(k, placement);
    repeated.add(placement.id);
    placementItems.push({ index, result: effect, placementId: placement.id, status: null });
    counts[effect]++;
  }

  // 2. Unsure items, in the order of UNSURE_INVALID_REASONS.
  const unsureItems: PlacementSubmissionResult['unsure']['items'] = [];
  const unsureReasons = new Map<string, string>();
  for (const [index, item] of (body.unsure ?? []).entries()) {
    const result = unsureOutcome(item, {
      inputProcesses,
      headProcesses: itemCtx.processes,
      placed,
      stored: unsureReasons,
    });
    if (result === 'stored') unsureReasons.set(item.process, item.reason);
    // An invalid verdict on an input process is no verdict: like an invalid placement item.
    else if (result.startsWith('invalid:') && inputProcesses.has(item.process)) {
      invalidOnly.add(item.process);
    }
    unsureItems.push({ index, result });
  }
  for (const p of [...placed, ...unsureReasons.keys()]) invalidOnly.delete(p);
  const unsureCount = (r: string) => unsureItems.filter((i) => i.result === r).length;

  // 3. Supersession: stale pipeline proposals of the claim's processes (any principal) and
  //    the caller's own ones on processes it gave a verdict without repeating them.
  const verdicts = new Set([...placed, ...unsureReasons.keys()]);
  const live = [...ctx.placements.values()].filter((p) => inputProcesses.has(p.processRef));
  const plan = planPlacementSupersession({
    inputProcesses: claimed,
    chainDigest: claim.chainDigest,
    procedure: c.procedure,
    caller: actor.principalId,
    submissionId: c.submissionId,
    proposals: liveProposals(live, ctx.histories),
    repeated,
    verdicts,
  });
  const by = { principalId: actor.principalId, clientId: actor.clientId };
  let withdrawn = 0;
  for (const { placement, stance, reason } of plan) {
    const current =
      ctx.placements.get(
        placementKey(chain.id, placement.elementId, placement.generation, placement.processRef),
      ) ?? (placement as PlacementRecord);
    const stances = currentStances(ctx.histories.get(current.id) ?? []);
    const own = stances.find((a) => a.principalId === stance.principalId && a.kind === 'proposal');
    if (!own) continue;
    await withdrawPlacementStance(
      ctx,
      current,
      own,
      reason === 'stale'
        ? `Veraltet: ersetzt durch Einreichung ${body.submissionId}`
        : `Ersetzt durch Einreichung ${body.submissionId}`,
      by,
    );
    withdrawn++;
  }

  // 4. The verdict per claimed process.
  const verdictRows: Omit<PlacementInputRecord, 'seq'>[] = [];
  const skipped: string[] = [];
  for (const p of [...claim.processes].sort((a, b) => byCodePoint(a.process, b.process))) {
    const base = {
      projectId: project.id,
      valueChainId: chain.id,
      processRef: p.process,
      inputHash: p.inputHash,
      taskId: task.id,
      principalId: actor.principalId,
    };
    if (placed.has(p.process)) verdictRows.push({ ...base, outcome: 'proposed', reason: null });
    else if (unsureReasons.has(p.process)) {
      verdictRows.push({ ...base, outcome: 'unsure', reason: unsureReasons.get(p.process) ?? '' });
    } else if (!invalidOnly.has(p.process)) {
      verdictRows.push({ ...base, outcome: 'skipped', reason: null });
      skipped.push(p.process);
    }
  }

  // 5. A follow-up for processes still due: after a truncated claim that made progress, or
  //    when the chain or the models changed during the lease. Agent writes never change an
  //    input hash, so the due set after the rows follows from the inputs loaded above.
  let followUpDue: DueProcess[] = [];
  if ((claim.truncated && verdictRows.length > 0) || task.requeueAfter) {
    const rows = new Map<string, { inputHash: string }>(inputs.rows);
    for (const r of verdictRows) rows.set(r.processRef, { inputHash: r.inputHash });
    followUpDue = dueProcesses(
      inputs.open,
      new Map(inputs.open.map((ref) => [ref, inputs.hashOf(ref)])),
      rows,
    );
  }

  const byId = new Map([...ctx.placements.values()].map((p) => [p.id, p]));
  for (const item of placementItems) {
    if (item.placementId) item.status = byId.get(item.placementId)?.status ?? null;
  }
  const result: PlacementSubmissionResult = {
    kind: 'placement',
    taskId: task.id,
    submissionId: body.submissionId,
    replayed: false,
    placements: { items: placementItems, counts },
    unsure: {
      items: unsureItems,
      counts: {
        stored: unsureCount('stored'),
        duplicate: unsureCount('duplicate'),
        invalid: unsureItems.filter((i) => i.result.startsWith('invalid:')).length,
      },
    },
    withdrawn,
    skipped: {
      count: skipped.length,
      processes: skipped.slice(0, MAX_SKIPPED_PROCESSES) as Ref[],
    },
    followUp: followUpDue.length > 0,
  };

  // 6. Close.
  await tx.tasks.setState(project.id, task.id, 'done');
  const seq = await tx.events.append(project.id, {
    type: 'analysis.done',
    principalId: actor.principalId,
    clientId: actor.clientId,
    subjectRef: chain.id,
    payload: {
      taskId: task.id,
      kind: 'placement',
      valueChainId: chain.id,
      key: chain.key,
      submissionId: body.submissionId,
      storedSubmissionId: c.submissionId,
      procedure: body.procedure,
      llmModel: body.llmModel,
      late: task.state === 'failed' || (task.leaseUntil !== null && task.leaseUntil < c.now),
      counts,
      unsure: result.unsure.counts,
      withdrawn,
      skipped: skipped.length,
      followUp: result.followUp,
    },
  });
  await tx.placementInputs.upsertMany(verdictRows.map((r) => ({ ...r, seq })));
  await tx.submissions.insert({
    id: c.submissionId,
    projectId: project.id,
    taskId: task.id,
    clientSubmissionId: body.submissionId,
    principalId: actor.principalId,
    clientId: actor.clientId,
    declared: { procedure: body.procedure, llmModel: body.llmModel },
    payload: c.payload,
    result,
    seq,
  });
  if (followUpDue.length > 0) {
    await insertPlacementTask(tx, actor, chain, state.head, followUpDue, 'follow-up');
  }
  // 7. The owner's auto-accept rules (owner decision 19) on the proposals just recorded; the
  //    result above reports the state before them. `inputs.rows` are the verdicts before this
  //    submission's.
  await autoAcceptPlacements(ctx, recorded, {
    procedure: c.procedure,
    chainDigest: inputs.hashContext.chainDigest,
    processDigests: inputs.hashContext.processDigests,
    hashOf: (ref) => inputs.hashOf(ref),
    priorRows: inputs.rows,
    live: state.live,
  });
  return result;
}

/** The outcome of one unsure item, checked in the order of `UNSURE_INVALID_REASONS`. */
function unsureOutcome(
  item: { process: string; reason: string },
  ctx: {
    inputProcesses: ReadonlySet<string>;
    headProcesses: ReadonlySet<string>;
    placed: ReadonlySet<string>;
    stored: ReadonlyMap<string, string>;
  },
): UnsureOutcome {
  if (!isRef(item.process)) return 'invalid:malformed-ref';
  if (!ctx.inputProcesses.has(item.process)) return 'invalid:outside-task-input';
  if (!ctx.headProcesses.has(item.process)) return 'invalid:unknown-process';
  if (item.reason.trim() === '') return 'invalid:reason-required';
  if (item.reason.length > MAX_UNSURE_REASON_CHARS) return 'invalid:reason-too-long';
  if (hasControlCharacters(item.reason)) return 'invalid:control-characters';
  if (ctx.placed.has(item.process)) return 'invalid:also-placed';
  if (ctx.stored.has(item.process)) return 'duplicate';
  return 'stored';
}
