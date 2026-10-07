/**
 * Live check of a running ProA, the way a user runs it: the Docker stack of
 * docker/compose.yaml (or `pnpm dev`) after `proa seed`.
 *
 *   PROA_LIVE_URL=http://127.0.0.1:7400 pnpm --filter @proa/cli test:live
 *
 * - The owner's steps use the stack's own CLI: `docker exec
 *   <PROA_LIVE_CONTAINER> proa token create …` (default `proa2-proa-1`); with
 *   `PROA_LIVE_CONTAINER=` the CLI of this checkout with the local owner key.
 * - MCP over HTTP with the SDK client and an agent token, as Claude Code
 *   connects (2025-11-25 and 2026-07-28).
 * - `proa mcp` started exactly as the Claude Desktop entries say (from the
 *   checkout with node, and with `docker exec` into the container), with the
 *   environment a macOS GUI app has: no shell `PATH`, working directory `/`.
 *
 * Expects the seeded landscapes (`proa seed`) and compares with
 * eval/reports/candidates.json. Creates agent tokens in nordwind-handel and
 * stadtwerke-auental and revokes them at the end. Skipped without
 * PROA_LIVE_URL, so `pnpm test` never touches a running stack.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { CreatedAgentToken } from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLI_MAIN, claudeDesktopServer } from '../../src/mcp-config.ts';

const run = promisify(execFile);
const LIVE_URL = process.env['PROA_LIVE_URL']?.replace(/\/+$/, '');
const CONTAINER = process.env['PROA_LIVE_CONTAINER'] ?? 'proa2-proa-1';
/** What launchd gives a GUI app such as Claude Desktop on macOS. */
const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const PROJECT = 'nordwind-handel';
const FOREIGN = 'stadtwerke-auental';

interface ReportLandscape {
  name: string;
  counts: { models: number; rules: { accepted: number; proposed: number } };
}
const report = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../eval/reports/candidates.json', import.meta.url)),
    'utf8',
  ),
) as { landscapes: ReportLandscape[] };
const expected = report.landscapes.find((l) => l.name === PROJECT)?.counts;

/** Absolute path of an executable on this process's PATH (what `which` prints). */
function which(command: string): string {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  throw new Error(`${command} not found on PATH`);
}

/** The `proa` CLI as the owner: in the container, or from this checkout. */
async function proa(args: string[]): Promise<string> {
  const { stdout } = CONTAINER
    ? await run(which('docker'), ['exec', CONTAINER, 'proa', ...args])
    : await run(process.execPath, [CLI_MAIN, '--url', LIVE_URL ?? '', ...args]);
  return stdout;
}

async function createToken(project: string, name: string): Promise<CreatedAgentToken> {
  const out = await proa([
    'token',
    'create',
    '--project',
    project,
    '--name',
    name,
    '--scopes',
    'read,propose',
    '--expires',
    '1d',
    '--json',
  ]);
  return JSON.parse(out) as CreatedAgentToken;
}

const created: { project: string; id: string }[] = [];
const clients: Client[] = [];
let token: CreatedAgentToken;

async function connect(transport: StreamableHTTPClientTransport | StdioClientTransport) {
  const client = new Client({ name: 'proa-live', version: '0' });
  clients.push(client);
  await client.connect(transport);
  await client.listTools();
  return client;
}

function http(secret: string): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(`${LIVE_URL ?? ''}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${secret}` } },
  });
}

/** Starts an MCP server entry of claude_desktop_config.json the way Claude Desktop does. */
function desktop(entry: { command: string; args: string[]; env: Record<string, string> }) {
  return new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: { ...entry.env, PATH: GUI_PATH, HOME: homedir() },
    cwd: '/',
    stderr: 'pipe',
  });
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[]).map((c) => c.text ?? '').join('');
  return {
    isError: result.isError === true,
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
    text,
  };
}

