/**
 * `proa-demo`: the public read-only demo's command line (issue #3).
 *
 *   proa-demo seed --out /opt/proa-demo [--id <seed id>]   (image build, docker/Dockerfile.demo)
 *   proa-demo serve [--seed-dir /opt/proa-demo] [--run-dir /tmp/proa-demo]   (the container's entry point)
 *   proa-demo check --url https://proa-demo.fly.dev [--wait <seconds>] [--json]
 *
 * Commands load their module on demand, so `serve` needs Node built-ins only.
 */
import { parseArgs } from 'node:util';

import { spawnProcess } from './processes.ts';

const USAGE = `usage:
  proa-demo seed --out <dir> [--id <seed id>]
  proa-demo serve [--seed-dir <dir>] [--run-dir <dir>]
  proa-demo check --url <url> [--wait <seconds>] [--project <key>]... [--json]
`;

export interface DemoIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
}

const processIo: DemoIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  env: process.env,
};

function onSignal(handler: (signal: NodeJS.Signals) => void): () => void {
  const listener = (signal: NodeJS.Signals) => handler(signal);
  process.on('SIGTERM', listener);
  process.on('SIGINT', listener);
  return () => {
    process.off('SIGTERM', listener);
    process.off('SIGINT', listener);
  };
}

/** Runs the command line; returns the exit code (0 ok, 1 failure, 2 usage). Never throws. */
export async function runDemo(argv: readonly string[], io: DemoIo = processIo): Promise<number> {
  const [command, ...rest] = argv;
  const log = (line: string) => io.stderr(`${line}\n`);
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      allowPositionals: false,
      options: {
        out: { type: 'string' },
        id: { type: 'string' },
        'seed-dir': { type: 'string' },
        'run-dir': { type: 'string' },
        url: { type: 'string' },
        wait: { type: 'string' },
        project: { type: 'string', multiple: true },
        json: { type: 'boolean' },
      },
    }));
  } catch (err) {
    io.stderr(`proa-demo: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  try {
    switch (command) {
      case 'seed': {
        const out = values['out'];
        if (typeof out !== 'string') break;
        const { seedDemo } = await import('./seed.ts');
        const id = values['id'];
        await seedDemo(
          { out, ...(typeof id === 'string' && id !== '' ? { id } : {}) },
          { spawn: spawnProcess, env: io.env, fetch: globalThis.fetch, log },
        );
        return 0;
      }
      case 'serve': {
        const { DEFAULT_RUN_DIR, DEFAULT_SEED_DIR, serveDemo } = await import('./serve.ts');
        const seedDir = values['seed-dir'];
        const runDir = values['run-dir'];
        return await serveDemo(
          {
            seedDir: typeof seedDir === 'string' ? seedDir : DEFAULT_SEED_DIR,
            runDir: typeof runDir === 'string' ? runDir : DEFAULT_RUN_DIR,
          },
          { spawn: spawnProcess, env: io.env, log, onSignal },
        );
      }
      case 'check': {
        const url = values['url'];
        if (typeof url !== 'string') break;
        const wait = Number(values['wait'] ?? 0);
        if (!Number.isInteger(wait) || wait < 0) break;
        const { checkDemo, waitForDemo } = await import('./check.ts');
        const projects = values['project'];
        const options = { url, ...(Array.isArray(projects) ? { projects } : {}) };
        if (wait > 0 && !(await waitForDemo({ ...options, waitSeconds: wait }))) {
          io.stderr(`proa-demo check: ${url} reported no read-only demo within ${wait} s\n`);
          return 1;
        }
        const result = await checkDemo(options);
        if (values['json']) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
        else {
          io.stdout(
            `${result.url}: ${result.passed} checks passed, ${result.failures.length} failed\n`,
          );
          for (const f of result.failures) io.stdout(`  FAIL ${f}\n`);
        }
        return result.failures.length === 0 ? 0 : 1;
      }
      default:
        break;
    }
  } catch (err) {
    io.stderr(`proa-demo ${command ?? ''}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  io.stderr(USAGE);
  return 2;
}
