import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

import type { Exit, Spawn, Spawned } from '../src/processes.ts';

export interface SpawnCall {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface FakeChild extends Spawned {
  /** Signals the child received, in order. */
  signals: NodeJS.Signals[];
  /** Ends the child as if it exited on its own. */
  exit(exit: Exit): void;
}

/** What a fake command does when spawned: its stdout and exit, or `long` (runs until killed). */
export type Behaviour =
  | { long: true; onStart?: (call: SpawnCall) => Promise<void> | void }
  | { stdout?: string; exit?: Exit; onStart?: (call: SpawnCall) => Promise<void> | void };

/**
 * A spawner that runs nothing: each call is recorded, and the child behaves
 * as `behaviour(call)` says. Long-running children end on SIGTERM, SIGINT or
 * SIGKILL with that signal.
 */
export function fakeSpawn(behaviour: (call: SpawnCall) => Behaviour): {
  spawn: Spawn;
  calls: SpawnCall[];
  children: Map<string, FakeChild>;
  /** `<name> <signal>` of every kill, across children, in order. */
  kills: string[];
} {
  const calls: SpawnCall[] = [];
  const kills: string[] = [];
  const children = new Map<string, FakeChild>();
  const spawn: Spawn = (name, command, args, options) => {
    const call = { name, command, args, env: options.env };
    calls.push(call);
    const b = behaviour(call);
    let resolveExit: (exit: Exit) => void = () => undefined;
    const exited = new Promise<Exit>((resolve) => {
      resolveExit = resolve;
    });
    let done = false;
    const signals: NodeJS.Signals[] = [];
    const end = (exit: Exit) => {
      if (done) return;
      done = true;
      resolveExit(exit);
    };
    const started = Promise.resolve(b.onStart?.(call));
    let stdout = '';
    if (!('long' in b)) {
      stdout = b.stdout ?? '';
      void started.then(() => end(b.exit ?? { code: 0, signal: null }));
    }
    const child: FakeChild = {
      name,
      exited,
      stdout: exited.then(() => stdout),
      signals,
      kill(signal) {
        signals.push(signal);
        if (!done) kills.push(`${name} ${signal}`);
        if ('long' in b) end({ code: null, signal });
      },
      exit: end,
    };
    children.set(name, child);
    return child;
  };
  return { spawn, calls, children, kills };
}

/** Marks the data directory ready as a started `postgres` would (`postmaster.pid`). */
export function fakePostgresReady(call: SpawnCall): void {
  const dir = call.args[call.args.indexOf('-D') + 1];
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/postmaster.pid`, '1\n/data\n0\n5432\n/run\n127.0.0.1\n0 0\nready   \n');
  }
}

/** Creates the data directory as `initdb` would, so the seed can move it. */
export async function fakeInitdb(call: SpawnCall): Promise<void> {
  const dir = call.args[call.args.indexOf('-D') + 1];
  if (dir) {
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/PG_VERSION`, '17\n');
  }
}

export interface FakeRoute {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers from `routes` (`METHOD path`, query ignored) and records every call. */
export function fakeFetch(
  routes: (method: string, path: string, init: RequestInit) => FakeRoute | undefined,
): {
  fetch: typeof globalThis.fetch;
  calls: { method: string; path: string; init: RequestInit }[];
} {
  const calls: { method: string; path: string; init: RequestInit }[] = [];
  const fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, path: url.pathname, init });
    const route = routes(method, url.pathname + url.search, init) ?? {
      status: 404,
      body: { code: 'not-found' },
    };
    return Promise.resolve(
      new Response(route.body === undefined ? null : JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json', ...route.headers },
      }),
    );
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
