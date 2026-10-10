/**
 * An in-memory stand-in for ProA's `/mcp`: the SDK's `createMcpHandler` with
 * the pipeline tools (claim, submit, release), `get_procedure` and the
 * `work_pipeline` prompt, served through a `fetch` the agent's HTTP
 * transport uses. It records what the agent sends. Relations tasks come
 * first in the queue, then placement tasks; a claim takes the oldest tasks
 * of the kinds it names.
 */
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  AnalysisTaskId,
  ClaimAnalysisBody,
  ClaimedAnalysis,
  ReleaseAnalysisBody,
  SubmitAnalysisBody,
  newId,
  type ClaimInput,
  type PlacementClaimInput,
  type PlacementSubmissionResult,
  type SubmissionResult,
} from '@proa/contracts';
import { z } from 'zod';

import { claimInput, claimed } from './fixtures.ts';
import { claimedPlacement, placementInput } from './placement-fixtures.ts';

export const TOKEN = `proa_at_${'t'.repeat(43)}`;

export interface FakeProaOptions {
  /** Relations tasks in the queue (default 3), each around {@link claimInput}. */
  tasks?: number;
  /** Placement tasks after them (default 0), each around {@link placementInput}. */
  placements?: number;
  placementInput?: () => PlacementClaimInput;
  /** Offer the `work_pipeline` prompt (default true). */
  prompts?: boolean;
  /** Offer `get_procedure` (default true). */
  procedure?: boolean;
  /** Leave out a pipeline tool. */
  without?: string;
  /** A problem to answer the n-th submit (0-based) with, instead of a result. */
  submitProblem?: (n: number) => { code: string; status: number; detail: string } | null;
  input?: () => ClaimInput;
}

export interface FakeProa {
  fetch: typeof globalThis.fetch;
  /** Queued tasks, oldest first. */
  queue: ClaimedAnalysis[];
  /** Claimed and not yet submitted or released, by task id. */
  claimed: Map<string, ClaimedAnalysis>;
  claims: Array<Record<string, unknown>>;
  submissions: Array<Record<string, unknown>>;
  releases: Array<Record<string, unknown>>;
  /** Arguments of every `work_pipeline` read. */
  prompts: Array<Record<string, unknown>>;
  /** Authorization headers seen. */
  authorizations: string[];
}

function result(output: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(output) }],
    structuredContent: output as Record<string, unknown>,
  };
}

function problem(p: { code: string; status: number; detail: string }) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(p) }], isError: true };
}

