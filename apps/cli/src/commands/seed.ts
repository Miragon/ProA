import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLandscape, type CreatedAgentToken, type Landscape } from '@proa/client';
import { ProjectKey } from '@proa/contracts';
import { parse as parseYaml } from 'yaml';

import { call, createApi, type Api } from '../api.ts';
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

/** Seeds one landscape into the project of the same key. */
export async function seedLandscape(
  api: Api,
  landscape: CorpusLandscape,
  issueToken: boolean,
): Promise<SeedResult> {
  const { project, created } = await ensureProject(api, landscape.key, landscape.name);
  const summary = await importDirectory(api, landscape.key, path.join(landscape.dir, 'models'));
  const view = await call(
    api,
    `read the landscape of ${landscape.key}`,
    getLandscape({ client: api.client, path: { project: landscape.key } }),
  );
  const token = issueToken
    ? await createToken(api, landscape.key, {
        name: 'seed',
        scopes: [...DEFAULT_SCOPES],
        expiresInDays: 90,
      })
    : null;
  return {
    project: landscape.key,
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
  issueTokens?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/**
 * `proa seed [landscape...]`: creates one project per eval landscape
 * (default: every scored landscape of `eval/corpus`) and imports its models
 * as the owner. Re-running it is safe: existing projects are reused and
 * unchanged models stay unchanged.
 */
export async function seedCommand(
  io: CliIo,
  names: readonly string[],
  opts: SeedOptions,
): Promise<void> {
  const corpus = opts.corpus ? path.resolve(io.cwd, opts.corpus) : DEFAULT_CORPUS;
  const landscapes = await findLandscapes(corpus, names);
  const api = createApi(io, opts.url, await ownerCredential(io, opts));
  const results: SeedResult[] = [];
  let failed = 0;
  for (const l of landscapes) {
    const r = await seedLandscape(api, l, opts.issueTokens === true);
    results.push(r);
    failed += r.import.counts.failed;
    if (opts.json) continue;
    const rel = Object.entries(r.relations)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, n]) => `${n} ${s}`)
      .join(', ');
    io.stdout(`${r.project} (${r.name}): project ${r.created ? 'created' : 'exists'}\n`);
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
