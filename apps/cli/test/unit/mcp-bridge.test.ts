/**
 * The stdio bridge against an in-memory MCP endpoint: the SDK's
 * `createMcpHandler` served through the bridge's fetch, the client side a
 * real `StdioServerTransport` over in-memory streams.
 */
import { PassThrough } from 'node:stream';

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { httpUpstream, mcpEndpoint, runBridge } from '../../src/mcp-bridge.ts';
import { runCli } from '../../src/program.ts';
import { AGENT_TOKEN, OWNER_KEY, testIo } from '../support/io.ts';

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'fake-proa', version: '1.2.3' });
  server.registerTool('ping', { description: 'answers pong' }, () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  return server;
});

interface Seen {
  authorization: string | null;
  protocolVersion: string | null;
  method: string;
}

/** fetch → the in-memory MCP handler; 401 without the expected bearer. */
function mcpFetch(seen: Seen[], expectedToken = AGENT_TOKEN): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({
      authorization: req.headers.get('authorization'),
      protocolVersion: req.headers.get('mcp-protocol-version'),
      method: req.method,
    });
    if (req.headers.get('authorization') !== `Bearer ${expectedToken}`) {
      const body = { code: 'unauthorized', detail: 'invalid, expired or revoked agent token' };
      return new Response(JSON.stringify(body), {
        status: 401,
        headers: { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer' },
      });
    }
    return handler.fetch(req);
  };
}

/** A JSON-RPC client over the bridge's stdin/stdout streams. */
function rpcClient() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const responses = new Map<number, (m: Record<string, unknown>) => void>();
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (typeof msg['id'] === 'number') responses.get(msg['id'])?.(msg);
    }
  });
  let nextId = 1;
  return {
    stdin,
    stdout,
    request(method: string, params: Record<string, unknown> = {}) {
      const id = nextId++;
      const answer = new Promise<Record<string, unknown>>((resolve) => responses.set(id, resolve));
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return answer;
    },
    notify(method: string) {
      stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    close() {
      stdin.end();
    },
  };
}

const INITIALIZE = {
  protocolVersion: '2025-11-25',
  capabilities: {},
  clientInfo: { name: 'claude-desktop-like', version: '0' },
};

const running: Promise<void>[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0));
});

function bridge(fetchImpl: typeof globalThis.fetch, logs: string[] = []) {
  const client = rpcClient();
  const endpoint = mcpEndpoint('http://127.0.0.1:7400');
  running.push(
    runBridge({
      downstream: new StdioServerTransport(client.stdin, client.stdout),
      upstream: httpUpstream(endpoint, AGENT_TOKEN, fetchImpl),
      endpoint: endpoint.href,
      log: (l) => logs.push(l),
    }),
  );
  return client;
}

describe('proa mcp bridge', () => {
  it('relays a 2025-11-25 session: initialize, tools/list, tools/call', async () => {
    const seen: Seen[] = [];
    const client = bridge(mcpFetch(seen));

    const init = await client.request('initialize', INITIALIZE);
    expect(init['result']).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'fake-proa', version: '1.2.3' },
    });
    client.notify('notifications/initialized');
    const list = await client.request('tools/list');
    expect(list['result']).toMatchObject({ tools: [{ name: 'ping' }] });
    const call = await client.request('tools/call', { name: 'ping', arguments: {} });
    expect(call['result']).toMatchObject({ content: [{ type: 'text', text: 'pong' }] });
    client.close();
    await Promise.all(running.splice(0));

    // Every POST carries the agent token; after initialize, the negotiated version.
    const posts = seen.filter((s) => s.method === 'POST');
    expect(posts.every((s) => s.authorization === `Bearer ${AGENT_TOKEN}`)).toBe(true);
    expect(posts[0]?.protocolVersion).toBeNull();
    expect(posts.slice(1).every((s) => s.protocolVersion === '2025-11-25')).toBe(true);
  });

  it('answers requests with a JSON-RPC error when ProA rejects the token', async () => {
    const logs: string[] = [];
    const client = bridge(mcpFetch([], 'proa_at_other'), logs);
    const init = await client.request('initialize', INITIALIZE);
    client.close();
    expect(init['error']).toEqual({
      code: -32603,
      message:
        'ProA at http://127.0.0.1:7400/mcp rejected the agent token (401: invalid, expired or revoked agent token); check PROA_TOKEN',
    });
  });

  it('answers requests with a JSON-RPC error when ProA is unreachable', async () => {
    const logs: string[] = [];
    const client = bridge(() => Promise.reject(new TypeError('fetch failed')), logs);
    const res = await client.request('tools/list');
    client.notify('notifications/initialized');
    client.close();
    expect(res['error']).toMatchObject({
      message: 'cannot reach ProA at http://127.0.0.1:7400/mcp: fetch failed',
    });
    await Promise.all(running.splice(0));
    expect(logs.join('\n')).toContain('dropped a notification');
  });

  it('builds the endpoint from PROA_URL', () => {
    expect(mcpEndpoint('http://127.0.0.1:7400').href).toBe('http://127.0.0.1:7400/mcp');
    expect(mcpEndpoint('https://proa.example/base/').href).toBe('https://proa.example/base/mcp');
    expect(() => mcpEndpoint('ftp://x')).toThrow(/http/);
  });
});

describe('proa mcp command', () => {
  it('needs an agent token, never the owner key', async () => {
    const none = testIo();
    expect(await runCli(['mcp'], none.io)).toBe(1);
    expect(none.err()).toContain('needs an agent token in PROA_TOKEN');

    const owner = testIo({ PROA_TOKEN: OWNER_KEY });
    expect(await runCli(['mcp'], owner.io)).toBe(1);
    expect(owner.err()).toContain('owner key');
  });

  it('runs until stdin ends and writes only protocol messages to stdout', async () => {
    const seen: Seen[] = [];
    const stdin = new PassThrough();
    const stdoutStream = new PassThrough();
    const written: string[] = [];
    stdoutStream.on('data', (c: Buffer) => written.push(c.toString('utf8')));
    const t = testIo({ PROA_TOKEN: AGENT_TOKEN }, mcpFetch(seen), { stdin, stdoutStream });
    const done = runCli(['mcp'], t.io);
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE })}\n`,
    );
    await new Promise((r) => setTimeout(r, 50));
    stdin.end();
    expect(await done).toBe(0);
    expect(t.out()).toBe('');
    expect(t.err()).toContain('bridging stdio to http://127.0.0.1:7400/mcp');
    const lines = written.join('').trim().split('\n');
    expect(lines.map((l) => (JSON.parse(l) as { id: number }).id)).toEqual([1]);
  });
});
