/**
 * Connects the simulation agent to ProA's MCP endpoint with an agent token,
 * the two ways real clients do (CONCEPT §6): Streamable HTTP on `<url>/mcp`
 * with `Authorization: Bearer proa_at_…` (Claude Code, Cursor, …), or over
 * stdio through the `proa mcp` bridge (Claude Desktop), started as a child
 * process with `PROA_URL` and `PROA_TOKEN`.
 */
import { fileURLToPath } from 'node:url';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';

import type { McpSession, ToolOutcome } from './agent.ts';

/** `apps/cli/src/main.ts` of this checkout: `node <it> mcp` is the stdio bridge. */
export const CHECKOUT_BRIDGE = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));

export type Connection =
  | {
      kind: 'http';
      /** Server origin, e.g. `http://127.0.0.1:7400`. */
      url: string;
      token: string;
      /** For tests: the fetch the transport uses. */
      fetch?: typeof globalThis.fetch;
    }
  | {
      kind: 'stdio';
      url: string;
      token: string;
      /** The bridge's command line (default: `node <checkout>/apps/cli/src/main.ts mcp`). */
      command: string;
      args: string[];
    };

/** The client's name and version in `initialize`. */
export interface ClientInfo {
  name: string;
  version: string;
}

/** `http://127.0.0.1:7400` → `http://127.0.0.1:7400/mcp`. */
export function mcpUrl(url: string): URL {
  const base = new URL(url);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError(`the ProA URL must be http(s): ${url}`);
  }
  return new URL(`${base.pathname.replace(/\/+$/, '')}/mcp`, base);
}

/**
 * The bridge command: the checkout's `proa mcp` with this Node, or a command
 * line such as `docker exec -i -e PROA_TOKEN proa2-proa-1 proa mcp` (split
 * at whitespace; no shell, no quoting).
 */
export function bridgeCommand(commandLine?: string): { command: string; args: string[] } {
  if (commandLine === undefined)
    return { command: process.execPath, args: [CHECKOUT_BRIDGE, 'mcp'] };
  const [command, ...args] = commandLine.trim().split(/\s+/);
  if (!command) throw new TypeError('the bridge command is empty');
  return { command, args };
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: { type?: unknown; text?: unknown }) =>
      c.type === 'text' && typeof c.text === 'string' ? c.text : '',
    )
    .join('');
}

/** Opens an MCP session (initialize included). */
export async function connect(
  connection: Connection,
  info: ClientInfo,
  log: (line: string) => void = () => {},
): Promise<McpSession> {
  const client = new Client(info);
  if (connection.kind === 'http') {
    await client.connect(
      new StreamableHTTPClientTransport(mcpUrl(connection.url), {
        requestInit: { headers: { authorization: `Bearer ${connection.token}` } },
        ...(connection.fetch ? { fetch: connection.fetch } : {}),
      }),
    );
  } else {
    const transport = new StdioClientTransport({
      command: connection.command,
      args: connection.args,
      env: { ...getDefaultEnvironment(), PROA_URL: connection.url, PROA_TOKEN: connection.token },
      stderr: 'pipe',
    });
    // The bridge logs to stderr only (stdout carries the protocol).
    let pending = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      let nl;
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl).trimEnd();
        pending = pending.slice(nl + 1);
        if (line !== '') log(`bridge: ${line}`);
      }
    });
    await client.connect(transport);
  }

  return {
    async listTools() {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? undefined : { cursor });
        names.push(...page.tools.map((t) => t.name));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return names;
    },
    async callTool(name, args): Promise<ToolOutcome> {
      const result = await client.callTool({ name, arguments: args });
      return {
        isError: result.isError === true,
        data: (result.structuredContent ?? {}) as Record<string, unknown>,
        text: textOf(result.content),
      };
    },
    async getPrompt(name, args) {
      if (!client.getServerCapabilities()?.prompts) return null;
      const prompt = await client.getPrompt({ name, arguments: args });
      return prompt.messages
        .map((m) => (m.content.type === 'text' ? m.content.text : ''))
        .join('\n');
    },
    close: () => client.close(),
  };
}
