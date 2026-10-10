import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getLandscape,
  getProject,
  putValueChainContent,
  type CreatedAgentToken,
  type Landscape,
  type SaveValueChainResult,
} from '@proa/client';
import {
  CreateAgentTokenBody,
  MAX_VALUE_CHAIN_BODY_BYTES,
  ProjectKey,
  VALUE_CHAIN_KEY,
} from '@proa/contracts';
import { parse as parseYaml } from 'yaml';

import { call, callOrNull, callWithResponse, createApi, type Api } from '../api.ts';
import { ownerCredential, type CredentialOptions } from '../credentials.ts';
import { ApiError, CliError } from '../errors.ts';
import type { CliIo } from '../io.ts';
import { ensureProject, formatImport, importDirectory, type ImportSummary } from './import.ts';
import { DEFAULT_SCOPES, createToken, formatCreatedToken } from './token.ts';
import { explain, headRev } from './value-chain.ts';

/** `eval/corpus` of the repository (also inside the Docker image). */
export const DEFAULT_CORPUS = fileURLToPath(new URL('../../../../eval/corpus', import.meta.url));

/**
 * `eval/value-chains` of the repository: the golden chain of a landscape is
 * `<landscape directory>/value-chain.vc.json`. The Docker image ships only
 * these chain files (steps without links, the document an agent reads over
 * MCP), never `expected-placements.yaml`.
 */
export const DEFAULT_VALUE_CHAINS = fileURLToPath(
  new URL('../../../../eval/value-chains', import.meta.url),
);

/** The golden chain's file name in a landscape directory of `eval/value-chains`. */
export const VALUE_CHAIN_FILE = 'value-chain.vc.json';

export interface CorpusLandscape {
  key: string;
  name: string;
  dir: string;
}

const isDir = (p: string) =>
  stat(p).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** Longest project name derived from a description; longer clauses fall back to the key. */
const MAX_DERIVED_NAME = 60;

/** The description up to its first `,`, `.` or `;` outside parentheses. */
function firstClause(text: string): string {
  let depth = 0;
  for (const [i, ch] of [...text].entries()) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ',' || ch === '.' || ch === ';')) return text.slice(0, i);
  }
  return text;
}

/**
 * Project name of a landscape: the first clause of `landscape.yaml`'s
 * description ("Nordwind Handel GmbH, a fictional …" → "Nordwind Handel
 * GmbH") if it is short, else the key.
 */
export function landscapeName(key: string, yamlText: string | null): string {
  if (yamlText === null) return key;
  let meta: unknown;
  try {
    meta = parseYaml(yamlText);
  } catch {
    return key;
  }
  const description =
    typeof meta === 'object' && meta !== null && 'description' in meta
      ? String(meta.description)
      : '';
  const clause = firstClause(description).trim();
  return clause !== '' && clause.length <= MAX_DERIVED_NAME ? clause : key;
}

/**
 * The landscapes to seed: the given names, or every directory of the corpus
 * with a `models/` folder whose name does not start with `_` or `.`. The
 * project key is the directory name without leading underscores.
 *
 * @throws {CliError} for unknown names or names that are no project key
 */
export async function findLandscapes(
  corpus: string,
  names: readonly string[],
): Promise<CorpusLandscape[]> {
  if (!(await isDir(corpus))) throw new CliError(`corpus ${corpus} is not a directory`);
  const candidates =
    names.length > 0
      ? [...names]
      : (await readdir(corpus)).filter((n) => !n.startsWith('_') && !n.startsWith('.')).sort();
  const out: CorpusLandscape[] = [];
  for (const name of candidates) {
    const dir = path.join(corpus, name);
    if (!(await isDir(path.join(dir, 'models')))) {
      if (names.length > 0) throw new CliError(`${dir} has no models/ directory`);
      continue;
    }
    // `_sample` (not part of the scored corpus) seeds into project `sample`.
    const key = name.replace(/^_+/, '');
    if (!ProjectKey.safeParse(key).success) {
      throw new CliError(`landscape ${JSON.stringify(name)} gives no valid project key`);
    }
    const yamlText = await readFile(path.join(dir, 'landscape.yaml'), 'utf8').catch(() => null);
    out.push({ key, name: landscapeName(key, yamlText), dir });
  }
  if (out.length === 0) throw new CliError(`no landscapes with models/ in ${corpus}`);
  return out;
}

