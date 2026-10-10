import { z } from 'zod';

import {
  AnalysisTaskId,
  PlacementId,
  RelationId,
  RevisionId,
  ValueChainRevisionId,
} from './ids.ts';
import { ModelKey } from './refs.ts';
import { DeclaredProcedure, RelationStatus } from './relations.ts';
import {
  CLAIM_INPUT_FORMAT,
  CLAIM_PLACEMENT_FORMAT,
  ClaimInput,
  NoLinkItem,
  PipelinePlacementOutcome,
  PlacementClaimInput,
  PlacementSubmissionResult,
  ProposalItem,
  ProposalOutcome,
  SubmissionResult,
  UnsureItem,
} from './api/analyses.ts';
import { Sha256Hex } from './api/common.ts';
import { PlacementItem } from './api/placements.ts';
import { ProjectKey } from './api/projects.ts';
import { ValueChainKey } from './api/value-chains.ts';

/**
 * Recordings of agent runs for the eval (CONCEPT §7): one JSONL file per
 * landscape at
 * `eval/recordings/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`,
 * one {@link RecordingLine} per analysed task (claim input + submission +
 * result). The simulation agent (`apps/agent-sim`) writes them as it works;
 * `eval:live` (`eval/tools`) builds them from the submissions a live project
 * stored (without the claim input); `eval:replay` scores the submissions
 * against `expected.yaml`.
 */
export const RECORDING_FORMAT = 'proa-recording/1';

/**
 * A claim input reduced to its counts (`--record-input summary`): keeps
 * committed recordings small. The server does not store claim inputs (it
 * renders them at claim time), so only the agent that claimed can record
 * the full input (`--record-input full`).
 */
export const ClaimInputSummary = z.object({
  format: z.literal(CLAIM_INPUT_FORMAT),
  summary: z.literal(true),
  facts: z.number().int().min(0),
  candidates: z.number().int().min(0),
  partners: z.number().int().min(0),
  relations: z.number().int().min(0),
  /** Size of the full input as the agent received it (UTF-8 JSON). */
  bytes: z.number().int().min(0),
});
export type ClaimInputSummary = z.infer<typeof ClaimInputSummary>;

/** The submission as sent, without lease token, submission id, procedure and model (hoisted). */
export const RecordedSubmission = z.object({
  relations: z.array(ProposalItem),
  noLinks: z.array(NoLinkItem),
  summary: z.string().nullable(),
  costUsd: z.number().nullable(),
});
export type RecordedSubmission = z.infer<typeof RecordedSubmission>;

/**
 * The server's answer, per item in the order of `submission.relations`; the
 * no-link outcomes, withdrawn no-links and the number of uncovered pairs
 * where the server answered them (results since no-links are validated).
 * `uncovered` keeps the count only: the pairs would bloat the recordings.
 */
export const RecordedResult = z.object({
  replayed: z.boolean(),
  counts: SubmissionResult.shape.counts,
  withdrawn: z.number().int().min(0),
  items: z.array(
    z.object({
      index: z.number().int().min(0),
      result: ProposalOutcome,
      status: RelationStatus.nullable(),
      /** Left out with `--no-record-ids`. */
      relationId: RelationId.nullable().optional(),
    }),
  ),
  noLinks: SubmissionResult.shape.noLinks,
  withdrawnNoLinks: SubmissionResult.shape.withdrawnNoLinks,
  uncovered: z.object({ count: z.number().int().min(0) }).optional(),
});
export type RecordedResult = z.infer<typeof RecordedResult>;

/**
 * A line of a `relations` task (the format before M4b, unchanged: no `kind`,
 * so recordings made before placements still parse).
 */
export const RelationRecordingLine = z.object({
  format: z.literal(RECORDING_FORMAT),
  /**
   * The corpus landscape (`sample` for `_sample`): the project key when the
   * project was seeded under the landscape's name, else what `eval:live
   * --landscape` names.
   */
  landscape: ProjectKey,
  modelKey: ModelKey,
  /** Revision number of the analysed head. */
  rev: z.number().int().min(1),
  /** Agent name, e.g. `agent-sim`; for a live run the agent token's name (`claude-desktop-1`). */
  agent: z.string().min(1).max(100),
  procedure: DeclaredProcedure,
  llmModel: z.string().nullable(),
  /** Server ids (left out with `--no-record-ids`, so a re-run writes identical files). */
  task: z
    .object({
      taskId: AnalysisTaskId,
      revisionId: RevisionId,
      attempt: z.number().int().min(1),
      submissionId: z.string().nullable(),
    })
    .optional(),
  /**
   * The claim input as the agent received it, or its summary. Absent when the
   * line was built from a stored submission (`eval:live`): the server keeps
   * no claim inputs.
   */
  input: z.union([ClaimInputSummary, ClaimInput]).optional(),
  submission: RecordedSubmission,
  /** `submitted`: the server answered `result`; `dry-run`: released unsubmitted; `failed`: `problem`. */
  outcome: z.enum(['submitted', 'dry-run', 'failed']),
  result: RecordedResult.nullable(),
  problem: z.object({ code: z.string(), detail: z.string().nullable() }).optional(),
});
export type RelationRecordingLine = z.infer<typeof RelationRecordingLine>;

