/**
 * The simulation agent's loop (M2 item 8): works the ProA analysis pipeline
 * over MCP the way an LLM agent is told to by the `work_pipeline` prompt —
 * load the procedure, then claim → decide → submit until no task is left —
 * with the deterministic {@link decide} policy in place of the model.
 *
 * It talks to the server only through MCP tools (an {@link McpSession}), as
 * any external client does, and never decides: it only proposes.
 */
import { randomUUID } from 'node:crypto';

import {
  ClaimedAnalysis,
  SubmissionResult,
  type DeclaredProcedure,
  type SubmitAnalysisInput,
} from '@proa/contracts';

import { DEFAULT_POLICY, SIM_POLICY, decide, type Decision, type PolicyOptions } from './policy.ts';
import type { Recorder } from './recorder.ts';

/** Agent name in recordings and logs. */
export const AGENT_NAME = 'agent-sim';
/** The procedure the agent loads and follows (the claim names the expected version). */
export const PROCEDURE_ID = 'proa-relations';
/** The tools the loop needs. */
export const REQUIRED_TOOLS = ['claim_analysis', 'submit_analysis', 'release_analysis'] as const;

/** A tool result as the agent sees it. */
export interface ToolOutcome {
  isError: boolean;
  /** `structuredContent` (empty on errors). */
  data: Record<string, unknown>;
  /** The text content: JSON of the result, or of the RFC 9457 problem on errors. */
  text: string;
}