/**
 * What `--value-chains` did to the project's chain: `created` (r1),
 * `revived` (the project's deleted chain saved again), `unchanged` (the head
 * equals the golden chain), `differs` (an edited chain, left unchanged) or
 * `none` (the landscape has no golden chain).
 */
export type ValueChainSeedOutcome = 'created' | 'revived' | 'unchanged' | 'differs' | 'none';

export interface ValueChainSeed {
  outcome: ValueChainSeedOutcome;
  /** The head revision after seeding; `null` for `none`. */
  rev: number | null;
}

export interface SeedResult {
  project: string;
  /** Key of the seeded landscape (the project key unless `--project` named another). */
  landscape: string;
  name: string;
  created: boolean;
  import: ImportSummary;
  models: number;
  relations: Record<string, number>;
  findings: number;
  /** `--value-chains` only, else `null`. */
  valueChain: ValueChainSeed | null;
  token: CreatedAgentToken | null;
}

function summarize(l: Landscape): Pick<SeedResult, 'models' | 'relations' | 'findings'> {
  const relations: Record<string, number> = {};
  for (const r of l.relations) relations[r.status] = (relations[r.status] ?? 0) + 1;
  return { models: l.models.length, relations, findings: l.findings.length };
}

/** Name of the agent token `--issue-tokens` creates unless `--token-name` gives one. */
export const SEED_TOKEN_NAME = 'seed';

export interface SeedTarget {
  /**
   * Project key to seed into (default: the landscape's key); such a project
   * is named `<landscape name> (<key>)`.
   */
  project?: string;
  /** Create a read+propose agent token with this name. */
  tokenName?: string;
  /** Also seed the golden value chain from this `eval/value-chains` directory. */
  valueChains?: string;
}

/** Attempts of the read-then-save sequence when a concurrent save moves the head (412). */
const SEED_CHAIN_ATTEMPTS = 3;

