/**
 * How the CLI authenticates (local mode, CONCEPT §6; docs/proa-2/DEVELOPMENT.md):
 *
 * - **Owner key** (`proa_ok_…`): the server creates it on its first start in a
 *   file only its OS user can read (default `~/.local/state/proa/owner-key`,
 *   `PROA_OWNER_KEY_FILE` to override). The CLI reads that file and acts as
 *   the owner on the interactive client `proa-cli`: create projects, import,
 *   issue agent tokens. The key never travels in arguments or environment
 *   variables, and the CLI refuses a file that others can read.
 * - **Agent token** (`proa_at_…`, `--token` or `PROA_TOKEN`): a project-bound
 *   credential for `proa mcp`, and for `import`/`status` when given.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  AGENT_TOKEN_PREFIX,
  OWNER_KEY_FILE_ENV,
  OWNER_KEY_PATTERN,
  OWNER_KEY_PREFIX,
  defaultOwnerKeyFile,
} from '@proa/contracts';

import { CliError } from './errors.ts';
import type { CliIo } from './io.ts';

export type Credential =
  { kind: 'owner-key'; secret: string; file: string } | { kind: 'agent-token'; secret: string };

export interface CredentialOptions {
  /** `--token` (else `PROA_TOKEN`). */
  token?: string | undefined;
  /** `--owner-key-file` (else `PROA_OWNER_KEY_FILE`, else the XDG default). */
  ownerKeyFile?: string | undefined;
}

/** True if `--owner-key-file` or `PROA_OWNER_KEY_FILE` names the owner key file (else: the default location). */
export function isExplicitOwnerKeyFile(io: CliIo, opts: CredentialOptions): boolean {
  return Boolean(opts.ownerKeyFile ?? io.env[OWNER_KEY_FILE_ENV]);
}

/** The owner key file this invocation uses. */
export function ownerKeyFile(io: CliIo, opts: CredentialOptions): string {
  const explicit = opts.ownerKeyFile ?? io.env[OWNER_KEY_FILE_ENV];
  if (explicit) return path.resolve(io.cwd, explicit);
  return defaultOwnerKeyFile(io.env, io.home);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

/**
 * Reads the owner key: a regular file of this OS user that group and others
 * cannot access (POSIX), holding one `proa_ok_…` key.
 *
 * @throws {CliError} with a hint how to get or fix the file
 */
export async function readOwnerKey(file: string): Promise<string> {
  let info;
  try {
    info = await stat(file);
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') throw err;
    throw new CliError(
      [
        `no owner key at ${file}.`,
        'The ProA server creates it on its first start on this machine (local mode).',
        'ProA in Docker: run the command in the container, e.g.',
        '  docker compose -p proa2 -f docker/compose.yaml exec proa proa <command>',
        `or copy the key and set ${OWNER_KEY_FILE_ENV} (see docs/proa-2/DEVELOPMENT.md).`,
      ].join('\n'),
    );
  }
  if (!info.isFile()) throw new CliError(`owner key ${file} is not a regular file`);
  if (process.platform !== 'win32') {
    const uid = process.getuid?.();
    if (uid !== undefined && info.uid !== uid) {
      throw new CliError(`owner key ${file} belongs to another OS user (uid ${info.uid})`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new CliError(
        `owner key ${file} is accessible by group or others (mode ${(info.mode & 0o777).toString(8)}); run: chmod 600 ${file}`,
      );
    }
  }
  const key = (await readFile(file, 'utf8')).trim();
  if (!OWNER_KEY_PATTERN.test(key)) throw new CliError(`${file} does not hold a ProA owner key`);
  return key;
}

/** The agent token from `--token`/`PROA_TOKEN`, if any (validated by prefix). */
export function agentToken(io: CliIo, opts: CredentialOptions): string | undefined {
  const token = opts.token ?? io.env['PROA_TOKEN'];
  if (token === undefined || token === '') return undefined;
  if (token.startsWith(OWNER_KEY_PREFIX)) {
    throw new CliError(
      'that is the owner key, not an agent token; never pass it as --token/PROA_TOKEN',
    );
  }
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) {
    throw new CliError(`an agent token starts with ${AGENT_TOKEN_PREFIX}`);
  }
  return token;
}

/** The owner's credential (owner-only commands: seed, token). */
export async function ownerCredential(io: CliIo, opts: CredentialOptions): Promise<Credential> {
  const file = ownerKeyFile(io, opts);
  return { kind: 'owner-key', secret: await readOwnerKey(file), file };
}

/** An agent token if one is given, else the owner key (import, status). */
export async function anyCredential(io: CliIo, opts: CredentialOptions): Promise<Credential> {
  const token = agentToken(io, opts);
  return token ? { kind: 'agent-token', secret: token } : ownerCredential(io, opts);
}

/** One line naming the credential, never its secret. */
export function describeCredential(c: Credential): string {
  return c.kind === 'owner-key'
    ? `owner key ${c.file}`
    : `agent token ${c.secret.slice(0, AGENT_TOKEN_PREFIX.length + 8)}…`;
}
