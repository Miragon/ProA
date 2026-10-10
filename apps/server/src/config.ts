import { existsSync } from 'node:fs';
import { isIPv4 } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultOwnerKeyFile } from '@proa/contracts';
import { z } from 'zod';

/** Default database: the Compose service `db` of docker/compose.yaml (project `proa2`). */
export const DEFAULT_DATABASE_URL = 'postgres://proa:proa@127.0.0.1:55432/proa';

/** Built web UI next to the server in the workspace (`apps/web/dist`). */
const WORKSPACE_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

const EnvSchema = z.object({
  PROA_PORT: z.coerce.number().int().min(0).max(65535).default(7400),
  PROA_HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).default(DEFAULT_DATABASE_URL),
  /** v1 knows only `local` (CONCEPT §6); `oidc` arrives with server mode (R1). */
  PROA_AUTH: z.enum(['local']).default('local'),
  /** Directory of the built web UI; empty string disables static serving. */
  PROA_WEB_DIST: z.string().optional(),
  /** Run pending migrations at startup (`auto`) or not (`off`). */
  PROA_MIGRATE: z.enum(['auto', 'off']).default('auto'),
  /**
   * Ports a browser `Origin` on localhost may have (comma-separated). Default:
   * `PROA_PORT` and the Vite dev server (7401). Add the host port when Docker
   * publishes ProA on another one.
   */
  PROA_ORIGIN_PORTS: z
    .string()
    .regex(/^\s*\d{1,5}\s*(,\s*\d{1,5}\s*)*$/, 'comma-separated port numbers')
    .optional(),
  /** Key for session cookies (≥ 32 characters); default: random per process. */
  PROA_SESSION_SECRET: z.string().min(32).optional(),
  /**
   * File of the local owner key (the CLI's credential), created on first
   * start; default `$XDG_STATE_HOME/proa/owner-key` or
   * `~/.local/state/proa/owner-key`. Empty string: no owner key.
   */
  PROA_OWNER_KEY_FILE: z.string().optional(),
  /**
   * Local mode binds to loopback only (CONCEPT §6). `1` allows another
   * `PROA_HOST`, for a container that listens on 0.0.0.0 while its port is
   * published on 127.0.0.1 only (docker/compose.yaml); the server warns.
   */
  PROA_ALLOW_NON_LOOPBACK: z.enum(['0', '1']).default('0'),
  /**
   * `readonly`: the public read-only demo (issue #3, CONCEPT §6): every write
   * answers 403 `demo-readonly`, the session is a viewer, MCP, agent tokens
   * and the owner key are off. Unset: local mode, unchanged.
   */
  PROA_DEMO: z.enum(['readonly']).optional(),
  /**
   * The demo's public origins (comma-separated, e.g. `https://proa-demo.fly.dev`):
   * the Host and Origin checks accept them instead of localhost. Demo only.
   */
  PROA_PUBLIC_ORIGIN: z.string().optional(),
});

type Env = z.infer<typeof EnvSchema>;

/** True for `localhost`, `::1` (also bracketed) and 127.0.0.0/8. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || (isIPv4(h) && h.startsWith('127.'));
}

/** Port of the Vite dev server (`pnpm dev`), an allowed origin by default. */
export const VITE_DEV_PORT = 7401;

export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  authMode: 'local';
  /** Absolute path of the built web UI, or `null` if there is none. */
  webDist: string | null;
  migrateOnStart: boolean;
  /** Ports accepted in a localhost `Origin` header. */
  originPorts: number[];
  /** Key for session cookies; `null`: random per process. */
  sessionSecret: string | null;
  /** Absolute path of the local owner key file; `null`: the CLI cannot act as the owner. */
  ownerKeyFile: string | null;
  /** `PROA_ALLOW_NON_LOOPBACK=1`: local mode may bind a non-loopback `host`. */
  allowNonLoopback: boolean;
  /**
   * `PROA_DEMO=readonly` (issue #3): the read-only demo and the public origins
   * it is served from; `null` in local mode.
   */
  demo: DemoConfig | null;
}

