import os from 'node:os';
import type { Readable, Writable } from 'node:stream';

/** Process boundary of the CLI, replaceable in tests. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  fetch: typeof globalThis.fetch;
  /** Directory relative paths are resolved against. */
  cwd: string;
  /** The OS user's home directory (default owner key location). */
  home: string;
  /** Raw streams for `proa mcp` (JSON-RPC over stdio). */
  stdin: Readable;
  stdoutStream: Writable;
}

/**
 * The invoking directory: under `pnpm proa …`/`pnpm seed` the package
 * manager runs the script in the package directory and passes the user's
 * directory as `INIT_CWD`.
 */
function invocationDir(env: NodeJS.ProcessEnv): string {
  return env['npm_lifecycle_event'] && env['INIT_CWD'] ? env['INIT_CWD'] : process.cwd();
}

export const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
  fetch: globalThis.fetch,
  cwd: invocationDir(process.env),
  home: os.homedir(),
  stdin: process.stdin,
  stdoutStream: process.stdout,
};
