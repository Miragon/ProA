/**
 * End to end: a real ProA server (child process, real libraries, PostgreSQL
 * 17) driven by the CLI — `proa seed`, `import`, `token`, `status` — and
 * `proa mcp` spawned as a child process the way Claude Desktop starts it,
 * spoken to over stdio with the official SDK client (initialize, tools/list,
 * tools/call list_processes) in the 2025-11-25 and the 2026-07-28 revision,
 * and `proa value-chain push|pull` with the golden dev chain.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Status } from '../../src/commands/status.ts';
import type { CliIo } from '../../src/io.ts';
import { CLI_MAIN } from '../../src/mcp-config.ts';
import { runCli } from '../../src/program.ts';
import { tempDir } from '../support/io.ts';
import { REPO_ROOT, cleanEnv, createDatabase, startServer, type RunningServer } from './server.ts';

interface ReportCounts {
  name: string;
  counts: { models: number; rules: { accepted: number; proposed: number } };
  findings: { kind: string; computed: string[] }[];
}

let db: { url: string; drop: () => Promise<void> };
let dir: string;
let keyFile: string;
let server: RunningServer;
let report: ReportCounts[];
let agentSecret: string;
const clients: Client[] = [];

beforeAll(async () => {
  dir = await tempDir('proa-e2e-');
  keyFile = path.join(dir, 'state', 'proa', 'owner-key');
  db = await createDatabase();
  server = await startServer({ databaseUrl: db.url, ownerKeyFile: keyFile });
  const json = await readFile(path.join(REPO_ROOT, 'eval/reports/candidates.json'), 'utf8');
  report = (JSON.parse(json) as { landscapes: ReportCounts[] }).landscapes;
});

afterAll(async () => {
  for (const c of clients) await c.close().catch(() => {});
  await server?.stop();
  await db?.drop();
  await rm(dir, { recursive: true, force: true });
});

/** Runs the CLI in-process against the server with real fetch. */
async function proa(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    env: { PROA_URL: server.url, PROA_OWNER_KEY_FILE: keyFile, ...env },
    fetch: globalThis.fetch,
    cwd: dir,
    home: dir,
    stdin: new PassThrough(),
    stdoutStream: new PassThrough(),
  };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join('') };
}

async function status(env: Record<string, string> = {}): Promise<Status> {
  const r = await proa(['status', '--json'], env);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  return JSON.parse(r.out) as Status;
}

describe('the server', () => {
  it('created the owner key file on first start, readable only by its user', async () => {
    expect(server.output()).toContain(`owner key: ${keyFile} (created`);
    expect(server.output()).not.toMatch(/proa_ok_/);
    const key = (await readFile(keyFile, 'utf8')).trim();
    expect(key).toMatch(/^proa_ok_/);
  });

  it('answers proa health', async () => {
    const r = await proa(['health']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ status: 'ok', db: 'ok' });
  });
});

