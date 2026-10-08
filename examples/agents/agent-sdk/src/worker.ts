/**
 * Reference worker for ProA's analysis pipeline with the Claude Agent SDK
 * (README.md next to this directory). It long-polls
 * `GET /api/v1/analyses/pending` and runs one fresh `query()` per claimable
 * task, which claims, analyses and submits exactly one task. The agent has
 * ProA's MCP tools only (no built-in tools, no settings from disk) and gets
 * its instructions from ProA: the MCP prompt `work_pipeline` with the
 * procedure embedded, or, with `--plugin-dir`, the skill `/proa:relations`.
 *
 * Billing: the Agent SDK authenticates with an Anthropic API key
 * (`ANTHROPIC_API_KEY`); Anthropic does not allow claude.ai logins for
 * agents built on the SDK.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  query,
  type McpHttpServerConfig,
  type Options,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const USAGE = `Usage: node src/worker.ts --project <key> --model <id> [options]

  --project <key>         project key or prj_ id (the project of the agent token)
  --model <id>            exact model id, e.g. claude-sonnet-5-5 (declared as llmModel)
  --once                  stop when nothing is pending instead of waiting for new tasks
  --max-tasks <n>         stop after n tasks
  --plugin-dir <path>     use the skill /proa:relations from this plugin directory
                          (default: the MCP prompt work_pipeline from ProA)
  --max-turns <n>         turns per task (default 80)
  --max-budget-usd <x>    spending cap per task

Environment: PROA_TOKEN (agent token, required), PROA_URL (default
http://127.0.0.1:7400), ANTHROPIC_API_KEY (required).`;

/** Long-poll bound of the pending endpoint (MAX_WAIT_SECONDS). */
const WAIT_SECONDS = 30;
/** Stop after this many tasks in a row without progress. */
const MAX_FAILURES = 3;

function fail(message: string): never {
  console.error(`proa-worker: ${message}`);
  process.exit(2);
}

function positive(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!(n > 0) || !Number.isFinite(n)) fail(`${name} must be a positive number`);
  return n;
}

const { values: args } = parseArgs({
  options: {
    project: { type: 'string' },
    model: { type: 'string' },
    once: { type: 'boolean', default: false },
    'max-tasks': { type: 'string' },
    'plugin-dir': { type: 'string' },
    'max-turns': { type: 'string', default: '80' },
    'max-budget-usd': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const project = args.project ?? fail(`--project is required\n\n${USAGE}`);
const model = args.model ?? fail(`--model is required\n\n${USAGE}`);
if (!/^[A-Za-z0-9_-]{1,64}$/.test(project)) fail('--project must be a project key or prj_ id');
// The agent declares this id as llmModel, so an alias such as "sonnet" would be recorded.
if (!/^claude-[a-z0-9.-]+$/.test(model))
  fail('--model must be an exact id such as claude-sonnet-5-5');
const maxTasks = positive('--max-tasks', args['max-tasks']);
const maxTurns = positive('--max-turns', args['max-turns']);
const maxBudgetUsd = positive('--max-budget-usd', args['max-budget-usd']);
const pluginDir = args['plugin-dir'] === undefined ? undefined : resolve(args['plugin-dir']);

const url = (process.env['PROA_URL'] ?? 'http://127.0.0.1:7400').replace(/\/+$/, '');
const token = process.env['PROA_TOKEN'] || fail('set PROA_TOKEN to the agent token (proa_at_…)');
if (!process.env['ANTHROPIC_API_KEY']) {
  fail('set ANTHROPIC_API_KEY: the Agent SDK bills an Anthropic API key, never a claude.ai login');
}

/** The connection the agent gets: ProA's MCP server and nothing else. */
const proa: McpHttpServerConfig = {
  type: 'http',
  url: `${url}/mcp`,
  headers: { Authorization: `Bearer ${token}` },
  // ProA's tools up front, not behind tool search (the built-in tools are off).
  alwaysLoad: true,
};

const stop = new AbortController();
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error(`proa-worker: ${signal}, stopping (again to quit at once)`);
    stop.abort();
  });
}

