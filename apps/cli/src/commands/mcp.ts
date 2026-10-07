import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { agentToken, type CredentialOptions } from '../credentials.ts';
import { CliError } from '../errors.ts';
import type { CliIo } from '../io.ts';
import { httpUpstream, mcpEndpoint, runBridge } from '../mcp-bridge.ts';

/**
 * `proa mcp`: stdio ⇄ `<url>/mcp` with the agent token from `--token` or
 * `PROA_TOKEN` (CONCEPT §6). Runs until the client closes stdin.
 */
export async function mcpCommand(
  io: CliIo,
  opts: CredentialOptions & { url: string },
): Promise<void> {
  const token = agentToken(io, opts);
  if (!token) {
    throw new CliError(
      'proa mcp needs an agent token in PROA_TOKEN (or --token); create one with: proa token create --project <key>',
    );
  }
  let endpoint: URL;
  try {
    endpoint = mcpEndpoint(opts.url);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  await runBridge({
    downstream: new StdioServerTransport(io.stdin, io.stdoutStream),
    upstream: httpUpstream(endpoint, token, io.fetch),
    endpoint: endpoint.href,
    log: (line) => io.stderr(`${line}\n`),
  });
}
