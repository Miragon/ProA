import { createProaClient, getHealth } from '@proa/client';

import { CliError } from '../errors.ts';
import type { CliIo } from '../io.ts';

/** `proa health`: prints the server's health as JSON; fails unless it is `ok`. */
export async function healthCommand(io: CliIo, opts: { url: string }): Promise<void> {
  const client = createProaClient({ baseUrl: opts.url, fetch: io.fetch });
  // hey-api reports network failures as `error` without a `response`.
  const result = await getHealth({ client }).catch((err: unknown) => ({
    data: undefined,
    error: err,
    response: undefined,
  }));
  if (!result.response) {
    const reason = result.error instanceof Error ? result.error.message : String(result.error);
    throw new CliError(`cannot reach ProA at ${opts.url}: ${reason}`);
  }
  io.stdout(`${JSON.stringify(result.data ?? result.error, null, 2)}\n`);
  if (result.data?.status !== 'ok') {
    throw new CliError(`ProA at ${opts.url} is not healthy (HTTP ${result.response.status})`);
  }
}
