/**
 * Child processes of the demo supervisor behind a small interface, so the
 * seed and serve orchestration can be tested with a fake spawner.
 */
import { spawn as nodeSpawn } from 'node:child_process';

/** How a child process ended. */
export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface Child {
  /** A short name for logs (`postgres`, `server`, …). */
  readonly name: string;
  /** Resolves once the process has exited (never rejects). */
  readonly exited: Promise<Exit>;
  /** Sends a signal; a process that already exited is left alone. */
  kill(signal: NodeJS.Signals): void;
}

export interface SpawnOptions {
  /** The complete environment of the child (nothing is inherited implicitly). */
  env: Record<string, string>;
  /** `inherit`: output goes to the supervisor's; `capture`: stdout is collected, stderr inherited. */
  output: 'inherit' | 'capture';
}

export interface Spawned extends Child {
  /** With `output: 'capture'`: the child's stdout once it exited. */
  readonly stdout: Promise<string>;
}

export type Spawn = (
  name: string,
  command: string,
  args: string[],
  options: SpawnOptions,
) => Spawned;

/** The real spawner (`node:child_process`). */
export const spawnProcess: Spawn = (name, command, args, options) => {
  const child = nodeSpawn(command, args, {
    env: options.env,
    stdio: ['ignore', options.output === 'capture' ? 'pipe' : 'inherit', 'inherit'],
  });
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  const exited = new Promise<Exit>((resolve) => {
    child.once('error', (err) => {
      console.error(`${name}: ${err.message}`);
      resolve({ code: 127, signal: null });
    });
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return {
    name,
    exited,
    stdout: exited.then(() => Buffer.concat(chunks).toString('utf8')),
    kill(signal) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    },
  };
};

/** Thrown when a step of the supervisor fails; the message says which. */
export class DemoError extends Error {
  override readonly name = 'DemoError';
}

function describeExit(exit: Exit): string {
  return exit.signal ? `signal ${exit.signal}` : `exit code ${String(exit.code)}`;
}

/**
 * Runs a command to its end; resolves with its stdout (`capture`) or `''`.
 *
 * @throws {DemoError} unless it exits with code 0
 */
export async function run(
  spawn: Spawn,
  name: string,
  command: string,
  args: string[],
  options: SpawnOptions,
): Promise<string> {
  const child = spawn(name, command, args, options);
  const exit = await child.exited;
  if (exit.code !== 0) throw new DemoError(`${name} failed (${describeExit(exit)})`);
  return child.stdout;
}

/**
 * Stops a child: `signal`, then SIGKILL after `graceMs`.
 *
 * @returns how it ended
 */
export async function stop(child: Child, signal: NodeJS.Signals, graceMs: number): Promise<Exit> {
  child.kill(signal);
  let timer: NodeJS.Timeout | undefined;
  const killed = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), graceMs);
  });
  const first = await Promise.race([child.exited, killed]);
  clearTimeout(timer);
  if (first !== 'timeout') return first;
  console.error(`${child.name} did not stop within ${graceMs} ms; killing it`);
  child.kill('SIGKILL');
  return child.exited;
}

export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  /** Fails the wait at once when this child exits first. */
  child?: Child;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Polls `ready` until it returns true.
 *
 * @throws {DemoError} after `timeoutMs`, or when `child` exits while waiting
 */
export async function waitFor(
  what: string,
  ready: () => Promise<boolean>,
  options: WaitOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const pause = options.sleep ?? sleep;
  const deadline = now() + options.timeoutMs;
  let exited: Exit | null = null;
  void options.child?.exited.then((exit) => {
    exited = exit;
  });
  for (;;) {
    if (exited)
      throw new DemoError(
        `${options.child?.name ?? what} exited while waiting for ${what} (${describeExit(exited)})`,
      );
    if (await ready().catch(() => false)) return;
    if (now() >= deadline)
      throw new DemoError(`timed out after ${options.timeoutMs} ms waiting for ${what}`);
    await pause(options.intervalMs);
  }
}

/** The variables a child may inherit from the supervisor; everything else is set explicitly. */
const INHERITED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR'] as const;

/** A clean child environment: {@link INHERITED} from `env`, plus `extra`. */
export function childEnv(
  env: Record<string, string | undefined>,
  extra: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of INHERITED) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return { ...out, ...extra };
}