/** The checks every connection path runs: own project only, models, rule relations, 404. */
async function exercise(client: Client): Promise<void> {
  const projects = await tool(client, 'list_projects', {});
  expect((projects.data['items'] as { key: string }[]).map((p) => p.key)).toEqual([PROJECT]);

  const models = await tool(client, 'list_processes', { projectId: PROJECT, limit: 200 });
  const items = models.data['items'] as { modelKey: string; processes: { ref: string }[] }[];
  expect(items).toHaveLength(expected?.models ?? -1);

  const accepted = await tool(client, 'get_relations', {
    projectId: PROJECT,
    status: 'accepted',
    limit: 200,
  });
  const relations = accepted.data['items'] as { type: string; tier: string }[];
  expect(relations).toHaveLength(expected?.rules.accepted ?? -1);
  expect(new Set(relations.map((r) => `${r.type}/${r.tier}`))).toEqual(new Set(['call/rule']));

  const ref = items.find((m) => m.processes.length > 0)?.processes[0]?.ref;
  const process = await tool(client, 'get_process', { projectId: PROJECT, ref });
  expect(process.isError).toBe(false);
  expect((process.data['facts'] as unknown[]).length).toBeGreaterThan(0);

  const xml = await tool(client, 'get_model_xml', {
    projectId: PROJECT,
    modelKey: items[0]?.modelKey,
    maxChars: 200,
  });
  expect(xml.data['xml']).toMatch(/^<\?xml/);

  const procedure = await tool(client, 'get_procedure', { id: 'proa-relations' });
  expect(procedure.data['id']).toBe('proa-relations');

  const foreign = await tool(client, 'list_processes', { projectId: FOREIGN });
  expect(foreign.isError).toBe(true);
  expect(JSON.parse(foreign.text)).toMatchObject({ code: 'not-found', status: 404 });
}

describe.skipIf(!LIVE_URL)(`live ProA at ${LIVE_URL ?? '(PROA_LIVE_URL not set)'}`, () => {
  beforeAll(async () => {
    token = await createToken(PROJECT, 'live-check');
    created.push({ project: PROJECT, id: token.id });
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    for (const t of created) await proa(['token', 'revoke', '--project', t.project, t.id]);
  });

  it('serves health, the web UI and the OpenAPI document; refuses a foreign Host', async () => {
    expect(await (await fetch(`${LIVE_URL}/health`)).json()).toMatchObject({
      status: 'ok',
      db: 'ok',
    });
    const ui = await fetch(`${LIVE_URL}/projects/${PROJECT}/relations`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toMatch(/<div id="root">/);
    const doc = (await (await fetch(`${LIVE_URL}/api/v1/openapi.json`)).json()) as {
      openapi: string;
    };
    expect(doc.openapi).toBe('3.1.0');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${LIVE_URL}/health`, { headers: { host: 'proa.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('answers MCP over HTTP with the agent token (Claude Code): 2025-11-25', async () => {
    const client = await connect(http(token.secret));
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    await exercise(client);
  });

  it('answers MCP over HTTP in 2026-07-28', async () => {
    const client = new Client(
      { name: 'proa-live-modern', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    clients.push(client);
    await client.connect(http(token.secret));
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    await exercise(client);
  });

  it('runs `proa mcp` from the checkout as the Claude Desktop entry says', async () => {
    const entry = claudeDesktopServer({
      url: LIVE_URL ?? '',
      token: token.secret,
      node: process.execPath,
    });
    expect(path.isAbsolute(entry.command)).toBe(true);
    await exercise(await connect(desktop(entry)));
  });

  it.skipIf(!CONTAINER)('runs `proa mcp` in the container via docker exec', async () => {
    const entry = claudeDesktopServer({
      url: LIVE_URL ?? '',
      token: token.secret,
      node: process.execPath,
      container: CONTAINER,
    });
    expect(entry.command).toBe('docker');
    const docker = which('docker');
    if (!GUI_PATH.split(':').includes(path.dirname(docker))) {
      // macOS: without a shell PATH a GUI app cannot resolve "docker"
      // (/usr/local/bin), so the docs say to use its absolute path.
      await expect(connect(desktop(entry))).rejects.toThrow();
    }
    await exercise(await connect(desktop({ ...entry, command: docker })));
  });

  it('refuses a revoked token through the bridge with a message naming the cause', async () => {
    const revoked = await createToken(PROJECT, 'live-check-revoked');
    await proa(['token', 'revoke', '--project', PROJECT, revoked.id]);
    const entry = claudeDesktopServer({
      url: LIVE_URL ?? '',
      token: revoked.secret,
      node: process.execPath,
    });
    await expect(connect(desktop(entry))).rejects.toThrow(/rejected the agent token/);
  });
});