/** A placement claim input reduced to its counts (`--record-input summary`). */
export const PlacementClaimInputSummary = z.object({
  format: z.literal(CLAIM_PLACEMENT_FORMAT),
  summary: z.literal(true),
  steps: z.number().int().min(0),
  processes: z.number().int().min(0),
  truncated: z.boolean(),
  /** Size of the full input as the agent received it (UTF-8 JSON). */
  bytes: z.number().int().min(0),
});
export type PlacementClaimInputSummary = z.infer<typeof PlacementClaimInputSummary>;

/** A placement task's submission as sent, without lease token, submission id, procedure and model. */
export const RecordedPlacementSubmission = z.object({
  placements: z.array(PlacementItem),
  unsure: z.array(UnsureItem),
  summary: z.string().nullable(),
  costUsd: z.number().nullable(),
});
export type RecordedPlacementSubmission = z.infer<typeof RecordedPlacementSubmission>;

/** The server's answer to a placement submission; `skipped` keeps the count only. */
export const RecordedPlacementResult = z.object({
  replayed: z.boolean(),
  counts: PlacementSubmissionResult.shape.placements.shape.counts,
  withdrawn: z.number().int().min(0),
  items: z.array(
    z.object({
      index: z.number().int().min(0),
      result: PipelinePlacementOutcome,
      status: RelationStatus.nullable(),
      /** Left out with `--no-record-ids`. */
      placementId: PlacementId.nullable().optional(),
    }),
  ),
  unsure: PlacementSubmissionResult.shape.unsure,
  skipped: z.object({ count: z.number().int().min(0) }),
  followUp: z.boolean(),
});
export type RecordedPlacementResult = z.infer<typeof RecordedPlacementResult>;

/**
 * A line of a `placement` task (M4b): the chain revision instead of a model
 * revision (`valueChain`: key, revision number and content hash, so a run on
 * an edited chain is recognized), the placement submission and its result.
 */
export const PlacementRecordingLine = z.object({
  format: z.literal(RECORDING_FORMAT),
  kind: z.literal('placement'),
  landscape: ProjectKey,
  valueChain: z.object({
    key: ValueChainKey,
    rev: z.number().int().min(1),
    contentHash: Sha256Hex,
  }),
  agent: z.string().min(1).max(100),
  procedure: DeclaredProcedure,
  llmModel: z.string().nullable(),
  /** Server ids (left out with `--no-record-ids`). */
  task: z
    .object({
      taskId: AnalysisTaskId,
      revisionId: ValueChainRevisionId,
      attempt: z.number().int().min(1),
      submissionId: z.string().nullable(),
    })
    .optional(),
  /** The claim input as the agent received it, or its summary; absent for `eval:live`. */
  input: z.union([PlacementClaimInputSummary, PlacementClaimInput]).optional(),
  submission: RecordedPlacementSubmission,
  outcome: z.enum(['submitted', 'dry-run', 'failed']),
  result: RecordedPlacementResult.nullable(),
  problem: z.object({ code: z.string(), detail: z.string().nullable() }).optional(),
});
export type PlacementRecordingLine = z.infer<typeof PlacementRecordingLine>;

/**
 * One recorded task: a placement line (with `kind: "placement"`) or a
 * relations line (without `kind`).
 */
export const RecordingLine = z.union([PlacementRecordingLine, RelationRecordingLine]);
export type RecordingLine = z.infer<typeof RecordingLine>;

/** Whether a recording line is a placement task's. */
export function isPlacementLine(line: RecordingLine): line is PlacementRecordingLine {
  return 'kind' in line && line.kind === 'placement';
}

/** A path segment of the recordings layout: anything outside `[A-Za-z0-9._@-]` becomes `-`. */
export function recordingSegment(text: string): string {
  const s = text.replace(/[^A-Za-z0-9._@-]+/g, '-').replace(/^[.-]+|-+$/g, '');
  return s === '' ? 'none' : s;
}

/** `<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`, relative to `eval/recordings`. */
export function recordingPath(r: {
  procedure: DeclaredProcedure;
  agent: string;
  llmModel: string | null;
  landscape: string;
}): string {
  return [
    recordingSegment(`${r.procedure.id}@${r.procedure.version}`),
    recordingSegment(r.agent),
    recordingSegment(r.llmModel ?? 'none'),
    `${recordingSegment(r.landscape)}.jsonl`,
  ].join('/');
}
