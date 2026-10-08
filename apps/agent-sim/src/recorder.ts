/**
 * Writes recordings in the eval layout (CONCEPT §7):
 * `<dir>/<procedure>@<version>/<agent>/<llmModel>/<landscape>.jsonl`, one
 * `proa-recording/1` line per analysed task (`RecordingLine` in
 * `@proa/contracts`). A run starts every file it writes afresh, so a re-run
 * replaces the recording of a landscape instead of appending to it.
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CLAIM_INPUT_FORMAT,
  RECORDING_FORMAT,
  recordingPath,
  type ClaimInput,
  type ClaimInputSummary,
  type ClaimedAnalysis,
  type RecordedResult,
  type RecordingLine,
  type SubmissionResult,
} from '@proa/contracts';

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

export interface RecordedTask {
  agent: string;
  llmModel: string | null;
  claimed: ClaimedAnalysis;
  decision: Pick<Decision, 'relations' | 'noLinks' | 'summary'>;
  submissionId: string | null;
  outcome: RecordingLine['outcome'];
  result: SubmissionResult | null;
  problem?: { code: string; detail: string | null };
}

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
): RecordingLine {
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
  record(task: RecordedTask): Promise<string>;
  /** Files written in this run, absolute, in the order first written. */
  readonly files: readonly string[];
}

export function createRecorder(options: RecorderOptions): Recorder {
  const files: string[] = [];
  return {
    files,
    async record(task) {
      const line = recordingLine(task, options);
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