export function fakeProa(options: FakeProaOptions = {}): FakeProa {
  const input = options.input ?? (() => claimInput());
  const state: FakeProa = {
    fetch: () => Promise.resolve(new Response(null, { status: 500 })),
    queue: [
      ...Array.from({ length: options.tasks ?? 3 }, () => claimed('demo', input())),
      ...Array.from({ length: options.placements ?? 0 }, () =>
        claimedPlacement('demo', (options.placementInput ?? (() => placementInput()))()),
      ),
    ],
    claimed: new Map(),
    claims: [],
    submissions: [],
    releases: [],
    prompts: [],
    authorizations: [],
  };

  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'proa', version: '0.0.0-fake' });
    if (options.procedure !== false) {
      server.registerTool(
        'get_procedure',
        {
          inputSchema: z.object({ id: z.string() }),
          outputSchema: z.object({
            id: z.string(),
            version: z.string(),
            status: z.string(),
            text: z.string(),
          }),
        },
        (args) =>
          result({
            id: args.id,
            version: '0.0.1',
            status: 'placeholder',
            text: 'claim, analyse, submit',
          }),
      );
    }
    if (options.without !== 'claim_analysis') {
      server.registerTool(
        'claim_analysis',
        {
          inputSchema: ClaimAnalysisBody,
          outputSchema: z.object({ items: z.array(ClaimedAnalysis) }),
        },
        (args) => {
          state.claims.push(args);
          const items: ClaimedAnalysis[] = [];
          for (const c of [...state.queue]) {
            if (items.length >= args.max) break;
            if (!args.kinds.includes(c.kind)) continue;
            if (
              args.modelKey !== undefined &&
              (c.kind !== 'relations' || c.modelKey !== args.modelKey)
            )
              continue;
            state.queue.splice(state.queue.indexOf(c), 1);
            items.push(c);
          }
          for (const c of items) state.claimed.set(c.taskId, c);
          return result({ items });
        },
      );
    }
    server.registerTool(
      'submit_analysis',
      {
        inputSchema: SubmitAnalysisBody.extend({ taskId: AnalysisTaskId }),
        // Either result shape, as the server's flat superset.
        outputSchema: z.looseObject({}),
      },
      (args) => {
        const n = state.submissions.length;
        state.submissions.push(args);
        const p = options.submitProblem?.(n);
        if (p) return problem(p);
        const task = state.claimed.get(args.taskId);
        state.claimed.delete(args.taskId);
        if (task?.kind === 'placement') {
          const placements = args.placements ?? [];
          const unsure = args.unsure ?? [];
          const placed = new Set(placements.map((x) => x.process));
          const said = new Set([...placed, ...unsure.map((x) => x.process)]);
          const skipped = task.input.processes
            .map((x) => x.process)
            .filter((ref) => !said.has(ref));
          return result({
            kind: 'placement',
            taskId: args.taskId,
            submissionId: args.submissionId,
            replayed: false,
            placements: {
              items: placements.map((_, index) => ({
                index,
                result: 'applied',
                placementId: newId('placement'),
                status: 'proposed',
              })),
              counts: {
                applied: placements.length,
                duplicate: 0,
                suppressed: 0,
                reopened: 0,
                invalid: 0,
              },
            },
            unsure: {
              items: unsure.map((_, index) => ({ index, result: 'stored' })),
              counts: { stored: unsure.length, duplicate: 0, invalid: 0 },
            },
            withdrawn: 0,
            skipped: { count: skipped.length, processes: skipped },
            followUp: task.input.truncated,
          } satisfies PlacementSubmissionResult);
        }
        return result({
          taskId: args.taskId,
          submissionId: args.submissionId,
          replayed: false,
          items: args.relations.map((_, index) => ({
            index,
            result: 'applied',
            relationId: newId('relation'),
            status: 'proposed',
          })),
          counts: {
            applied: args.relations.length,
            duplicate: 0,
            suppressed: 0,
            reopened: 0,
            invalid: 0,
          },
          withdrawn: 0,
        } satisfies SubmissionResult);
      },
    );
    server.registerTool(
      'release_analysis',
      { inputSchema: ReleaseAnalysisBody.extend({ taskId: z.string() }) },
      (args) => {
        state.releases.push(args);
        const c = state.claimed.get(args.taskId);
        if (c) {
          state.claimed.delete(args.taskId);
          state.queue.unshift(c);
        }
        return result({ taskId: args.taskId, state: 'queued' });
      },
    );
    if (options.prompts !== false) {
      server.registerPrompt(
        'work_pipeline',
        {
          argsSchema: z.object({
            projectId: z.string().optional(),
            kind: z.enum(['relations', 'placement']).optional(),
          }),
        },
        (args) => {
          state.prompts.push(args);
          return {
            messages: [
              {
                role: 'user' as const,
                content: { type: 'text' as const, text: 'Loop: claim_analysis, submit_analysis.' },
              },
            ],
          };
        },
      );
    }
    return server;
  });

  state.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const req = new Request(url, init);
    state.authorizations.push(req.headers.get('authorization') ?? '');
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) {
      return new Response(JSON.stringify({ code: 'unauthorized', status: 401 }), { status: 401 });
    }
    return handler.fetch(req);
  };
  return state;
}