describe('proa seed', () => {
  it('creates both scored landscapes with the counts of eval:candidates', async () => {
    const r = await proa(['seed']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('nordwind-handel (Nordwind Handel GmbH): project created');
    expect(r.out).toContain('stadtwerke-auental (Stadtwerke Auental): project created');

    const s = await status();
    expect(s.me).toMatchObject({ handle: 'owner', clientId: 'proa-cli' });
    expect(s.projects.map((p) => p.key)).toEqual(['nordwind-handel', 'stadtwerke-auental']);
    for (const p of s.projects) {
      const expected = report.find((l) => l.name === p.key);
      expect(expected, p.key).toBeDefined();
      expect(p.models).toBe(expected?.counts.models);
      expect(p.stages).toEqual({ waiting_for_agent: expected?.counts.models });
      expect(p.relations).toEqual({
        accepted: expected?.counts.rules.accepted,
        proposed: expected?.counts.rules.proposed,
      });
      expect(p.endpointIssues).toBe(0);
      // One finding per computed entry (per ref; duplicate ids per group).
      for (const f of expected?.findings ?? []) {
        expect(p.findings[f.kind] ?? 0, `${p.key} ${f.kind}`).toBe(f.computed.length);
      }
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    const before = await status();
    const r = await proa(['seed', '--json']);
    expect(r.code).toBe(0);
    const results = JSON.parse(r.out) as {
      created: boolean;
      import: { counts: { created: number; revised: number; unchanged: number; failed: number } };
    }[];
    for (const x of results) {
      expect(x.created).toBe(false);
      expect(x.import.counts.created + x.import.counts.revised + x.import.counts.failed).toBe(0);
    }
    expect((await status()).projects.map((p) => p.seq)).toEqual(before.projects.map((p) => p.seq));
  });

  it('--project seeds a fresh project per live run; its token carries --token-name', async () => {
    const r = await proa([
      'seed',
      '_sample',
      '--project',
      'sample-run-1',
      '--issue-tokens',
      '--token-name',
      'claude-code-1',
      '--json',
    ]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const [result] = JSON.parse(r.out) as [{ token: { secret: string } }];
    expect(result).toMatchObject({
      project: 'sample-run-1',
      landscape: 'sample',
      name: 'sample (sample-run-1)',
      created: true,
      models: 3,
      token: { name: 'claude-code-1' },
    });
    // The token's handle is what eval:live records as the agent.
    const asAgent = await status({ PROA_TOKEN: result.token.secret });
    expect(asAgent.me).toMatchObject({ kind: 'service', handle: 'agent:claude-code-1' });
    expect(asAgent.projects.map((p) => p.key)).toEqual(['sample-run-1']);

    // A second run under the same key is refused before anything changes.
    const before = (await status()).projects.find((p) => p.key === 'sample-run-1');
    const again = await proa([
      'seed',
      'nordwind-handel',
      '--project',
      'sample-run-1',
      '--issue-tokens',
    ]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('project sample-run-1 already exists');
    const after = (await status()).projects.find((p) => p.key === 'sample-run-1');
    expect(after).toMatchObject({ models: 3, seq: before?.seq });
    const tokens = await proa(['token', 'list', '-p', 'sample-run-1', '--json']);
    expect((JSON.parse(tokens.out) as unknown[]).length).toBe(1);
  });
});

describe('proa import', () => {
  it('revises a changed model and the rule tier follows', async () => {
    const original = await readFile(
      path.join(REPO_ROOT, 'eval/corpus/nordwind-handel/models/finanzen/gutschrift.bpmn'),
      'utf8',
    );
    const changed = path.join(dir, 'changed');
    await mkdir(path.join(changed, 'finanzen'), { recursive: true });
    await writeFile(
      path.join(changed, 'finanzen', 'gutschrift.bpmn'),
      original.replace(
        'calledElement="Process_Briefversand"',
        'calledElement="Process_Briefdienst"',
      ),
    );
    const r = await proa(['import', 'changed', '--project', 'nordwind-handel']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('  revised   finanzen/gutschrift\n');
    const nordwind = (await status()).projects.find((p) => p.key === 'nordwind-handel');
    expect(nordwind?.relations['accepted']).toBe(8);
    expect(nordwind?.findings['unresolved-call']).toBe(3);

    await writeFile(path.join(changed, 'finanzen', 'gutschrift.bpmn'), original);
    expect((await proa(['import', 'changed', '-p', 'nordwind-handel'])).code).toBe(0);
    const restored = (await status()).projects.find((p) => p.key === 'nordwind-handel');
    expect(restored?.relations['accepted']).toBe(9);
  });
});

describe('agent tokens and the MCP bridge', () => {
  it('proa token create issues a token that sees exactly its project', async () => {
    const r = await proa([
      'token',
      'create',
      '--project',
      'nordwind-handel',
      '--name',
      'e2e',
      '--scopes',
      'proa:read',
      '--expires',
      '7d',
      '--json',
    ]);
    expect(r.code).toBe(0);
    const token = JSON.parse(r.out) as { secret: string; scopes: string[] };
    expect(token.scopes).toEqual(['proa:read']);
    agentSecret = token.secret;

    const asAgent = await status({ PROA_TOKEN: agentSecret });
    expect(asAgent.me).toMatchObject({ kind: 'service' });
    expect(asAgent.projects.map((p) => p.key)).toEqual(['nordwind-handel']);
  });

  function bridge(token: string): StdioClientTransport {
    return new StdioClientTransport({
      command: process.execPath,
      args: [CLI_MAIN, 'mcp'],
      env: cleanEnv({ PROA_URL: server.url, PROA_TOKEN: token }),
      stderr: 'pipe',
    });
  }

  it('speaks 2025-11-25 over stdio (Claude Desktop): initialize, tools/list, list_processes', async () => {
    const client = new Client({ name: 'claude-desktop-e2e', version: '0' });
    clients.push(client);
    await client.connect(bridge(agentSecret));
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
    expect(client.getServerVersion()).toMatchObject({ name: 'proa' });
    expect(client.getInstructions()).toMatch(/only propose/);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['list_projects', 'list_processes', 'get_process', 'get_model_xml']),
    );
    const result = await client.callTool({
      name: 'list_processes',
      arguments: { projectId: 'nordwind-handel', limit: 200 },
    });
    expect(result.isError).not.toBe(true);
    const { items } = result.structuredContent as { items: { modelKey: string }[] };
    expect(items).toHaveLength(31);
    expect(items.map((i) => i.modelKey)).toContain('finanzen/gutschrift');

    const other = await client.callTool({
      name: 'list_processes',
      arguments: { projectId: 'stadtwerke-auental' },
    });
    expect(other.isError).toBe(true);
    await client.close();
  });

  it('speaks 2026-07-28 through the same bridge (version negotiation)', async () => {
    const client = new Client(
      { name: 'modern-e2e', version: '0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    clients.push(client);
    await client.connect(bridge(agentSecret));
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getProtocolEra()).not.toBe('legacy');
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(8);
    const result = await client.callTool({ name: 'list_projects', arguments: {} });
    expect(JSON.stringify(result.structuredContent)).toContain('nordwind-handel');
    await client.close();
  });

  it('reports a revoked token to the MCP client instead of hanging', async () => {
    const list = await proa(['token', 'list', '-p', 'nordwind-handel', '--json']);
    const [token] = JSON.parse(list.out) as { id: string }[];
    expect((await proa(['token', 'revoke', token?.id ?? '', '-p', 'nordwind-handel'])).code).toBe(
      0,
    );

    const client = new Client({ name: 'revoked-e2e', version: '0' });
    clients.push(client);
    await expect(client.connect(bridge(agentSecret))).rejects.toThrow(/rejected the agent token/);
  });
});

describe('proa value-chain', () => {
  const golden = path.join(REPO_ROOT, 'eval/value-chains/nordwind-handel/value-chain.vc.json');

  it('pushes the golden dev chain (r1), finds it unchanged and pulls it back byte for byte', async () => {
    const created = await proa(['value-chain', 'push', golden, '-p', 'nordwind-handel', '--json']);
    expect(created.err).toBe('');
    expect(created.code).toBe(0);
    expect(JSON.parse(created.out)).toMatchObject({
      dryRun: false,
      outcome: 'created',
      valueChain: { key: 'main', headRev: 1 },
    });

    const again = await proa(['value-chain', 'push', golden, '-p', 'nordwind-handel']);
    expect(again.code).toBe(0);
    expect(again.out).toBe('nordwind-handel: value chain unchanged r1\n');

    const token = await proa([
      'token',
      'create',
      '-p',
      'nordwind-handel',
      '--name',
      'e2e-chain',
      '--scopes',
      'proa:read',
      '--json',
    ]);
    const { secret } = JSON.parse(token.out) as { secret: string };
    const out = path.join(dir, 'pulled.vc.json');
    const pulled = await proa(['value-chain', 'pull', '-p', 'nordwind-handel', '-o', out], {
      PROA_TOKEN: secret,
    });
    expect(pulled.code).toBe(0);
    expect(pulled.err).toMatch(/^r1 [0-9a-f]{64}\n$/);
    expect(await readFile(out)).toEqual(await readFile(golden));

    // Agents never edit the chain: the CLI refuses an agent token before any request.
    const refused = await proa(['value-chain', 'push', golden, '-p', 'nordwind-handel'], {
      PROA_TOKEN: secret,
    });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('agents never edit the value chain');

    // An edit of the pulled file saves only on the revision it came from (--base r1).
    const edited = path.join(dir, 'edited.vc.json');
    const doc = JSON.parse(await readFile(out, 'utf8')) as { meta: { name: string } };
    await writeFile(edited, JSON.stringify({ ...doc, meta: { name: `${doc.meta.name} (2)` } }));
    const unbased = await proa(['value-chain', 'push', edited, '-p', 'nordwind-handel']);
    expect(unbased.code).toBe(1);
    expect(unbased.err).toContain('pass --base with the revision your file comes from');
    const based = await proa([
      'value-chain',
      'push',
      edited,
      '-p',
      'nordwind-handel',
      '--base',
      'r1',
    ]);
    expect(based.err).toBe('');
    expect(based.code).toBe(0);
    expect(based.out).toContain('nordwind-handel: value chain revised r2 (from r1)');
    const stale = await proa([
      'value-chain',
      'push',
      golden,
      '-p',
      'nordwind-handel',
      '--base',
      'r1',
    ]);
    expect(stale.code).toBe(1);
    expect(stale.err).toContain('the value chain is at r2; pull first');
  });
});
