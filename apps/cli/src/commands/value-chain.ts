/**
 * `proa value-chain push|pull` (M4 §3.5, S2): the value chain document
 * (`.vc.json`) between a file and the server.
 *
 * - **push** saves a document as the next revision, as the owner only (agents
 *   never edit the chain, so an agent token is refused before any request).
 *   `If-Match` names the revision the file comes from (M4 §3.5): `--base`,
 *   the `r<rev>` that pull printed. Without it push would save over whatever
 *   the head is now and silently revert a save made since the pull, so for an
 *   existing chain it refuses to save without `--base`, unless `--force`
 *   says to save on the current head (read with `GET …/content`, ETag
 *   `"r<rev>"`). A project without a chain is created with
 *   `If-None-Match: *`. A dry run comes first (on `--base`, else on the
 *   current head): content equal to the head is `unchanged` whatever the
 *   base; when the save would strand accepted or held placements on removed
 *   steps or send accepted ones to re-confirm, push stops unless `--yes` is
 *   given; `--dry-run` only prints the impact.
 * - **pull** writes the canonical bytes of the head (or `--rev`) verbatim, with
 *   any credential, and prints `r<rev> <content hash>` on stderr.
 * - **requeue** queues the chain's placement task (M4 §3.2, `POST
 *   …/analyses/requeue {valueChain: true}`) when an open process is due:
 *   after a failed task, or for processes human decisions made due (they
 *   never queue a task themselves). Judge each process once: nothing is
 *   queued while every open process has a verdict on its current input.
 */
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  getValueChainContent,
  getValueChainRevisionContent,
  putValueChainContent,
  requeueAnalyses,
  type SaveValueChainResult,
  type ValueChainImpact,
} from '@proa/client';
import {
  MAX_VALUE_CHAIN_BODY_BYTES,
  VALUE_CHAIN_KEY,
  type ValueChainViolation,
} from '@proa/contracts';

import { call, callWithResponse, createApi, type Api } from '../api.ts';
import {
  agentToken,
  anyCredential,
  ownerCredential,
  type CredentialOptions,
} from '../credentials.ts';
import { ApiError, CliError } from '../errors.ts';
import type { CliIo } from '../io.ts';

export interface ValueChainOptions extends CredentialOptions {
  url: string;
  project: string;
  /** The chain's key (M4: `main`). */
  key?: string;
}

