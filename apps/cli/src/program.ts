import { DEFAULT_PROA_URL } from '@proa/client';
import { AGENT_TOKEN_DEFAULT_DAYS, OWNER_KEY_FILE_ENV } from '@proa/contracts';
import { Command, CommanderError } from 'commander';

import { healthCommand } from './commands/health.ts';
import { importCommand } from './commands/import.ts';
import { mcpCommand } from './commands/mcp.ts';
import { SEED_TOKEN_NAME, seedCommand } from './commands/seed.ts';
import { statusCommand } from './commands/status.ts';
import {
  DEFAULT_SCOPES,
  tokenCreateCommand,
  tokenListCommand,
  tokenRevokeCommand,
} from './commands/token.ts';
import type { CredentialOptions } from './credentials.ts';
import { CliError } from './errors.ts';
import { processIo, type CliIo } from './io.ts';
import rootPackage from '../../../package.json' with { type: 'json' };

interface GlobalOptions {
  url?: string;
  token?: string;
  ownerKeyFile?: string;
}

/**
 * Builds the `proa` command tree. Global options: `--url` (`PROA_URL`,
 * default http://127.0.0.1:7400), `--token` (`PROA_TOKEN`, an agent token)
 * and `--owner-key-file` (`PROA_OWNER_KEY_FILE`).
 */
export function buildProgram(io: CliIo = processIo): Command {
  const program = new Command('proa')
    .description(
      'ProA 2.0 command line: seed and import models, manage agent tokens, bridge MCP over stdio',
    )
    .version(rootPackage.version, '-v, --version')
    .option('--url <url>', `ProA server URL (env PROA_URL, default ${DEFAULT_PROA_URL})`)
    .option('--token <token>', 'agent token proa_at_… (env PROA_TOKEN)')
    .option(
      '--owner-key-file <file>',
      `local owner key file (env ${OWNER_KEY_FILE_ENV}, default ~/.local/state/proa/owner-key)`,
    )
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr })
    .showHelpAfterError()
    .exitOverride();

  /** Global options with environment fallbacks (read from `io.env`, so tests control them). */
  const globals = (): CredentialOptions & { url: string } => {
    const o = program.opts<GlobalOptions>();
    return {
      url: (o.url ?? io.env['PROA_URL'] ?? DEFAULT_PROA_URL).replace(/\/+$/, ''),
      token: o.token,
      ownerKeyFile: o.ownerKeyFile,
    };
  };

  program
    .command('health')
    .description('check that the server and its database are up')
    .action(() => healthCommand(io, globals()));

  program
    .command('status')
    .description('server health and, per project, models by stage, relations and findings')
    .option('-p, --project <project>', 'only this project (key or id)')
    .option('--json', 'print JSON')
    .action((opts: { project?: string; json?: boolean }) =>
      statusCommand(io, { ...globals(), ...opts }),
    );

  program
    .command('import')
    .description('import every BPMN file below <dir> into a project (model key = path)')
    .argument('<dir>', 'directory with .bpmn files')
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--create', 'create the project if it does not exist (owner key)')
    .option('--name <name>', 'project name for --create (default: the key)')
    .option('--json', 'print JSON')
    .action(
      (dir: string, opts: { project: string; create?: boolean; name?: string; json?: boolean }) =>
        importCommand(io, dir, { ...globals(), ...opts }),
    );

  const token = program.command('token').description('manage agent tokens (owner key)');
  token
    .command('create')
    .description('create an agent token; prints its secret once plus MCP client configurations')
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('-n, --name <name>', 'token name', 'agent')
    .option(
      '-s, --scopes <scope...>',
      'scopes: proa:read, proa:propose, proa:write (also "read,propose")',
      [...DEFAULT_SCOPES],
    )
    .option(
      '-e, --expires <duration>',
      'expiry, e.g. 90d or 12w (≤ 365 days)',
      `${AGENT_TOKEN_DEFAULT_DAYS}d`,
    )
    .option('--json', 'print the token as JSON')
    .action(
      (opts: {
        project: string;
        name: string;
        scopes: string[];
        expires: string;
        json?: boolean;
      }) => tokenCreateCommand(io, { ...globals(), ...opts }),
    );
  token
    .command('list')
    .description("list a project's agent tokens (never their secrets)")
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--json', 'print JSON')
    .action((opts: { project: string; json?: boolean }) =>
      tokenListCommand(io, { ...globals(), ...opts }),
    );
  token
    .command('revoke')
    .description('revoke an agent token')
    .argument('<id>', 'token id (agt_…)')
    .requiredOption('-p, --project <project>', 'project key or id')
    .action((id: string, opts: { project: string }) =>
      tokenRevokeCommand(io, id, { ...globals(), ...opts }),
    );

  program
    .command('mcp')
    .description(
      'MCP stdio bridge to <url>/mcp with PROA_TOKEN (for Claude Desktop and other stdio-only clients)',
    )
    .action(() => mcpCommand(io, globals()));

  program
    .command('seed')
    .description(
      'create one project per eval landscape and import its models (default: every scored landscape)',
    )
    .argument('[landscape...]', 'landscape names, e.g. nordwind-handel stadtwerke-auental')
    .option('--corpus <dir>', 'corpus directory (default: eval/corpus of this checkout)')
    .option(
      '-p, --project <key>',
      'seed exactly one landscape into a new project with this key, named "<landscape name> (<key>)" (a fresh project per live run; an existing one is refused)',
    )
    .option('--issue-tokens', 'also create a read+propose agent token per project')
    .option(
      '--token-name <name>',
      `name of the tokens --issue-tokens creates (default ${SEED_TOKEN_NAME}); eval:live records under it`,
    )
    .option('--verbose', 'list every imported file')
    .option('--json', 'print JSON')
    .action(
      (
        landscapes: string[],
        opts: {
          corpus?: string;
          project?: string;
          issueTokens?: boolean;
          tokenName?: string;
          verbose?: boolean;
          json?: boolean;
        },
      ) => seedCommand(io, landscapes, { ...globals(), ...opts }),
    );

  return program;
}

/** Runs the CLI and returns the process exit code; never throws. */
export async function runCli(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  const program = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) return err.exitCode;
    if (err instanceof CliError) {
      io.stderr(`proa: ${err.message}\n`);
      return err.exitCode;
    }
    io.stderr(`proa: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
