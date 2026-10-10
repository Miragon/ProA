/**
 * `proa-demo seed --out <dir>`: builds the demo's database once, while the
 * demo image is built (docker/Dockerfile.demo), as the unprivileged user:
 *
 * 1. `initdb` and PostgreSQL on loopback;
 * 2. the server in normal local mode on loopback (migrations at start, an
 *    owner key in the work directory);
 * 3. `proa seed --value-chains --issue-tokens` of both scored landscapes;
 * 4. the simulation agent (`proa-agent-sim`, both task kinds) per project with
 *    its token: proposals, questions, no-links, placement proposals and
 *    unsure verdicts, derived from claim inputs only (no expected answers);
 * 5. a check that every task is done and the review has something to show;
 * 6. the server stopped, `demo-bootstrap.ts` (the visitor's viewer
 *    memberships, the read-only role), `VACUUM`, PostgreSQL stopped cleanly;
 * 7. the data directory moved to `<out>/pgdata-template`, `<out>/seed.json`.
 *
 * Any failure fails the build, so a broken seed never reaches a deploy. The
 * seed tokens stay (revoking them would withdraw their proposals); the demo
 * accepts no credentials. Secrets are never logged.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PG_SUPERUSER,
  databaseUrl,
  initdb,
  psql,
  startPostgres,
  stopPostgres,
  type PostgresDeps,
} from './postgres.ts';
import { DemoError, childEnv, run, stop, waitFor, type Child } from './processes.ts';

/** The apps the seed runs, next to this package (the same layout in the checkout and the image). */
export const APPS = {
  server: fileURLToPath(new URL('../../server/src/main.ts', import.meta.url)),
  bootstrap: fileURLToPath(new URL('../../server/src/demo-bootstrap.ts', import.meta.url)),
  cli: fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url)),
  agentSim: fileURLToPath(new URL('../../agent-sim/src/main.ts', import.meta.url)),
};

/** The landscapes the demo shows (owner decision 20: both). */
export const DEMO_LANDSCAPES = ['nordwind-handel', 'stadtwerke-auental'] as const;

/** Name of the seed's agent tokens: the agent segment of the proposals' provenance. */
export const SEED_TOKEN_NAME = 'agent-sim';

/** Port of the seed's own local-mode server (loopback, only during the build). */
export const SEED_SERVER_PORT = 7499;

/** The data directory template inside `--out`, and the seed's description. */
export const TEMPLATE_DIR = 'pgdata-template';
export const SEED_INFO = 'seed.json';

export interface SeedDeps extends PostgresDeps {
  fetch: typeof globalThis.fetch;
  log: (line: string) => void;
}

export interface SeedOptions {
  /** Output directory: must be empty or absent. */
  out: string;
  /** Seed id written to `seed.json` (the CI run, or a random id). */
  id?: string;
}

/** Counts per project in `seed.json` and the build log (aggregates only). */
export interface ProjectSeed {
  project: string;
  models: number;
  relations: Record<string, number>;
  agent: {
    relationTasks: number;
    proposals: number;
    questions: number;
    noLinks: number;
    placementTasks: number;
    placements: number;
    unsure: number;
  };
}

export interface SeedInfo {
  id: string;
  createdAt: string;
  projects: ProjectSeed[];
}

interface SeededProject {
  project: string;
  models: number;
  relations: Record<string, number>;
  token: { secret: string } | null;
}

interface SimReport {
  stop: string;
  totals: { failed: number };
  byKind: {
    relations: { tasks: number; proposed: number; questions: number; noLinks: number };
    placement: { tasks: number; proposed: number; unsure: number };
  };
}

function parseJson<T>(what: string, text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DemoError(`${what} printed no JSON`);
  }
}

async function getJson<T>(deps: SeedDeps, url: string, ownerKey: string): Promise<T> {
  const res = await deps.fetch(url, { headers: { authorization: `Bearer ${ownerKey}` } });
  if (!res.ok) throw new DemoError(`GET ${new URL(url).pathname}: ${res.status}`);
  return (await res.json()) as T;
}

/** What the demo must show after the seed; throws with every gap. */
async function verify(
  deps: SeedDeps,
  base: string,
  ownerKey: string,
  seeds: ProjectSeed[],
): Promise<void> {
  const problems: string[] = [];
  for (const s of seeds) {
    const p = encodeURIComponent(s.project);
    for (const state of ['queued', 'claimed', 'failed'] as const) {
      const page = await getJson<{ items: unknown[] }>(
        deps,
        `${base}/api/v1/projects/${p}/analyses?state=${state}&limit=1`,
        ownerKey,
      );
      if (page.items.length > 0) problems.push(`${s.project}: an analysis task is ${state}`);
    }
    const chain = await deps.fetch(`${base}/api/v1/projects/${p}/value-chains/main`, {
      headers: { authorization: `Bearer ${ownerKey}` },
    });
    if (!chain.ok) problems.push(`${s.project}: no value chain (${chain.status})`);
    const a = s.agent;
    if (a.proposals === 0) problems.push(`${s.project}: no agent proposal`);
    if (a.questions === 0) problems.push(`${s.project}: no agent question`);
    if (a.noLinks === 0) problems.push(`${s.project}: no agent no-link`);
    if (a.placements === 0) problems.push(`${s.project}: no placement proposal`);
    if (a.placementTasks === 0) problems.push(`${s.project}: no placement task worked`);
  }
  if (problems.length > 0)
    throw new DemoError(`the seed is incomplete:\n  ${problems.join('\n  ')}`);
}