export interface PushOptions extends ValueChainOptions {
  /** The revision the file comes from (`3` or `r3`, as pull prints it): save only if it is still the head. */
  base?: string;
  /** Save on the current head without `--base` (may overwrite a save made since the pull). */
  force?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

export interface RequeueOptions extends CredentialOptions {
  url: string;
  project: string;
  json?: boolean;
}

export interface PullOptions extends ValueChainOptions {
  /** A revision number (`3` or `r3`); default: the head. */
  rev?: string;
  /** Output file; default stdout. */
  output?: string;
}

/** `"r3"` (also weak) → 3. */
export function revisionOfEtag(etag: string | null): number | null {
  const m = /^\s*(?:W\/)?"r([1-9]\d{0,8})"\s*$/.exec(etag ?? '');
  return m?.[1] ? Number(m[1]) : null;
}

/** `3` or `r3` → 3. */
export function parseRevision(value: string, option: string): number {
  const m = /^\s*r?([1-9]\d{0,8})\s*$/i.exec(value);
  if (!m?.[1]) throw new CliError(`${option} takes a revision number such as 3 or r3`);
  return Number(m[1]);
}

/** Reads and parses the document (≤ 2 MiB, JSON) before any request. */
export async function readDocument(io: CliIo, file: string): Promise<unknown> {
  const resolved = path.resolve(io.cwd, file);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) throw new CliError(`${file} is not a file`);
  if (info.size > MAX_VALUE_CHAIN_BODY_BYTES) {
    throw new CliError(
      `${file} has ${info.size} bytes; a value chain document may have at most ${MAX_VALUE_CHAIN_BODY_BYTES}`,
    );
  }
  try {
    return JSON.parse(await readFile(resolved, 'utf8')) as unknown;
  } catch (err) {
    throw new CliError(`${file} is not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function counts(c: { accepted: number; held: number; proposed: number }): string {
  return `${c.accepted} accepted, ${c.held} held, ${c.proposed} proposed`;
}

/** Added steps listed by name; beyond that only counted (a new chain adds all of them). */
const ADDED_LISTED = 10;

/** The impact of a save, as lines for the terminal. */
export function formatImpact(impact: ValueChainImpact): string[] {
  const { steps, placements } = impact;
  const lines: string[] = [];
  if (!impact.structureChanged) lines.push('  structure unchanged (layout or name only)');
  if (steps.added.length > ADDED_LISTED) lines.push(`  steps added: ${steps.added.length}`);
  else if (steps.added.length > 0) {
    lines.push(`  steps added: ${steps.added.map((s) => `${s.elementId} "${s.name}"`).join(', ')}`);
  }
  for (const s of steps.removed) {
    lines.push(`  step removed: ${s.elementId} "${s.name}" (${counts(s.placements)})`);
  }
  for (const s of steps.changed) {
    const what: string[] = [];
    if (s.before.name !== s.after.name) what.push(`"${s.before.name}" → "${s.after.name}"`);
    if (s.before.parentId !== s.after.parentId) {
      what.push(`parent ${s.before.parentId ?? '(none)'} → ${s.after.parentId ?? '(none)'}`);
    }
    if (s.before.kind !== s.after.kind) what.push(`kind ${s.before.kind} → ${s.after.kind}`);
    const reconfirm = s.fingerprintChanged && s.placements.accepted > 0 ? ', re-confirm' : '';
    lines.push(
      `  step changed: ${s.elementId} ${what.join(', ')} (${counts(s.placements)}${reconfirm})`,
    );
  }
  lines.push(
    `  placements: ${placements.stranded} stranded, ${placements.toReconfirm} to re-confirm, ${plural(placements.proposalsWithdrawn, 'proposal')} withdrawn`,
  );
  return lines;
}

/** What a save would do to decided placements: stranded on removed steps or sent to re-confirm. */
function needsConfirmation(impact: ValueChainImpact): boolean {
  return impact.placements.stranded > 0 || impact.placements.toReconfirm > 0;
}

function violationLine(v: ValueChainViolation): string {
  const where = [
    v.elementId === null ? null : `element ${v.elementId}`,
    v.connectionId === null ? null : `connection ${v.connectionId}`,
    v.path === null ? null : `at ${v.path}`,
  ].filter((x) => x !== null);
  return `  ${v.reason}${where.length > 0 ? ` (${where.join(', ')})` : ''}: ${v.detail}`;
}

/** Turns the save problems into messages: 412 (pull first), 422 (the violations). */
export function explain(err: unknown, opts: ValueChainOptions): never {
  if (!(err instanceof ApiError)) throw err;
  const problem = (err.problem ?? {}) as Record<string, unknown>;
  if (err.status === 412 && problem['code'] === 'revision-conflict') {
    const headRev = typeof problem['headRev'] === 'number' ? problem['headRev'] : null;
    throw new CliError(
      headRev === null
        ? `the value chain ${opts.key ?? VALUE_CHAIN_KEY} exists; pull it first`
        : `the value chain is at r${headRev}; pull first (proa value-chain pull -p ${opts.project}), merge your changes and push again`,
    );
  }
  if (err.status === 422 && problem['code'] === 'value-chain-invalid') {
    const violations = Array.isArray(problem['violations'])
      ? (problem['violations'] as ValueChainViolation[])
      : [];
    const lines = [
      `the server refused the document (${plural(violations.length, 'violation')}${problem['truncated'] === true ? ', more not listed' : ''}):`,
      ...violations.map(violationLine),
    ];
    throw new CliError(lines.join('\n'));
  }
  if (err.status === 422 && problem['code'] === 'value-chain-unsupported-version') {
    throw new CliError(
      `the document's schemaVersion ${String(problem['schemaVersion'])} is newer than the server supports (${String(problem['supported'])})`,
    );
  }
  throw err;
}

