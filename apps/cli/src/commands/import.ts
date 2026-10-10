import path from 'node:path';

import { createProject, getProject, importModels, type Project } from '@proa/client';
import { MAX_MODEL_BYTES, createProblem, type ImportFileOutcome } from '@proa/contracts';

import { call, callOrNull, createApi, type Api } from '../api.ts';
import { anyCredential, ownerCredential, type CredentialOptions } from '../credentials.ts';
import { CliError } from '../errors.ts';
import { batches, findBpmnFiles } from '../files.ts';
import type { CliIo } from '../io.ts';

export interface ImportSummary {
  project: string;
  files: ImportFileOutcome[];
  counts: Record<ImportFileOutcome['outcome'], number>;
}

/**
 * Uploads every BPMN file below `dir` to `POST /projects/{project}/imports`
 * in batches (≤ 50 files, ≤ 25 MB each); the server derives each model key
 * from the path below `dir`. Files above 5 MB are reported failed locally.
 */
export async function importDirectory(
  api: Api,
  project: string,
  dir: string,
): Promise<ImportSummary> {
  const found = await findBpmnFiles(dir);
  if (found.length === 0) throw new CliError(`no BPMN files (*.bpmn) below ${dir}`);
  const { batches: groups, oversized } = batches(found);

  const files: ImportFileOutcome[] = oversized.map((f) => ({
    path: f.path,
    modelKey: null,
    outcome: 'failed',
    problem: createProblem(
      'payload-too-large',
      `a model may have at most ${MAX_MODEL_BYTES} bytes`,
    ),
  }));
  for (const group of groups) {
    const result = await call(
      api,
      `import into ${project}`,
      importModels({
        client: api.client,
        path: { project },
        body: { files: group.map((f) => new File([f.bytes], f.path)) },
      }),
    );
    files.push(...result.files);
  }
  const counts = { created: 0, revised: 0, unchanged: 0, failed: 0 };
  for (const f of files) counts[f.outcome]++;
  return { project, files, counts };
}

export function formatImport(summary: ImportSummary): string {
  const lines = summary.files.map((f) => {
    const name = f.modelKey ?? f.path;
    const why = f.problem
      ? `  (${f.problem.status} ${f.problem.code}: ${f.problem.detail ?? f.problem.title})`
      : '';
    return `  ${f.outcome.padEnd(9)} ${name}${why}`;
  });
  const c = summary.counts;
  lines.push(
    `${summary.project}: ${summary.files.length} files, ${c.created} created, ${c.revised} revised, ${c.unchanged} unchanged, ${c.failed} failed`,
  );
  return `${lines.join('\n')}\n`;
}

/** The project, created with `name` unless it exists (creating needs the owner). */
export async function ensureProject(
  api: Api,
  key: string,
  name: string,
): Promise<{ project: Project; created: boolean }> {
  const existing = await callOrNull(
    api,
    `look up project ${key}`,
    getProject({ client: api.client, path: { project: key } }),
  );
  if (existing) return { project: existing, created: false };
  const project = await call(
    api,
    `create project ${key}`,
    createProject({ client: api.client, body: { key, name } }),
  );
  return { project, created: true };
}

export interface ImportOptions extends CredentialOptions {
  url: string;
  project: string;
  create?: boolean;
  name?: string;
  json?: boolean;
}

/** `proa import <dir> --project <key> [--create [--name <name>]] [--json]`. */
export async function importCommand(io: CliIo, dir: string, opts: ImportOptions): Promise<void> {
  const credential = opts.create ? await ownerCredential(io, opts) : await anyCredential(io, opts);
  const api = createApi(io, opts.url, credential);
  if (opts.create) {
    const { created } = await ensureProject(api, opts.project, opts.name ?? opts.project);
    if (created && !opts.json) io.stdout(`created project ${opts.project}\n`);
  }
  const summary = await importDirectory(api, opts.project, path.resolve(io.cwd, dir));
  io.stdout(opts.json ? `${JSON.stringify(summary, null, 2)}\n` : formatImport(summary));
  if (summary.counts.failed > 0) {
    throw new CliError(`${summary.counts.failed} of ${summary.files.length} files failed`);
  }
}
