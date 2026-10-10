import {
  getHealth,
  getLandscape,
  getMe,
  listProjects,
  type Landscape,
  type Me,
  type Project,
} from '@proa/client';
import { Health, OWNER_KEY_FILE_ENV } from '@proa/contracts';

import { call, createApi } from '../api.ts';
import {
  anyCredential,
  describeCredential,
  isExplicitOwnerKeyFile,
  type Credential,
  type CredentialOptions,
} from '../credentials.ts';
import { ApiError, CliError } from '../errors.ts';
import type { CliIo } from '../io.ts';

export interface ProjectStatus {
  key: string;
  name: string;
  role: string;
  seq: number;
  models: number;
  stages: Record<string, number>;
  relations: Record<string, number>;
  /** Accepted relations whose endpoint changed or went missing (open items). */
  endpointIssues: number;
  findings: Record<string, number>;
}

export interface Status {
  url: string;
  health: Health;
  me: Me | null;
  credential: string | null;
  projects: ProjectStatus[];
  /** Why no projects are shown, if so. */
  note: string | null;
}

function tally(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of [...values].sort()) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export function projectStatus(project: Project, l: Landscape): ProjectStatus {
  return {
    key: project.key,
    name: project.name,
    role: project.role,
    seq: l.seq,
    models: l.models.length,
    stages: tally(l.models.map((m) => m.stage)),
    relations: tally(l.relations.map((r) => r.status)),
    endpointIssues: l.relations.filter((r) => r.status === 'accepted' && r.endpointState !== 'ok')
      .length,
    findings: tally(l.findings.map((f) => f.kind)),
  };
}

const list = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([k, n]) => `${n} ${k.replaceAll('_', ' ')}`)
    .join(', ') || 'none';

export function formatStatus(s: Status): string {
  const lines = [
    `ProA ${s.health.version} at ${s.url}: ${s.health.status}, database ${s.health.db}`,
  ];
  if (s.me && s.credential) {
    lines.push(
      `as ${s.me.handle} (${s.me.kind}, client ${s.me.clientId ?? '-'}) via ${s.credential}`,
    );
  }
  if (s.note) lines.push(s.note);
  for (const p of s.projects) {
    lines.push(
      '',
      `${p.key}  ${p.name}  (role ${p.role}, seq ${p.seq})`,
      `  models     ${p.models}${p.models > 0 ? ` (${list(p.stages)})` : ''}`,
      `  relations  ${list(p.relations)}`,
      `  endpoints  ${p.endpointIssues === 0 ? 'ok' : `${p.endpointIssues} accepted relations with a changed or missing endpoint`}`,
      `  findings   ${list(p.findings)}`,
    );
  }
  if (s.projects.length === 0 && !s.note)
    lines.push('no projects yet: proa seed, or proa import <dir> --project <key> --create');
  return `${lines.join('\n')}\n`;
}

export interface StatusOptions extends CredentialOptions {
  url: string;
  project?: string;
  json?: boolean;
}

/**
 * `proa status [--project <p>] [--json]`: server health, the caller, and per
 * project the models by stage, relations by status, endpoint problems and
 * findings. Without credentials, or when the server rejects the owner key
 * found at the default location (another ProA instance's key, e.g. from
 * `pnpm dev` while the Docker stack runs), it reports the server only.
 */
export async function statusCommand(io: CliIo, opts: StatusOptions): Promise<void> {
  const anonymous = createApi(io, opts.url);
  const health = await call(
    anonymous,
    'health check',
    getHealth({ client: anonymous.client }),
  ).catch((err: unknown) => {
    // 503 (database down) still carries the health document.
    const degraded = err instanceof ApiError ? Health.safeParse(err.problem) : null;
    if (degraded?.success) return degraded.data;
    throw err;
  });
  const status: Status = {
    url: opts.url,
    health,
    me: null,
    credential: null,
    projects: [],
    note: null,
  };

  let credential: Credential | null = null;
  if (health.status !== 'ok') {
    status.note = 'the database is down, so no projects';
  } else {
    try {
      credential = await anyCredential(io, opts);
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      status.note = `no credentials, so no projects: ${err.message.split('\n')[0] ?? ''}`;
    }
  }
  if (credential) {
    const api = createApi(io, opts.url, credential);
    status.credential = describeCredential(credential);
    try {
      status.me = await call(api, 'who am I', getMe({ client: api.client }));
    } catch (err) {
      // Only a rejected owner key from the default location is a soft failure;
      // an explicit key file or an agent token the user chose fails the command.
      if (
        !(err instanceof ApiError && err.status === 401) ||
        credential.kind !== 'owner-key' ||
        isExplicitOwnerKeyFile(io, opts)
      ) {
        throw err;
      }
      status.credential = null;
      status.note = [
        `no projects: ProA at ${opts.url} does not accept the owner key at ${credential.file}`,
        '(it belongs to another ProA instance, e.g. one started with pnpm dev).',
        'ProA in Docker: run the command in the container',
        '  docker compose -p proa2 -f docker/compose.yaml exec proa proa status',
        `or copy the container's key and set ${OWNER_KEY_FILE_ENV} (see docs/proa-2/DEVELOPMENT.md).`,
      ].join('\n');
      credential = null;
    }
  }
  if (credential) {
    const api = createApi(io, opts.url, credential);
    const page = await call(
      api,
      'list projects',
      listProjects({ client: api.client, query: { limit: 200 } }),
    );
    const projects = opts.project
      ? page.items.filter((p) => p.key === opts.project || p.id === opts.project)
      : page.items;
    if (opts.project && projects.length === 0) {
      throw new CliError(
        `project ${opts.project} not found (or not visible to ${status.credential})`,
      );
    }
    for (const p of projects) {
      const view = await call(
        api,
        `read the landscape of ${p.key}`,
        getLandscape({ client: api.client, path: { project: p.key } }),
      );
      status.projects.push(projectStatus(p, view));
    }
    if (page.nextCursor) status.note = 'showing the first 200 projects';
  }
  io.stdout(opts.json ? `${JSON.stringify(status, null, 2)}\n` : formatStatus(status));
  if (health.status !== 'ok') throw new CliError(`ProA at ${opts.url} is not healthy`);
}