/** The head revision of the chain, or `null` if the project has no (live) chain. */
export async function headRev(api: Api, project: string, key: string): Promise<number | null> {
  try {
    const { response } = await callWithResponse(
      api,
      `read the value chain of ${project}`,
      getValueChainContent({ client: api.client, path: { project, key }, parseAs: 'text' }),
    );
    const rev = revisionOfEtag(response.headers.get('etag'));
    if (rev === null) throw new CliError('the server sent the value chain without a revision ETag');
    return rev;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && err.problem?.code === 'not-found') {
      // Also for an unknown project: the save then answers 404 with the server's message.
      return null;
    }
    throw err;
  }
}

/** `PUT …/content` with the precondition; returns the result and its status. */
async function save(
  api: Api,
  opts: ValueChainOptions,
  document: unknown,
  precondition: { 'if-match': string } | { 'if-none-match': '*' },
  dryRun: boolean,
): Promise<SaveValueChainResult> {
  const key = opts.key ?? VALUE_CHAIN_KEY;
  try {
    const { data } = await callWithResponse(
      api,
      `${dryRun ? 'dry-run the save of' : 'save'} the value chain of ${opts.project}`,
      putValueChainContent({
        client: api.client,
        path: { project: opts.project, key },
        query: dryRun ? { dryRun: 'true' } : {},
        headers: precondition,
        body: document as Record<string, unknown>,
      }),
    );
    return data;
  } catch (err) {
    return explain(err, opts);
  }
}

function summary(project: string, r: SaveValueChainResult, from: number | null): string {
  const rev = r.valueChain?.headRev ?? null;
  const head = rev === null ? '' : ` r${rev}`;
  const at = from === null ? '' : ` (from r${from})`;
  return `${project}: value chain ${r.outcome}${head}${at}`;
}

/** `proa value-chain push <file> -p <project> [--key] [--base <rev> | --force] [--dry-run] [--yes] [--json]`. */
export async function valueChainPushCommand(
  io: CliIo,
  file: string,
  opts: PushOptions,
): Promise<void> {
  if (agentToken(io, opts) !== undefined) {
    throw new CliError(
      'agents never edit the value chain: push uses the owner key (drop --token and unset PROA_TOKEN)',
    );
  }
  const base = opts.base === undefined ? null : parseRevision(opts.base, '--base');
  if (base !== null && opts.force === true) {
    throw new CliError('--base and --force exclude each other: --force saves on the current head');
  }
  const document = await readDocument(io, file);
  const api = createApi(io, opts.url, await ownerCredential(io, opts));
  const key = opts.key ?? VALUE_CHAIN_KEY;
  const out = (text: string) => io.stdout(text.endsWith('\n') ? text : `${text}\n`);

  const head = await headRev(api, opts.project, key);
  const precondition =
    head === null && base === null
      ? ({ 'if-none-match': '*' } as const)
      : { 'if-match': `"r${base ?? head ?? 0}"` };

  const dry = await save(api, opts, document, precondition, true);
  // An existing chain needs the revision the file comes from: the head as it is now would let
  // this save silently revert one made since the pull (unchanged content and dry runs aside).
  const unbased = head !== null && base === null && opts.force !== true;
  if (unbased && !opts.dryRun && dry.outcome !== 'unchanged') {
    throw new CliError(
      `the value chain of ${opts.project} exists (head r${head}): pass --base with the revision your file comes from (pull prints r<rev> on stderr), or --force to save over r${head} as it is now`,
    );
  }
  const stop = !opts.dryRun && needsConfirmation(dry.impact) && opts.yes !== true;
  if (opts.dryRun || dry.outcome === 'unchanged' || stop) {
    if (opts.json) out(JSON.stringify(dry, null, 2));
    else {
      const prefix = dry.outcome === 'unchanged' ? '' : 'dry run: ';
      out(
        [
          `${prefix}${summary(opts.project, dry, null)}`,
          ...(dry.outcome === 'unchanged' ? [] : formatImpact(dry.impact)),
          ...(unbased && dry.outcome !== 'unchanged'
            ? [`  (against the current head r${head}; saving needs --base or --force)`]
            : []),
        ].join('\n'),
      );
    }
    if (stop) {
      throw new CliError(
        `the save would strand ${plural(dry.impact.placements.stranded, 'placement')} and send ${dry.impact.placements.toReconfirm} to re-confirm; push again with --yes to save anyway`,
      );
    }
    return;
  }

  const saved = await save(api, opts, document, precondition, false);
  if (opts.json) out(JSON.stringify(saved, null, 2));
  else out([summary(opts.project, saved, base ?? head), ...formatImpact(saved.impact)].join('\n'));
}

