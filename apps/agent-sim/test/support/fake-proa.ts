/**
 * An in-memory stand-in for ProA's `/mcp`: the SDK's `createMcpHandler` with
 * the pipeline tools (claim, submit, release), `get_procedure` and the
 * `work_pipeline` prompt, served through a `fetch` the agent's HTTP
 * transport uses. It records what the agent sends.
 */
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import {
  AnalysisTaskId,
  ClaimAnalysisBody,
  ClaimedAnalysis,
  ReleaseAnalysisBody,
  SubmissionResult,
  SubmitAnalysisBody,
  newId,
  type ClaimInput,
} from '@proa/contracts';
import { z } from 'zod';

import { claimInput, claimed } from './fixtures.ts';

export const TOKEN = `proa_at_${'t'.repeat(43)}`;

export interface FakeProaOptions {
  /** Tasks in the queue (default 3), each around {@link claimInput}. */
  tasks?: number;
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
    queue: Array.from({ length: options.tasks ?? 3 }, () => claimed('demo', input())),
    claimed: new Map(),
    claims: [],
    submissions: [],
    releases: [],
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
          const items = state.queue.splice(0, args.max).map((c) => ({ ...c, attempt: c.attempt }));
          for (const c of items) state.claimed.set(c.taskId, c);
          return result({ items });
        },
      );
    }
    server.registerTool(
      'submit_analysis',
      {
        inputSchema: SubmitAnalysisBody.extend({ taskId: AnalysisTaskId }),
        outputSchema: z.object(SubmissionResult.shape),
      },
      (args) => {
        const n = state.submissions.length;
        state.submissions.push(args);
        const p = options.submitProblem?.(n);
        if (p) return problem(p);
        state.claimed.delete(args.taskId);
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
        { argsSchema: z.object({ projectId: z.string().optional() }) },
        () => ({
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: 'Loop: claim_analysis, submit_analysis.' },
            },
          ],
        }),
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