/**
 * Builds the demo database into `options.out` (see the module comment).
 *
 * @returns what was seeded
 * @throws {DemoError} on any failed step; started processes are stopped first
 */
export async function seedDemo(options: SeedOptions, deps: SeedDeps): Promise<SeedInfo> {
  const out = path.resolve(options.out);
  await mkdir(out, { recursive: true });
  if ((await readdir(out)).length > 0) throw new DemoError(`${out} is not empty`);
  const work = path.join(out, '.seed');
  const dataDir = path.join(work, 'pgdata');
  const socketDir = path.join(work, 'run');
  const ownerKeyFile = path.join(work, 'owner-key');
  await mkdir(socketDir, { recursive: true });
  const base = `http://127.0.0.1:${SEED_SERVER_PORT}`;

  let postgres: Child | null = null;
  let server: Child | null = null;
  try {
    deps.log('demo seed: initdb');
    await initdb(deps, dataDir);
    postgres = await startPostgres(deps, { dataDir, socketDir });
    await psql(deps, `CREATE DATABASE proa`, 'postgres');

    deps.log('demo seed: server in local mode on loopback');
    server = deps.spawn('server', process.execPath, [APPS.server], {
      env: childEnv(deps.env, {
        NODE_ENV: 'production',
        PROA_HOST: '127.0.0.1',
        PROA_PORT: String(SEED_SERVER_PORT),
        PROA_WEB_DIST: '',
        PROA_MIGRATE: 'auto',
        PROA_OWNER_KEY_FILE: ownerKeyFile,
        DATABASE_URL: databaseUrl(PG_SUPERUSER),
      }),
      output: 'inherit',
    });
    await waitFor('the seed server', async () => (await deps.fetch(`${base}/health`)).ok, {
      timeoutMs: 120_000,
      intervalMs: 500,
      child: server,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });

    deps.log(`demo seed: proa seed ${DEMO_LANDSCAPES.join(' ')} --value-chains --issue-tokens`);
    const seeded = parseJson<SeededProject[]>(
      'proa seed',
      await run(
        deps.spawn,
        'proa seed',
        process.execPath,
        [
          APPS.cli,
          'seed',
          ...DEMO_LANDSCAPES,
          '--value-chains',
          '--issue-tokens',
          '--token-name',
          SEED_TOKEN_NAME,
          '--json',
          '--url',
          base,
        ],
        {
          env: childEnv(deps.env, { PROA_OWNER_KEY_FILE: ownerKeyFile }),
          output: 'capture',
        },
      ),
    );
    if (seeded.map((s) => s.project).join(',') !== DEMO_LANDSCAPES.join(',')) {
      throw new DemoError(
        `proa seed created ${seeded.map((s) => s.project).join(', ') || 'nothing'}`,
      );
    }

    const projects: ProjectSeed[] = [];
    for (const s of seeded) {
      if (!s.token?.secret) throw new DemoError(`proa seed issued no token for ${s.project}`);
      deps.log(`demo seed: simulation agent on ${s.project}`);
      const report = parseJson<SimReport>(
        'proa-agent-sim',
        await run(
          deps.spawn,
          `proa-agent-sim ${s.project}`,
          process.execPath,
          [APPS.agentSim, '--url', base, '--project', s.project, '--quiet', '--json'],
          { env: childEnv(deps.env, { PROA_TOKEN: s.token.secret }), output: 'capture' },
        ),
      );
      if (report.totals.failed > 0 || report.stop !== 'no-work') {
        throw new DemoError(
          `proa-agent-sim on ${s.project}: ${report.totals.failed} failed, stopped: ${report.stop}`,
        );
      }
      const r = report.byKind.relations;
      const p = report.byKind.placement;
      projects.push({
        project: s.project,
        models: s.models,
        relations: s.relations,
        agent: {
          relationTasks: r.tasks,
          proposals: r.proposed,
          questions: r.questions,
          noLinks: r.noLinks,
          placementTasks: p.tasks,
          placements: p.proposed,
          unsure: p.unsure,
        },
      });
    }

    const ownerKey = (await readFile(ownerKeyFile, 'utf8')).trim();
    await verify(deps, base, ownerKey, projects);

    deps.log('demo seed: stopping the seed server');
    await stop(server, 'SIGTERM', 15_000);
    server = null;

    deps.log('demo seed: visitor and read-only role (demo-bootstrap)');
    await run(deps.spawn, 'demo-bootstrap', process.execPath, [APPS.bootstrap], {
      env: childEnv(deps.env, { DATABASE_URL: databaseUrl(PG_SUPERUSER) }),
      output: 'inherit',
    });
    await psql(deps, 'VACUUM (FREEZE, ANALYZE)');
    await stopPostgres(postgres);
    postgres = null;

    await rm(ownerKeyFile, { force: true });
    await rename(dataDir, path.join(out, TEMPLATE_DIR));
    await rm(work, { recursive: true, force: true });
    const info: SeedInfo = {
      id: options.id ?? randomUUID(),
      createdAt: new Date().toISOString(),
      projects,
    };
    await writeFile(path.join(out, SEED_INFO), `${JSON.stringify(info, null, 2)}\n`);
    for (const p of projects) {
      const a = p.agent;
      deps.log(
        `demo seed: ${p.project}: ${p.models} models; agent: ${a.proposals} proposals (${a.questions} with a question), ${a.noLinks} no-links, ${a.placements} placements, ${a.unsure} unsure`,
      );
    }
    return info;
  } finally {
    if (server) await stop(server, 'SIGTERM', 15_000);
    if (postgres) await stopPostgres(postgres);
  }
}