/** `proa value-chain pull -p <project> [--key] [--rev <n>] [-o <file>]`. */
export async function valueChainPullCommand(io: CliIo, opts: PullOptions): Promise<void> {
  const rev = opts.rev === undefined ? null : parseRevision(opts.rev, '--rev');
  const api = createApi(io, opts.url, await anyCredential(io, opts));
  const key = opts.key ?? VALUE_CHAIN_KEY;
  const what = `read the value chain of ${opts.project}`;
  // `text`: the canonical bytes verbatim, never parsed and serialized again.
  const { data, response } = await callWithResponse(
    api,
    what,
    rev === null
      ? getValueChainContent({
          client: api.client,
          path: { project: opts.project, key },
          parseAs: 'text',
        })
      : getValueChainRevisionContent({
          client: api.client,
          path: { project: opts.project, key, rev },
          parseAs: 'text',
        }),
  );
  const text = data as unknown as string;
  if (typeof text !== 'string') throw new CliError('the server sent no document');
  const pulled = revisionOfEtag(response.headers.get('etag')) ?? rev;
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  if (opts.output === undefined) io.stdout(text);
  else await writeFile(path.resolve(io.cwd, opts.output), text, 'utf8');
  io.stderr(`r${pulled ?? '?'} ${hash}\n`);
}

/**
 * `proa value-chain requeue`: the value chain's placement task, queued when an
 * open process is due (`queued`); `open` when one is queued or claimed,
 * `nothing-due` when every open process has a verdict on its current input.
 * Needs `write` (the owner key, or an agent token with `proa:write`).
 *
 * @throws {CliError} when the project has no value chain
 */
export async function valueChainRequeueCommand(io: CliIo, opts: RequeueOptions): Promise<void> {
  const api = createApi(io, opts.url, await anyCredential(io, opts));
  const result = await call(
    api,
    `requeue the placement task of ${opts.project}`,
    requeueAnalyses({
      client: api.client,
      path: { project: opts.project },
      body: { valueChain: true },
    }),
  );
  const chain = result.valueChain;
  if (!chain || chain.outcome === 'not-found') {
    throw new CliError(
      `${opts.project} has no value chain; create it first (proa value-chain push)`,
    );
  }
  if (opts.json) {
    io.stdout(`${JSON.stringify(chain, null, 2)}\n`);
    return;
  }
  io.stdout(
    chain.outcome === 'queued'
      ? `queued placement task ${chain.taskId ?? ''}\n`
      : chain.outcome === 'open'
        ? `a placement task is already queued or claimed: ${chain.taskId ?? ''}\n`
        : 'nothing due: every open process has a verdict on its current input\n',
  );
}
