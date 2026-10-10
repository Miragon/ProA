/**
 * Writes recordings in the eval layout (CONCEPT §7):
 * `<dir>/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`, one
 * `proa-recording/1` line per analysed task (`RecordingLine` in
 * `@proa/contracts`): a relations line per model task (the format before
 * M4b, unchanged) or a placement line per value chain task (`kind:
 * "placement"`, M4 §8). The procedures differ, so the two kinds never share
 * a file. A run starts every file it writes afresh, so a re-run replaces the
 * recording of a landscape instead of appending to it.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CLAIM_INPUT_FORMAT,
  CLAIM_PLACEMENT_FORMAT,
  RECORDING_FORMAT,
  recordingPath,
  type ClaimInput,
  type ClaimInputSummary,
  type ClaimedPlacementAnalysis,
  type ClaimedRelationsAnalysis,
  type PlacementClaimInput,
  type PlacementClaimInputSummary,
  type PlacementRecordingLine,
  type PlacementSubmissionResult,
  type RecordedPlacementResult,
  type RecordedResult,
  type RecordingLine,
  type RelationRecordingLine,
  type SubmissionResult,
} from '@proa/contracts';

import type { PlacementDecision } from './placement-policy.ts';
import type { Decision } from './policy.ts';

/** `full`: the claim input as received; `summary`: its counts and size only (small files). */
export type InputMode = 'full' | 'summary';

export interface RecorderOptions {
  /** Root of the layout, e.g. `eval/recordings`. */
  dir: string;
  input: InputMode;
  /** Include server ids (task, revision, submission, relations). Without them a re-run writes identical files. */
  ids: boolean;
}

/** A relations task as the agent worked it. */
export interface RecordedTask {
  agent: string;
  llmModel: string | null;
  claimed: ClaimedRelationsAnalysis;
  decision: Pick<Decision, 'relations' | 'noLinks' | 'summary'>;
  submissionId: string | null;
  outcome: RelationRecordingLine['outcome'];
  result: SubmissionResult | null;
  problem?: { code: string; detail: string | null };
}

/** A placement task as the agent worked it. */
export interface RecordedPlacementTask {
  agent: string;
  llmModel: string | null;
  claimed: ClaimedPlacementAnalysis;
  decision: Pick<PlacementDecision, 'placements' | 'unsure' | 'summary'>;
  submissionId: string | null;
  outcome: PlacementRecordingLine['outcome'];
  result: PlacementSubmissionResult | null;
  problem?: { code: string; detail: string | null };
}

/** A task of either kind for {@link Recorder.record}. */
export type AnyRecordedTask = RecordedTask | RecordedPlacementTask;

export function summarizeInput(input: ClaimInput): ClaimInputSummary {
  return {
    format: CLAIM_INPUT_FORMAT,
    summary: true,
    facts: input.facts.length,
    candidates: input.candidates.length,
    partners: Object.keys(input.partners).length,
    relations: input.relations.length,
    bytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
  };
}

/** A placement claim input reduced to its counts and size (`--record-input summary`). */
export function summarizePlacementInput(input: PlacementClaimInput): PlacementClaimInputSummary {
  return {
    format: CLAIM_PLACEMENT_FORMAT,
    summary: true,
    steps: input.steps.length,
    processes: input.processes.length,
    truncated: input.truncated,
    bytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
  };
}

/**
 * The server's answer to a placement submission as recorded, with a stable
 * key order: `skipped` as its count (the refs would repeat the input).
 * `eval:live` (`eval/tools/src/live-recordings.ts`) maps a stored result the
 * same way; the server test `agent-sim.test.ts` requires byte-identical lines.
 */
export function recordedPlacementResult(
  result: PlacementSubmissionResult,
  ids: boolean,
): RecordedPlacementResult {
  return {
    replayed: result.replayed,
    counts: {
      applied: result.placements.counts.applied,
      duplicate: result.placements.counts.duplicate,
      suppressed: result.placements.counts.suppressed,
      reopened: result.placements.counts.reopened,
      invalid: result.placements.counts.invalid,
    },
    withdrawn: result.withdrawn,
    items: result.placements.items.map((i) => ({
      index: i.index,
      result: i.result,
      status: i.status,
      ...(ids ? { placementId: i.placementId } : {}),
    })),
    unsure: {
      items: result.unsure.items.map((i) => ({ index: i.index, result: i.result })),
      counts: {
        stored: result.unsure.counts.stored,
        duplicate: result.unsure.counts.duplicate,
        invalid: result.unsure.counts.invalid,
      },
    },
    skipped: { count: result.skipped.count },
    followUp: result.followUp,
  };
}