/** The MCP surface the loop uses; `connect()` provides it over HTTP or stdio, tests fake it. */
export interface McpSession {
  listTools(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  /** The prompt's text, or `null` when the server offers no prompts. */
  getPrompt(name: string, args: Record<string, string>): Promise<string | null>;
  close(): Promise<void>;
}

/** A failure that ends the run (missing tools, a failing claim). */
export class SimError extends Error {
  override readonly name = 'SimError';
}

export interface AgentOptions {
  /** Only this project (id or key). */
  projectId?: string;
  /** Only this model. */
  modelKey?: string;
  /** Stop after this many tasks. */
  maxTasks?: number;
  /** Decide and record, but hand every task back unsubmitted at the end. */
  dryRun?: boolean;
  policy?: PolicyOptions;
  /** Declared LLM model (default {@link SIM_POLICY}). */
  llmModel?: string;
  agent?: string;
  recorder?: Recorder | null;
  log?: (line: string) => void;
  /** Submission ids (default: random UUIDs). */
  newSubmissionId?: () => string;
}

export interface Problem {
  code: string;
  detail: string | null;
}

export interface TaskReport {
  taskId: string;
  projectKey: string;
  modelKey: string;
  attempt: number;
  outcome: 'submitted' | 'dry-run' | 'failed';
  proposed: number;
  questions: number;
  noLinks: number;
  submissionId: string | null;
  counts: SubmissionResult['counts'] | null;
  withdrawn: number | null;
  problem: Problem | null;
  recordedTo: string | null;
}

export interface AgentReport {
  /** The procedure from `get_procedure`, if the server offers it. */
  procedure: DeclaredProcedure | null;
  /** True if the `work_pipeline` prompt was available and read. */
  prompt: boolean;
  tasks: TaskReport[];
  /** Why the loop ended. */
  stop: 'no-work' | 'max-tasks' | 'repeated-task';
  totals: {
    tasks: number;
    submitted: number;
    failed: number;
    dryRun: number;
    proposed: number;
    questions: number;
    noLinks: number;
    outcomes: SubmissionResult['counts'];
    withdrawn: number;
  };
  /** Recording files written in this run. */
  recordings: string[];
}

/** The RFC 9457 problem in a tool error's text, or the text itself. */
export function problemOf(outcome: ToolOutcome): Problem {
  try {
    const p = JSON.parse(outcome.text) as { code?: unknown; detail?: unknown };
    if (typeof p.code === 'string') {
      return { code: p.code, detail: typeof p.detail === 'string' ? p.detail : null };
    }
  } catch {
    // not JSON: an SDK-level message such as an input validation failure
  }
  return { code: 'tool-error', detail: outcome.text.slice(0, 500) || null };
}

const describeProblem = (p: Problem) => (p.detail ? `${p.code}: ${p.detail}` : p.code);

/**
 * Runs the loop until no task is left (or `maxTasks`). Throws
 * {@link SimError} if the server lacks the pipeline tools or a claim fails;
 * a failing submission is reported per task and the loop goes on.
 */
export async function runAgent(
  session: McpSession,
  options: AgentOptions = {},
): Promise<AgentReport> {
  const log = options.log ?? (() => {});
  const policy = options.policy ?? DEFAULT_POLICY;
  const llmModel = options.llmModel ?? SIM_POLICY;
  const agent = options.agent ?? AGENT_NAME;
  const newSubmissionId = options.newSubmissionId ?? randomUUID;
  const scope = {
    ...(options.projectId ? { projectId: options.projectId } : {}),
    ...(options.modelKey ? { modelKey: options.modelKey } : {}),
  };

  const tools = await session.listTools();
  const missing = REQUIRED_TOOLS.filter((t) => !tools.includes(t));
  if (missing.length > 0) {
    throw new SimError(`the server offers no ${missing.join(', ')}; is this a ProA ≥ M2 /mcp?`);
  }

  // Like an LLM agent: read the procedure and the pipeline prompt first.
  let procedure: DeclaredProcedure | null = null;
  if (tools.includes('get_procedure')) {
    const p = await session.callTool('get_procedure', { id: PROCEDURE_ID });
    if (p.isError) {
      log(`get_procedure failed: ${describeProblem(problemOf(p))}`);
    } else {
      procedure = { id: String(p.data['id']), version: String(p.data['version']) };
      log(`procedure ${procedure.id}@${procedure.version} (${String(p.data['status'])})`);
    }
  }
  let promptText: string | null = null;
  try {
    promptText = await session.getPrompt(
      'work_pipeline',
      options.projectId ? { projectId: options.projectId } : {},
    );
  } catch (err) {
    log(`prompt work_pipeline unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (promptText !== null) {
    log(`prompt work_pipeline: ${promptText.length} characters`);
    if (!promptText.includes('claim_analysis')) {
      log('warning: the work_pipeline prompt does not mention claim_analysis');
    }
  }

  const tasks: TaskReport[] = [];
  /** Tasks to hand back when the run ends (dry run, refused submissions), with the reason. */
  const handBack: Array<{ claimed: ClaimedAnalysis; reason: string }> = [];
  const seen = new Set<string>();
  let stop: AgentReport['stop'] = 'no-work';
  const release = async (c: ClaimedAnalysis, reason: string) => {
    const r = await session.callTool('release_analysis', {
      taskId: c.taskId,
      leaseToken: c.leaseToken,
      reason,
    });
    if (r.isError) log(`release ${c.taskId} failed: ${describeProblem(problemOf(r))}`);
  };

  try {
    for (;;) {
      if (options.maxTasks !== undefined && tasks.length >= options.maxTasks) {
        stop = 'max-tasks';
        break;
      }
      const claim = await session.callTool('claim_analysis', { ...scope, max: 1 });
      if (claim.isError)
        throw new SimError(`claim_analysis failed: ${describeProblem(problemOf(claim))}`);
      const items = ClaimedAnalysis.array().parse(claim.data['items']);
      const claimed = items[0];
      if (!claimed) break;
      if (seen.has(claimed.taskId)) {
        // A task handed back earlier in this run (e.g. after a refused submission): do not loop on it.
        await release(claimed, 'agent-sim saw this task before in this run');
        stop = 'repeated-task';
        break;
      }
      seen.add(claimed.taskId);
      if (
        procedure &&
        (procedure.id !== claimed.procedure.id || procedure.version !== claimed.procedure.version)
      ) {
        log(
          `warning: get_procedure has ${procedure.id}@${procedure.version}, the claim expects ` +
            `${claimed.procedure.id}@${claimed.procedure.version}; declaring the claim's`,
        );
      }

      const decision = decide(claimed.input, policy);
      const report = await handle(claimed, decision);
      tasks.push(report);
      log(taskLine(report));
    }
  } finally {
    // Only now, so the next claim does not return the same task again (the attempt does not count).
    for (const h of handBack) await release(h.claimed, h.reason);
  }

  async function handle(claimed: ClaimedAnalysis, decision: Decision): Promise<TaskReport> {
    const base = {
      taskId: claimed.taskId,
      projectKey: claimed.projectKey,
      modelKey: claimed.modelKey,
      attempt: claimed.attempt,
      proposed: decision.relations.length,
      questions: decision.relations.filter((r) => r.question !== null).length,
      noLinks: decision.noLinks.length,
    };
    const record = async (
      outcome: TaskReport['outcome'],
      submissionId: string | null,
      result: SubmissionResult | null,
      problem: Problem | null,
    ) =>
      options.recorder
        ? options.recorder.record({
            agent,
            llmModel,
            claimed,
            decision,
            submissionId,
            outcome,
            result,
            ...(problem ? { problem } : {}),
          })
        : null;

    if (options.dryRun) {
      handBack.push({ claimed, reason: 'agent-sim dry run' });
      return {
        ...base,
        outcome: 'dry-run',
        submissionId: null,
        counts: null,
        withdrawn: null,
        problem: null,
        recordedTo: await record('dry-run', null, null, null),
      };
    }

    const submissionId = newSubmissionId();
    const body: SubmitAnalysisInput & { taskId: string } = {
      taskId: claimed.taskId,
      leaseToken: claimed.leaseToken,
      submissionId,
      procedure: claimed.procedure,
      llmModel,
      relations: decision.relations,
      noLinks: decision.noLinks,
      summary: decision.summary,
      costUsd: 0,
    };
    let outcome: ToolOutcome;
    try {
      outcome = await session.callTool('submit_analysis', body);
    } catch (err) {
      // Transport failure: the submission may or may not have arrived; the same
      // submissionId makes the retry a replay if it did.
      log(
        `submit ${claimed.taskId}: ${err instanceof Error ? err.message : String(err)}; retrying`,
      );
      outcome = await session.callTool('submit_analysis', body);
    }
    if (outcome.isError) {
      const problem = problemOf(outcome);
      if (problem.code === 'validation-failed' || problem.code === 'tool-error') {
        // The server refused the body itself: hand the task back at the end of the run instead
        // of letting the lease run out (lease-lost, task-cancelled, already-submitted: nothing to hand back).
        handBack.push({ claimed, reason: `agent-sim: submission refused (${problem.code})` });
      }
      return {
        ...base,
        outcome: 'failed',
        submissionId,
        counts: null,
        withdrawn: null,
        problem,
        recordedTo: await record('failed', submissionId, null, problem),
      };
    }
    const result = SubmissionResult.parse(outcome.data);
    return {
      ...base,
      outcome: 'submitted',
      submissionId,
      counts: result.counts,
      withdrawn: result.withdrawn,
      problem: null,
      recordedTo: await record('submitted', submissionId, result, null),
    };
  }

  const outcomes = { applied: 0, duplicate: 0, suppressed: 0, reopened: 0, invalid: 0 };
  for (const t of tasks) {
    if (!t.counts) continue;
    for (const k of Object.keys(outcomes) as (keyof typeof outcomes)[]) outcomes[k] += t.counts[k];
  }
  return {
    procedure,
    prompt: promptText !== null,
    tasks,
    stop,
    totals: {
      tasks: tasks.length,
      submitted: tasks.filter((t) => t.outcome === 'submitted').length,
      failed: tasks.filter((t) => t.outcome === 'failed').length,
      dryRun: tasks.filter((t) => t.outcome === 'dry-run').length,
      proposed: tasks.reduce((n, t) => n + t.proposed, 0),
      questions: tasks.reduce((n, t) => n + t.questions, 0),
      noLinks: tasks.reduce((n, t) => n + t.noLinks, 0),
      outcomes,
      withdrawn: tasks.reduce((n, t) => n + (t.withdrawn ?? 0), 0),
    },
    recordings: options.recorder ? [...options.recorder.files] : [],
  };
}

/** One log line per task. */
export function taskLine(t: TaskReport): string {
  const head = `${t.projectKey} ${t.modelKey} (${t.taskId}, attempt ${t.attempt}): ${t.proposed} proposed, ${t.questions} with a question, ${t.noLinks} no-links`;
  if (t.outcome === 'dry-run') return `${head}; dry run, not submitted`;
  if (t.outcome === 'failed')
    return `${head}; FAILED ${t.problem ? describeProblem(t.problem) : ''}`;
  const c = t.counts;
  return `${head}; applied ${c?.applied ?? 0}, duplicate ${c?.duplicate ?? 0}, suppressed ${c?.suppressed ?? 0}, reopened ${c?.reopened ?? 0}, invalid ${c?.invalid ?? 0}, withdrawn ${t.withdrawn ?? 0}`;
}