/** The read-only demo (`PROA_DEMO=readonly`). */
export interface DemoConfig {
  /** Canonical origins (`https://host[:port]`, or `http://` on a loopback host), deduplicated. */
  publicOrigins: string[];
}

/** Thrown for invalid environment variables; the message lists every problem. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Reads the server configuration from environment variables:
 * `PROA_PORT` (7400), `PROA_HOST` (127.0.0.1), `DATABASE_URL`
 * ({@link DEFAULT_DATABASE_URL}), `PROA_AUTH` (`local`), `PROA_WEB_DIST`
 * (default `apps/web/dist` if it exists), `PROA_MIGRATE` (`auto`),
 * `PROA_ORIGIN_PORTS` (`PROA_PORT,7401`), `PROA_SESSION_SECRET` (random),
 * `PROA_OWNER_KEY_FILE` (`~/.local/state/proa/owner-key`),
 * `PROA_ALLOW_NON_LOOPBACK` (`0`), and for the read-only demo `PROA_DEMO`
 * (unset) and `PROA_PUBLIC_ORIGIN` (demo only).
 *
 * @throws {ConfigError} if a variable is invalid, if local mode would bind a
 *   non-loopback address without `PROA_ALLOW_NON_LOOPBACK=1`, if
 *   `PROA_PUBLIC_ORIGIN` is set outside the demo, or if the demo is combined
 *   with anything that would let a visitor write
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`invalid configuration:\n  ${lines.join('\n  ')}`);
  }
  const e = parsed.data;
  if (e.PROA_DEMO === 'readonly') return loadDemoConfig(e, env);
  if (e.PROA_PUBLIC_ORIGIN !== undefined) {
    throw new ConfigError(
      'PROA_PUBLIC_ORIGIN is set without PROA_DEMO=readonly: only the read-only demo has a public ' +
        'origin (server mode with a login is R1). Local mode serves localhost only.',
    );
  }
  const allowNonLoopback = e.PROA_ALLOW_NON_LOOPBACK === '1';
  if (e.PROA_AUTH === 'local' && !isLoopbackHost(e.PROA_HOST) && !allowNonLoopback) {
    throw new ConfigError(
      [
        `PROA_HOST=${e.PROA_HOST} is not a loopback address. Local mode has no login: whoever`,
        'reaches the port can open an owner session, so it listens on 127.0.0.1 only (CONCEPT §6).',
        'Unset PROA_HOST, or, in a container whose port is published on 127.0.0.1 only',
        '(docker run -p 127.0.0.1:7400:7400 …, as docker/compose.yaml does), set PROA_ALLOW_NON_LOOPBACK=1.',
      ].join('\n  '),
    );
  }
  return {
    port: e.PROA_PORT,
    host: e.PROA_HOST,
    databaseUrl: e.DATABASE_URL,
    authMode: e.PROA_AUTH,
    webDist: webDistOf(e),
    migrateOnStart: e.PROA_MIGRATE === 'auto',
    originPorts: e.PROA_ORIGIN_PORTS
      ? [...new Set(e.PROA_ORIGIN_PORTS.split(',').map((p) => Number(p.trim())))]
      : [...new Set([e.PROA_PORT, VITE_DEV_PORT])],
    sessionSecret: e.PROA_SESSION_SECRET ?? null,
    ownerKeyFile:
      e.PROA_OWNER_KEY_FILE === undefined
        ? defaultOwnerKeyFile(env, os.homedir())
        : e.PROA_OWNER_KEY_FILE === ''
          ? null
          : path.resolve(e.PROA_OWNER_KEY_FILE),
    allowNonLoopback,
    demo: null,
  };
}

function webDistOf(e: Env): string | null {
  if (e.PROA_WEB_DIST === undefined) {
    return existsSync(path.join(WORKSPACE_WEB_DIST, 'index.html')) ? WORKSPACE_WEB_DIST : null;
  }
  return e.PROA_WEB_DIST === '' ? null : path.resolve(e.PROA_WEB_DIST);
}

/**
 * Parses `PROA_PUBLIC_ORIGIN`: comma-separated origins, each exactly in its
 * canonical form (`new URL(o).origin === o`: lower-case host, no default
 * port, no path, query or trailing slash), `https:`, or `http:` on a
 * loopback host for local runs of the demo image.
 *
 * @returns the deduplicated origins, or the problems found
 */