/** One placement recording line, with a stable key order. */
export function placementRecordingLine(
  task: RecordedPlacementTask,
  options: Omit<RecorderOptions, 'dir'>,
): PlacementRecordingLine {
  const { claimed } = task;
  const chain = claimed.input.valueChain;
  return {
    format: RECORDING_FORMAT,
    kind: 'placement',
    landscape: claimed.projectKey,
    valueChain: { key: claimed.valueChainKey, rev: chain.rev, contentHash: chain.contentHash },
    agent: task.agent,
    procedure: { id: claimed.procedure.id, version: claimed.procedure.version },
    llmModel: task.llmModel,
    ...(options.ids
      ? {
          task: {
            taskId: claimed.taskId,
            revisionId: claimed.revisionId,
            attempt: claimed.attempt,
            submissionId: task.submissionId,
          },
        }
      : {}),
    input: options.input === 'full' ? claimed.input : summarizePlacementInput(claimed.input),
    submission: {
      placements: task.decision.placements.map((p) => ({
        step: p.step,
        process: p.process,
        confidence: p.confidence,
        rationale: p.rationale,
        evidence: p.evidence,
        question: p.question,
      })),
      unsure: task.decision.unsure.map((u) => ({ process: u.process, reason: u.reason })),
      summary: task.decision.summary,
      costUsd: 0,
    },
    outcome: task.outcome,
    result: task.result ? recordedPlacementResult(task.result, options.ids) : null,
    ...(task.problem ? { problem: task.problem } : {}),
  };
}

const isPlacementTask = (t: AnyRecordedTask): t is RecordedPlacementTask =>
  t.claimed.kind === 'placement';

/**
 * The server's result as recorded, with a stable key order: the no-link
 * outcomes, withdrawn no-links and the number of uncovered pairs (not the
 * pairs) only where the server answered them (since `proa-relations@0.2.0`). `eval:live`
 * (`eval/tools/src/live-recordings.ts`) maps a stored result the same way;
 * the server test `agent-sim.test.ts` requires byte-identical lines.
 */
export function recordedResult(result: SubmissionResult, ids: boolean): RecordedResult {
  return {
    replayed: result.replayed,
    counts: {
      applied: result.counts.applied,
      duplicate: result.counts.duplicate,
      suppressed: result.counts.suppressed,
      reopened: result.counts.reopened,
      invalid: result.counts.invalid,
    },
    withdrawn: result.withdrawn,
    items: result.items.map((i) => ({
      index: i.index,
      result: i.result,
      status: i.status,
      ...(ids ? { relationId: i.relationId } : {}),
    })),
    ...(result.noLinks
      ? {
          noLinks: {
            items: result.noLinks.items.map((i) => ({ index: i.index, result: i.result })),
            counts: {
              stored: result.noLinks.counts.stored,
              duplicate: result.noLinks.counts.duplicate,
              invalid: result.noLinks.counts.invalid,
            },
          },
        }
      : {}),
    ...(result.withdrawnNoLinks !== undefined ? { withdrawnNoLinks: result.withdrawnNoLinks } : {}),
    ...(result.uncovered ? { uncovered: { count: result.uncovered.count } } : {}),
  };
}

/** One recording line, with a stable key order. */
export function recordingLine(
  task: RecordedTask,
  options: Omit<RecorderOptions, 'dir'>,
): RelationRecordingLine {
  const { claimed } = task;
  const result = task.result ? recordedResult(task.result, options.ids) : null;
  return {
    format: RECORDING_FORMAT,
    landscape: claimed.projectKey,
    modelKey: claimed.modelKey,
    rev: claimed.input.model.rev,
    agent: task.agent,
    procedure: { id: claimed.procedure.id, version: claimed.procedure.version },
    llmModel: task.llmModel,
    ...(options.ids
      ? {
          task: {
            taskId: claimed.taskId,
            revisionId: claimed.revisionId,
            attempt: claimed.attempt,
            submissionId: task.submissionId,
          },
        }
      : {}),
    input: options.input === 'full' ? claimed.input : summarizeInput(claimed.input),
    submission: {
      relations: task.decision.relations.map((r) => ({
        type: r.type,
        from: r.from,
        to: r.to,
        confidence: r.confidence,
        rationale: r.rationale,
        evidence: r.evidence,
        question: r.question,
      })),
      noLinks: task.decision.noLinks.map((n) => ({
        type: n.type,
        from: n.from,
        to: n.to,
        reason: n.reason,
      })),
      summary: task.decision.summary,
      costUsd: 0,
    },
    outcome: task.outcome,
    result,
    ...(task.problem ? { problem: task.problem } : {}),
  };
}

export interface Recorder {
  record(task: AnyRecordedTask): Promise<string>;
  /** Files written in this run, absolute, in the order first written. */
  readonly files: readonly string[];
}

export function createRecorder(options: RecorderOptions): Recorder {
  const files: string[] = [];
  return {
    files,
    async record(task) {
      const line: RecordingLine = isPlacementTask(task)
        ? placementRecordingLine(task, options)
        : recordingLine(task, options);
      const file = path.resolve(options.dir, recordingPath(line));
      const text = `${JSON.stringify(line)}\n`;
      if (files.includes(file)) {
        await appendFile(file, text);
      } else {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text);
        files.push(file);
      }
      return file;
    },
  };
}
