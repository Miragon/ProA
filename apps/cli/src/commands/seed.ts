import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLandscape, getProject, type CreatedAgentToken, type Landscape } from '@proa/client';
import { CreateAgentTokenBody, ProjectKey } from '@proa/contracts';
import { parse as parseYaml } from 'yaml';

import { call, callOrNull, createApi, type Api } from '../api.ts';
import { ownerCredential, type CredentialOptions } from '../credentials.ts';
import { CliError } from '../errors.ts';
import type { CliIo } from '../io.ts';
import { ensureProject, formatImport, importDirectory, type ImportSummary } from './import.ts';
import { DEFAULT_SCOPES, createToken, formatCreatedToken } from './token.ts';

/** `eval/corpus` of the repository (also inside the Docker image). */
export const DEFAULT_CORPUS = fileURLToPath(new URL('../../../../eval/corpus', import.meta.url));

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
  json?: boolean;
  verbose?: boolean;
}

/**
 * Checks the options that do not need the corpus or the server.
 *
 * @throws {CliError} for `--project` without exactly one landscape or with an invalid key, and
 *   for `--token-name` without `--issue-tokens` or with an invalid name
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
}

/**
 * `proa seed [landscape...]`: creates one project per eval landscape
 * (default: every scored landscape of `eval/corpus`) and imports its models
 * as the owner. Re-running it is safe: existing projects are reused and
 * unchanged models stay unchanged. `--project <key>` seeds one landscape
 * into a new project with another key (a fresh project per live run, CONCEPT
 * §7); `--issue-tokens` creates a read+propose agent token per project,
 * named `--token-name` (default `seed`; the name is the agent segment of
 * `eval:live` recordings).
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