export function parsePublicOrigins(value: string): { origins: string[]; problems: string[] } {
  const origins: string[] = [];
  const problems: string[] = [];
  for (const raw of value.split(',').map((o) => o.trim())) {
    if (raw === '') {
      problems.push('an empty origin');
      continue;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`${raw}: not a URL`);
      continue;
    }
    if (url.origin !== raw) {
      problems.push(`${raw}: write the bare origin ${url.origin} (no path, no trailing slash)`);
    } else if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && isLoopbackHost(url.hostname))
    ) {
      problems.push(`${raw}: must be https (http only on a loopback host)`);
    } else if (!origins.includes(raw)) {
      origins.push(raw);
    }
  }
  return { origins, problems };
}

/**
 * The read-only demo (issue #3): a variant of local mode for public hosting.
 * It needs its public origins and refuses everything that would let a
 * visitor write or act as the owner: an owner key file, extra localhost
 * origin ports, `PROA_ALLOW_NON_LOOPBACK` (a non-loopback `PROA_HOST` needs
 * no opt-in here, since nothing can be changed), and migrations at start
 * (the database is prepared before; `PROA_MIGRATE` defaults to `off`).
 */
function loadDemoConfig(e: Env, env: Record<string, string | undefined>): Config {
  const problems: string[] = [];
  const { origins, problems: originProblems } =
    e.PROA_PUBLIC_ORIGIN === undefined
      ? {
          origins: [],
          problems: ['PROA_PUBLIC_ORIGIN is required (e.g. https://proa-demo.fly.dev)'],
        }
      : parsePublicOrigins(e.PROA_PUBLIC_ORIGIN);
  problems.push(
    ...originProblems.map((p) => (p.startsWith('PROA_') ? p : `PROA_PUBLIC_ORIGIN: ${p}`)),
  );
  if (origins.length === 0 && originProblems.length === 0) {
    problems.push('PROA_PUBLIC_ORIGIN names no origin');
  }
  if (env['PROA_OWNER_KEY_FILE'] !== undefined && env['PROA_OWNER_KEY_FILE'] !== '') {
    problems.push('PROA_OWNER_KEY_FILE: the demo has no owner key; leave it unset or empty');
  }
  if (env['PROA_ORIGIN_PORTS'] !== undefined) {
    problems.push('PROA_ORIGIN_PORTS: localhost origins are local mode; use PROA_PUBLIC_ORIGIN');
  }
  if (e.PROA_ALLOW_NON_LOOPBACK === '1') {
    problems.push('PROA_ALLOW_NON_LOOPBACK=1 is a local-mode opt-in; the demo needs none');
  }
  if (env['PROA_MIGRATE'] === 'auto') {
    problems.push(
      'PROA_MIGRATE=auto: the demo database is read-only and migrated before; leave it unset or off',
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(
      `invalid read-only demo configuration (PROA_DEMO=readonly):\n  ${problems.join('\n  ')}`,
    );
  }
  return {
    port: e.PROA_PORT,
    host: e.PROA_HOST,
    databaseUrl: e.DATABASE_URL,
    authMode: e.PROA_AUTH,
    webDist: webDistOf(e),
    migrateOnStart: false,
    originPorts: [],
    sessionSecret: e.PROA_SESSION_SECRET ?? null,
    ownerKeyFile: null,
    allowNonLoopback: false,
    demo: { publicOrigins: origins },
  };
}