/** Reads a golden chain file (≤ 2 MiB, JSON); `null` when the landscape has none. */
async function readGoldenChain(file: string): Promise<Record<string, unknown> | null> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return null;
  if (info.size > MAX_VALUE_CHAIN_BODY_BYTES) {
    throw new CliError(
      `${file} has ${info.size} bytes; a value chain document may have at most ${MAX_VALUE_CHAIN_BODY_BYTES}`,
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new CliError(`${file} is not JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new CliError(`${file} is no value chain document (not a JSON object)`);
  }
  return doc as Record<string, unknown>;
}

const isConflict = (err: unknown) =>
  err instanceof ApiError && err.status === 412 && err.problem?.code === 'revision-conflict';

/**
 * Seeds the golden value chain of a project without placements (M4 §6): a
 * project without a (live) chain gets it with `If-None-Match: *` (`created`;
 * `revived` for a deleted chain); an existing chain is compared by a dry run
 * on its head (`If-Match: "r<head>"`) and never overwritten (`unchanged` or
 * `differs`), so a re-run changes nothing. The save derives the rule tier's
 * key proposals as any save does; no golden placement is loaded. A 412 (a
 * concurrent save) reads again; a 422 lists the violations.
 *
 * @param file `<value-chains dir>/<landscape directory>/value-chain.vc.json`; only this file is read
 */
export async function seedValueChain(
  api: Api,
  project: string,
  file: string,
): Promise<ValueChainSeed> {
  const document = await readGoldenChain(file);
  if (document === null) return { outcome: 'none', rev: null };
  const key = VALUE_CHAIN_KEY;
  const put = async (
    headers: { 'if-match': string } | { 'if-none-match': '*' },
    dryRun: boolean,
  ): Promise<SaveValueChainResult> =>
    (
      await callWithResponse(
        api,
        `${dryRun ? 'dry-run the save of' : 'save'} the value chain of ${project}`,
        putValueChainContent({
          client: api.client,
          path: { project, key },
          query: dryRun ? { dryRun: 'true' } : {},
          headers,
          body: document,
        }),
      )
    ).data;
  for (let attempt = 1; attempt <= SEED_CHAIN_ATTEMPTS; attempt++) {
    const head = await headRev(api, project, key);
    try {
      if (head === null) {
        const saved = await put({ 'if-none-match': '*' }, false);
        return {
          outcome: saved.outcome === 'revived' ? 'revived' : 'created',
          rev: saved.valueChain?.headRev ?? null,
        };
      }
      const dry = await put({ 'if-match': `"r${head}"` }, true);
      return { outcome: dry.outcome === 'unchanged' ? 'unchanged' : 'differs', rev: head };
    } catch (err) {
      if (isConflict(err) && attempt < SEED_CHAIN_ATTEMPTS) continue;
      explain(err, { url: api.url, project, key });
    }
  }
  throw new CliError(`the value chain of ${project} kept changing while seeding; run seed again`);
}

/** The text line of a seeded chain. */
export function formatValueChainSeed(seed: ValueChainSeed): string {
  switch (seed.outcome) {
    case 'none':
      return '  value chain: no golden value chain\n';
    case 'differs':
      return `  value chain: exists r${seed.rev}, differs from the golden chain: left unchanged\n`;
    case 'revived':
      return `  value chain: revived r${seed.rev} (the project's deleted chain, saved again with the golden content)\n`;
    case 'created':
    case 'unchanged':
      return `  value chain: ${seed.outcome} r${seed.rev}\n`;
  }
}

/** Seeds one landscape into the project of the same key, or into `target.project`. */
export async function seedLandscape(
  api: Api,
  landscape: CorpusLandscape,
  target: SeedTarget = {},
): Promise<SeedResult> {
  const key = target.project ?? landscape.key;
  const name = target.project ? `${landscape.name} (${target.project})` : landscape.name;
  const { project, created } = await ensureProject(api, key, name);
  const summary = await importDirectory(api, key, path.join(landscape.dir, 'models'));
  // After the import (the rule tier sees the process facts when the chain is created), before the token.
  const valueChain =
    target.valueChains !== undefined
      ? await seedValueChain(
          api,
          key,
          path.join(target.valueChains, path.basename(landscape.dir), VALUE_CHAIN_FILE),
        )
      : null;
  const view = await call(
    api,
    `read the landscape of ${key}`,
    getLandscape({ client: api.client, path: { project: key } }),
  );
  const token =
    target.tokenName !== undefined
      ? await createToken(api, key, {
          name: target.tokenName,
          scopes: [...DEFAULT_SCOPES],
          expiresInDays: 90,
        })
      : null;
  return {
    project: key,
    landscape: landscape.key,
    name: project.name,
    created,
    import: summary,
    ...summarize(view),
    valueChain,
    token,
  };
}

export interface SeedOptions extends CredentialOptions {
  url: string;
  corpus?: string;
  /**
   * Seed exactly one landscape into a new project with this key (a fresh
   * project per live run); an existing project is refused.
   */
  project?: string;
  issueTokens?: boolean;
  /** Name of the issued tokens (with `issueTokens`); default {@link SEED_TOKEN_NAME}. */
  tokenName?: string;
  /** Also seed each landscape's golden value chain, without placements. */
  valueChains?: boolean;
  /** Directory of the golden chains (with `valueChains`); default {@link DEFAULT_VALUE_CHAINS}. */
  valueChainsDir?: string;
  json?: boolean;
  verbose?: boolean;
}

/**
 * Checks the options that do not need the corpus or the server.
 *
 * @throws {CliError} for `--project` without exactly one landscape or with an invalid key, for
 *   `--token-name` without `--issue-tokens` or with an invalid name, and for
 *   `--value-chains-dir` without `--value-chains`
 */
export function checkSeedOptions(names: readonly string[], opts: SeedOptions): void {
  if (opts.project !== undefined) {
    if (names.length !== 1) {
      throw new CliError(
        `--project seeds exactly one landscape; name it, e.g. proa seed nordwind-handel --project ${opts.project}`,
      );
    }
    const key = ProjectKey.safeParse(opts.project);
    if (!key.success) {
      throw new CliError(
        `invalid project key ${JSON.stringify(opts.project)}: ${key.error.issues[0]?.message ?? 'not a project key'}`,
      );
    }
  }
  if (opts.tokenName !== undefined) {
    if (opts.issueTokens !== true) throw new CliError('--token-name needs --issue-tokens');
    const name = CreateAgentTokenBody.shape.name.safeParse(opts.tokenName);
    if (!name.success) {
      throw new CliError(
        `invalid token name ${JSON.stringify(opts.tokenName)}: 1–100 characters, no control characters`,
      );
    }
  }
  if (opts.valueChainsDir !== undefined && opts.valueChains !== true) {
    throw new CliError('--value-chains-dir needs --value-chains');
  }
}

/**
 * `proa seed [landscape...]`: creates one project per eval landscape
 * (default: every scored landscape of `eval/corpus`) and imports its models
 * as the owner. Re-running it is safe: existing projects are reused and
 * unchanged models stay unchanged. `--project <key>` seeds one landscape
 * into a new project with another key (a fresh project per live run, CONCEPT
 * §7); `--issue-tokens` creates a read+propose agent token per project,
 * named `--token-name` (default `seed`; the name is the agent segment of
 * `eval:live` recordings). `--value-chains` also seeds each landscape's
 * golden value chain (`eval/value-chains/<landscape>/value-chain.vc.json`,
 * or `--value-chains-dir`) without placements, after the import and before
 * the token; an existing chain is never overwritten.
 *
 * @throws {CliError} if the `--project` project exists, before any import or
 *   token request: imports cannot be undone, and a reused project mixes runs
 */
export async function seedCommand(
  io: CliIo,
  names: readonly string[],
  opts: SeedOptions,
): Promise<void> {
  checkSeedOptions(names, opts);
  const corpus = opts.corpus ? path.resolve(io.cwd, opts.corpus) : DEFAULT_CORPUS;
  const landscapes = await findLandscapes(corpus, names);
  const valueChains = opts.valueChains
    ? opts.valueChainsDir
      ? path.resolve(io.cwd, opts.valueChainsDir)
      : DEFAULT_VALUE_CHAINS
    : undefined;
  if (valueChains !== undefined && !(await isDir(valueChains))) {
    throw new CliError(`value chains ${valueChains} is not a directory`);
  }
  const api = createApi(io, opts.url, await ownerCredential(io, opts));
  if (opts.project !== undefined) {
    const existing = await callOrNull(
      api,
      `look up project ${opts.project}`,
      getProject({ client: api.client, path: { project: opts.project } }),
    );
    if (existing) {
      throw new CliError(
        `project ${opts.project} already exists; a live run needs a fresh project: pick another key (nothing was imported, no token was issued)`,
      );
    }
  }
  const target: SeedTarget = {
    ...(opts.project !== undefined ? { project: opts.project } : {}),
    ...(opts.issueTokens ? { tokenName: opts.tokenName ?? SEED_TOKEN_NAME } : {}),
    ...(valueChains !== undefined ? { valueChains } : {}),
  };
  const results: SeedResult[] = [];
  let failed = 0;
  for (const l of landscapes) {
    const r = await seedLandscape(api, l, target);
    results.push(r);
    failed += r.import.counts.failed;
    if (opts.json) continue;
    const rel = Object.entries(r.relations)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, n]) => `${n} ${s}`)
      .join(', ');
    const head =
      r.landscape === r.project
        ? `${r.project} (${r.name})`
        : `${r.project} (landscape ${r.landscape})`;
    io.stdout(`${head}: project ${r.created ? 'created' : 'exists'}\n`);
    if (opts.verbose) io.stdout(formatImport(r.import));
    else {
      const c = r.import.counts;
      io.stdout(
        `  ${r.import.files.length} files: ${c.created} created, ${c.revised} revised, ${c.unchanged} unchanged, ${c.failed} failed\n`,
      );
    }
    io.stdout(`  ${r.models} models, relations: ${rel || 'none'}, ${r.findings} findings\n`);
    if (r.valueChain) io.stdout(formatValueChainSeed(r.valueChain));
    if (r.token) io.stdout(`\n${formatCreatedToken(io, opts.url, r.project, r.token)}\n`);
  }
  if (opts.json) io.stdout(`${JSON.stringify(results, null, 2)}\n`);
  else if (!opts.issueTokens) {
    io.stdout(
      `\nConnect an agent: proa token create --project ${results[0]?.project ?? '<key>'}\n`,
    );
  }
  if (failed > 0) throw new CliError(`${failed} files failed to import`);
}
