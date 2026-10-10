import { DEFAULT_PROA_URL } from '@proa/client';
import { AGENT_TOKEN_DEFAULT_DAYS, OWNER_KEY_FILE_ENV } from '@proa/contracts';
import { Command, CommanderError } from 'commander';

import { healthCommand } from './commands/health.ts';
import { importCommand } from './commands/import.ts';
import { mcpCommand } from './commands/mcp.ts';
import {
  rulesAddCommand,
  rulesApplyCommand,
  rulesEditCommand,
  rulesListCommand,
  rulesPreviewCommand,
  rulesRevokeCommand,
  rulesShowCommand,
  rulesSwitchCommand,
  type CriteriaFlags,
} from './commands/rules.ts';
import { SEED_TOKEN_NAME, seedCommand } from './commands/seed.ts';
import { statusCommand } from './commands/status.ts';
import {
  DEFAULT_SCOPES,
  tokenCreateCommand,
  tokenListCommand,
  tokenRevokeCommand,
} from './commands/token.ts';
import {
  valueChainPullCommand,
  valueChainPushCommand,
  valueChainRequeueCommand,
} from './commands/value-chain.ts';
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
      'ProA 2.0 command line: seed and import models, push and pull the value chain, manage agent tokens and auto-accept rules, bridge MCP over stdio',
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

  const valueChain = program
    .command('value-chain')
    .description(
      'push and pull the value chain document (.vc.json) of a project, requeue its placement task',
    );
  valueChain
    .command('push')
    .description(
      'save a .vc.json file as the next revision (owner key; If-Match on --base, a dry run first)',
    )
    .argument('<file>', 'the .vc.json document')
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--key <key>', 'value chain key', 'main')
    .option(
      '--base <rev>',
      'the revision the file comes from (pull prints it); required for an existing chain',
    )
    .option('--force', 'save on the current head without --base (may overwrite newer saves)')
    .option('--dry-run', 'print what the save would do to steps and placements; save nothing')
    .option('--yes', 'save even if placements would be stranded or need re-confirmation')
    .option('--json', 'print JSON')
    .action(
      (
        file: string,
        opts: {
          project: string;
          key: string;
          base?: string;
          force?: boolean;
          dryRun?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => valueChainPushCommand(io, file, { ...globals(), ...opts }),
    );
  valueChain
    .command('pull')
    .description(
      'write the canonical .vc.json of the head (or --rev) verbatim; r<rev> <hash> on stderr',
    )
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--key <key>', 'value chain key', 'main')
    .option('--rev <rev>', 'revision number (default: the head)')
    .option('-o, --output <file>', 'write to this file (default: stdout)')
    .action((opts: { project: string; key: string; rev?: string; output?: string }) =>
      valueChainPullCommand(io, { ...globals(), ...opts }),
    );
  valueChain
    .command('requeue')
    .description(
      "queue the value chain's placement task when a process is due: after a failed task, or for what reviewers' decisions made due (owner key or a token with proa:write)",
    )
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--json', 'print JSON')
    .action((opts: { project: string; json?: boolean }) =>
      valueChainRequeueCommand(io, { ...globals(), ...opts }),
    );

  const rules = program
    .command('rules')
    .description(
      "manage a project's auto-accept rules (owner key; owner decision 19): agent proposals at or above a confidence are accepted as the owner's decision",
    );
  /** The criteria flags of add, edit and preview. */
  const criteria = (cmd: Command): Command =>
    cmd
      .option('--name <name>', 'rule name (unique in the project)')
      .option('--kind <kind>', 'relation or placement (never changes)')
      .option(
        '--tier <tier>',
        'proposal tier: key, lexical, semantic (placements: lexical, semantic)',
      )
      .option('--min <confidence>', 'minimum confidence, inclusive: 0.9 or 90% (at least 50%)')
      .option('--type <type>', 'relations only: call, message, signal or trigger (any: every type)')
      .option(
        '--agent <agent>',
        'only this agent: token id agt_…, token name or principal prn_… (any: every agent)',
      )
      .option(
        '--model <llmModel>',
        'only proposals declaring exactly this LLM model (any: every model)',
      )
      .option('--ad-hoc', 'also ad-hoc proposals (default: pipeline proposals only)')
      .option('--no-ad-hoc', 'pipeline proposals only')
      .option('--note <text>', 'a note for reviewers ("" removes it)');
  rules
    .command('list')
    .description(
      'list the rules with their head revision and what they accepted, and the system rule',
    )
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--json', 'print JSON')
    .action((opts: { project: string; json?: boolean }) =>
      rulesListCommand(io, { ...globals(), ...opts }),
    );
  rules
    .command('show')
    .description('show a rule and its immutable revisions')
    .argument('<id>', 'rule id (aar_…)')
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--json', 'print JSON')
    .action((id: string, opts: { project: string; json?: boolean }) =>
      rulesShowCommand(io, id, { ...globals(), ...opts }),
    );
  criteria(
    rules
      .command('add')
      .description(
        'create a rule (off unless --enable; never retroactive) and print its preview; needs --name, --kind, --tier, --min',
      ),
  )
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--enable', 'enable the rule right away')
    .option('--json', 'print JSON')
    .action((opts: CriteriaFlags & { project: string; enable?: boolean; json?: boolean }) =>
      rulesAddCommand(io, { ...globals(), ...opts }),
    );
  criteria(
    rules
      .command('edit')
      .description('save the flags as the next revision of a rule (If-Match on its head)')
      .argument('<id>', 'rule id (aar_…)'),
  )
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--json', 'print JSON')
    .action((id: string, opts: CriteriaFlags & { project: string; json?: boolean }) =>
      rulesEditCommand(io, id, { ...globals(), ...opts }),
    );
  for (const [name, enabled] of [
    ['enable', true],
    ['disable', false],
  ] as const) {
    rules
      .command(name)
      .description(
        enabled
          ? 'enable a rule (a new revision); reports how many open proposals already match'
          : 'disable a rule (a new revision); its acceptances stay and remain revocable',
      )
      .argument('<id>', 'rule id (aar_…)')
      .requiredOption('-p, --project <project>', 'project key or id')
      .option('--json', 'print JSON')
      .action((id: string, opts: { project: string; json?: boolean }) =>
        rulesSwitchCommand(io, id, enabled, { ...globals(), ...opts }),
      );
  }
  criteria(
    rules
      .command('preview')
      .description(
        'what a rule would have accepted so far (with the precision of the human decisions), would accept now, and the confidence curve; a saved rule (<id>, changed by flags) or an unsaved one (--kind, --tier, --min)',
      )
      .argument('[id]', 'rule id (aar_…)'),
  )
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--json', 'print JSON')
    .action((id: string | undefined, opts: CriteriaFlags & { project: string; json?: boolean }) =>
      rulesPreviewCommand(io, id, { ...globals(), ...opts }),
    );
  rules
    .command('apply')
    .description(
      "accept the open proposals a rule's head revision matches: prints the dry run; accepts only with --yes",
    )
    .argument('<id>', 'rule id (aar_…)')
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--dry-run', 'only print what would be accepted')
    .option('--yes', "accept them (the dry run's count must still hold)")
    .option('--json', 'print JSON')
    .action(
      (id: string, opts: { project: string; dryRun?: boolean; yes?: boolean; json?: boolean }) =>
        rulesApplyCommand(io, id, { ...globals(), ...opts }),
    );
  rules
    .command('revoke')
    .description(
      'revoke auto-acceptances still in force (by rule, revision, agent, kind or ids): back to review, or obsolete when no proposal remains; a human decision taken since is never touched. Prints the dry run; revokes only with --yes',
    )
    .argument('[id]', 'rule id (aar_…)')
    .requiredOption('-p, --project <project>', 'project key or id')
    .option('--revision <rev>', 'only acceptances of this revision of the rule')
    .option(
      '--agent <agent>',
      'only acceptances triggered by this agent (token id, name or principal)',
    )
    .option('--kind <kind>', 'relation or placement')
    .option('--ids <id...>', 'relation or placement ids (rel_…, plc_…; also comma-separated)')
    .option('--reason <text>', 'added to the revocation in the history')
    .option('--dry-run', 'only print what would be revoked')
    .option('--yes', "revoke them (the dry run's count must still hold)")
    .option('--json', 'print JSON')
    .action(
      (
        id: string | undefined,
        opts: {
          project: string;
          revision?: string;
          agent?: string;
          kind?: string;
          ids?: string[];
          reason?: string;
          dryRun?: boolean;
          yes?: boolean;
          json?: boolean;
        },
      ) => rulesRevokeCommand(io, id, { ...globals(), ...opts }),
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
      'create one project per eval landscape and import its models (default: every scored landscape); --value-chains also creates its golden value chain',
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
    .option(
      '--value-chains',
      "also create each landscape's golden value chain from eval/value-chains, without placements (an existing chain is never overwritten)",
    )
    .option(
      '--value-chains-dir <dir>',
      'golden value chains directory (default: eval/value-chains of this checkout)',
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
          valueChains?: boolean;
          valueChainsDir?: string;
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