/** Claimable tasks of the project; `wait` > 0 long-polls until one is queued. */
async function pending(wait: number): Promise<number> {
  const res = await fetch(
    `${url}/api/v1/analyses/pending?projectId=${encodeURIComponent(project)}&wait=${wait}`,
    { headers: { authorization: `Bearer ${token}` }, signal: stop.signal },
  );
  if (!res.ok) throw new Error(`GET /api/v1/analyses/pending: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { total?: unknown };
  if (typeof body.total !== 'number') throw new Error('GET /api/v1/analyses/pending: no total');
  return body.total;
}

/** The instructions for one task: ProA's MCP prompt, or the plugin skill. */
async function instructions(): Promise<string> {
  if (pluginDir) return `/proa:relations ${project} 1`;
  const client = new Client({ name: 'proa-agent-sdk-worker', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const prompt = await client.getPrompt({
      name: 'work_pipeline',
      arguments: { projectId: project, maxTasks: '1' },
    });
    return prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
  } finally {
    await client.close();
  }
}

/** One fresh agent session for one task, in an empty directory outside any checkout. */
async function runTask(): Promise<SDKResultMessage | null> {
  const cwd = await mkdtemp(join(tmpdir(), 'proa-agent-'));
  const options: Options = {
    model,
    cwd,
    abortController: stop,
    mcpServers: { proa },
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    allowedTools: ['mcp__proa__*'],
    permissionMode: 'dontAsk',
    persistSession: false,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `You work ProA's analysis pipeline with the tools of the MCP server "proa" only. Your exact model id is ${model}.`,
    },
    ...(maxTurns === undefined ? {} : { maxTurns }),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    ...(pluginDir ? { plugins: [{ type: 'local', path: pluginDir, skipMcpDiscovery: true }] } : {}),
  };
  try {
    const run = query({ prompt: await instructions(), options });
    let result: SDKResultMessage | null = null;
    for await (const message of run) {
      if (message.type === 'system' && message.subtype === 'init') {
        const status = message.mcp_servers.find((s) => s.name === 'proa')?.status ?? 'missing';
        if (status === 'failed' || status === 'needs-auth' || status === 'missing') {
          run.close();
          throw new Error(`MCP server proa is ${status} (PROA_URL, PROA_TOKEN?)`);
        }
      }
      if (message.type === 'result') result = message;
    }
    return result;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

let done = 0;
let failures = 0;
let cost = 0;
try {
  let before = await pending(0);
  console.error(`proa-worker: ${project} on ${url}, ${before} pending, model ${model}`);
  while (!interrupted && (maxTasks === undefined || done < maxTasks)) {
    if (before === 0) {
      if (args.once) break;
      before = await pending(WAIT_SECONDS);
      continue;
    }
    done += 1;
    let ok = false;
    try {
      const r = await runTask();
      ok = r?.subtype === 'success' && !r.is_error;
      cost += r?.total_cost_usd ?? 0;
      console.log(
        JSON.stringify({
          task: done,
          subtype: r?.subtype ?? 'no-result',
          isError: r?.is_error ?? true,
          turns: r?.num_turns,
          costUsd: r?.total_cost_usd,
          durationMs: r?.duration_ms,
          result: r === null ? null : r.subtype === 'success' ? r.result : r.errors,
        }),
      );
    } catch (err) {
      if (interrupted) break;
      console.log(JSON.stringify({ task: done, error: String(err) }));
    }
    const after = await pending(0);
    // Progress: the run succeeded and the queue got shorter (a release puts the task back).
    failures = ok && after < before ? 0 : failures + 1;
    if (failures >= MAX_FAILURES) {
      console.error(`proa-worker: ${MAX_FAILURES} tasks in a row without progress, stopping`);
      process.exitCode = 1;
      break;
    }
    before = after;
  }
} catch (err) {
  if (!interrupted) {
    console.error(`proa-worker: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
console.error(`proa-worker: ${done} tasks, estimated cost ${cost.toFixed(4)} USD`);
