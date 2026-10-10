// The read-only demo's image, Fly.io configuration and deploy workflow (issue
// #3), checked as files: the same base images and pnpm as the product image,
// eval answers kept out of the build context and the runtime image, the seed
// baked in, the Fly settings the docs promise, and a workflow with pinned
// actions and a pinned flyctl that skips without the Fly token.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { parseDemoLink } from '../../src/config.ts';

const root = new URL('../../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

/** The tests' PostgreSQL image (test/global-setup.ts), read as text: no Testcontainers in unit tests. */
const POSTGRES_IMAGE = /POSTGRES_IMAGE = '([^']+)'/.exec(
  read('apps/server/test/global-setup.ts'),
)?.[1];
const product = read('docker/Dockerfile');
const demo = read('docker/Dockerfile.demo');
const arg = (file: string, name: string) => new RegExp(`^ARG ${name}=(\\S+)$`, 'm').exec(file)?.[1];
/** The lines of one build stage (`FROM … AS <name>` up to the next `FROM`). */
function stage(file: string, name: string): string {
  const lines = file.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^FROM \\S+ AS ${name}$`).test(l));
  expect(start, `stage ${name}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('FROM '));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}
/** Patterns of a .dockerignore, comments and blank lines dropped. */
const patterns = (file: string) =>
  read(file)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

describe('docker/Dockerfile.demo', () => {
  it('uses the product image’s frontend, Node and pnpm, and the tests’ PostgreSQL', () => {
    expect(demo.split('\n')[0]).toBe(product.split('\n')[0]);
    expect(arg(demo, 'NODE_IMAGE')).toBe(arg(product, 'NODE_IMAGE'));
    expect(arg(demo, 'PNPM_VERSION')).toBe(arg(product, 'PNPM_VERSION'));
    // postgres:17.11 in compose and the tests; the demo pins the Debian release too.
    expect(POSTGRES_IMAGE).toMatch(/^postgres:17\.\d+$/);
    expect(arg(demo, 'POSTGRES_IMAGE')).toBe(`${POSTGRES_IMAGE}-trixie`);
    expect(arg(demo, 'NODE_IMAGE')).toMatch(/-trixie-slim$/);
    expect(read('docker/compose.yaml')).toContain(`image: ${POSTGRES_IMAGE ?? '?'}\n`);
  });

  it('seeds in the build as an unprivileged user and keeps eval files out of the runtime', () => {
    const seed = stage(demo, 'seed');
    expect(seed).toMatch(/^USER proa$/m);
    expect(seed).toContain('node /app/apps/demo/src/main.ts seed --out /opt/proa-demo');
    expect(seed).toContain('ARG PROA_DEMO_SEED');
    const prodSeed = stage(demo, 'prod-seed');
    expect(prodSeed).toContain('rm -rf eval/corpus/*/expected.yaml eval/corpus/*/README.md');
    expect(prodSeed).toContain(
      'find eval/value-chains -type f ! -name value-chain.vc.json -delete',
    );
    const runtime = stage(demo, 'runtime');
    for (const line of runtime.split('\n').filter((l) => l.startsWith('COPY'))) {
      expect(line, line).not.toMatch(/eval|apps\/cli|apps\/agent-sim/);
    }
    expect(runtime).toContain(
      'test ! -e /app/eval && test ! -e /app/apps/cli && test ! -e /app/apps/agent-sim',
    );
    expect(runtime).toContain('COPY --from=seed --chown=proa:proa /opt/proa-demo /opt/proa-demo');
    expect(runtime).toMatch(/^USER proa$/m);
    expect(runtime).toContain('ENTRYPOINT ["node", "/app/apps/demo/src/main.ts", "serve"]');
    expect(runtime).toContain('PROA_PORT=8080');
    // The demo needs no owner key and no local-mode opt-in.
    expect(demo).not.toMatch(/PROA_ALLOW_NON_LOOPBACK|PROA_OWNER_KEY_FILE=\//);
  });

  it('has a .dockerignore next to it that keeps every exclusion of the product’s', () => {
    const product = patterns('docker/Dockerfile.dockerignore');
    const ignore = patterns('docker/Dockerfile.demo.dockerignore');
    for (const p of product) expect(ignore, p).toContain(p);
    for (const p of [
      'eval/corpus/*/expected.yaml',
      'eval/corpus/*/README.md',
      'eval/corpus/*/spec',
      'eval/recordings',
      'eval/reports',
      'eval/value-chains/**',
      '!eval/value-chains/*/value-chain.vc.json',
    ]) {
      expect(ignore, p).toContain(p);
    }
    // The re-include must come after the exclusion it narrows.
    expect(ignore.indexOf('!eval/value-chains/*/value-chain.vc.json')).toBeGreaterThan(
      ignore.indexOf('eval/value-chains/**'),
    );
  });
});

/** The demo operator's legal pages (owner, 2026-10-10): Miragon's Impressum and privacy policy. */
const LEGAL_LINKS = {
  PROA_DEMO_IMPRINT_URL: 'https://miragon.io/impressum',
  PROA_DEMO_PRIVACY_URL: 'https://miragon.io/datenschutz/',
};

describe('docker/compose.demo.yaml', () => {
  const compose = parse(read('docker/compose.demo.yaml')) as {
    name: string;
    services: Record<
      string,
      {
        build: { dockerfile: string; args?: Record<string, string> };
        image: string;
        ports: string[];
        environment: Record<string, string>;
      }
    >;
  };

  it('runs the demo image as project proa2-demo on loopback, never as proa:local', () => {
    expect(compose.name).toBe('proa2-demo');
    const service = compose.services['demo'];
    expect(service?.build.dockerfile).toBe('docker/Dockerfile.demo');
    // A fresh seed on request; unchanged, the build reuses the cached seed layer.
    expect(service?.build.args).toEqual({ PROA_DEMO_SEED: '${PROA_DEMO_SEED:-local}' });
    expect(service?.image).toBe('${PROA_DEMO_IMAGE:-proa-demo:local}');
    expect(service?.ports).toEqual(['127.0.0.1:${PROA_DEMO_PORT:-7480}:8080']);
    expect(service?.environment['PROA_PUBLIC_ORIGIN']).toContain(
      'http://127.0.0.1:${PROA_DEMO_PORT:-7480}',
    );
  });

  it('sets the same legal links as the Fly.io configuration', () => {
    const environment = compose.services['demo']?.environment ?? {};
    expect(environment['PROA_DEMO_IMPRINT_URL']).toBe(LEGAL_LINKS.PROA_DEMO_IMPRINT_URL);
    expect(environment['PROA_DEMO_PRIVACY_URL']).toBe(LEGAL_LINKS.PROA_DEMO_PRIVACY_URL);
  });
});

describe('docker/fly.demo.toml', () => {
  const toml = read('docker/fly.demo.toml');
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(toml)?.[1];

  it('builds the demo image with its ignore file, never the 1.x Dockerfile', () => {
    expect(value('dockerfile')).toBe('"Dockerfile.demo"');
    expect(value('ignorefile')).toBe('"Dockerfile.demo.dockerignore"');
  });

  it('deploys blue-green behind the /health check on 8080 over https', () => {
    expect(value('strategy')).toBe('"bluegreen"');
    expect(value('internal_port')).toBe('8080');
    expect(value('force_https')).toBe('true');
    expect(toml).toContain('[[http_service.checks]]');
    expect(value('path')).toBe('"/health"');
    expect(value('primary_region')).toBe('"fra"');
  });

  it('suspends idle machines, restarts on failure, and has no swap (suspend needs none)', () => {
    expect(value('auto_stop_machines')).toBe('"suspend"');
    expect(value('auto_start_machines')).toBe('true');
    expect(value('policy')).toBe('"on-failure"');
    expect(value('memory')).toBe('"1gb"');
    expect(toml).not.toMatch(/swap_size_mb|\[mounts\]|\[\[mounts\]\]/);
    expect(value('kill_signal')).toBe('"SIGTERM"');
  });

  it('links the operator’s legal pages in [env], valid for the server', () => {
    const lines = toml.split('\n');
    const start = lines.indexOf('[env]');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((l, i) => i > start && /^\[/.test(l));
    const env = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
    for (const [name, url] of Object.entries(LEGAL_LINKS)) {
      expect(env, name).toMatch(new RegExp(`^\\s*${name} = "${url.replaceAll('.', '\\.')}"$`, 'm'));
      expect(parseDemoLink(url)).toEqual({ url });
    }
    // Nothing secret and nothing that would open the demo: only the links.
    expect(env.split('\n').filter((l) => /^\s*[A-Z_]+ =/.test(l))).toHaveLength(2);
  });
});

describe('.github/workflows/demo-deploy.yml', () => {
  const text = read('.github/workflows/demo-deploy.yml');
  const workflow = parse(text) as {
    on: {
      push: { branches: string[]; paths: string[] };
      workflow_dispatch: { inputs: { action: { options: string[] } } };
    };
    concurrency: { group: string; 'cancel-in-progress': boolean };
    env: Record<string, string>;
    jobs: {
      deploy: {
        'runs-on': string;
        steps: { id?: string; uses?: string; if?: string; run?: string }[];
      };
    };
  };
  const steps = workflow.jobs.deploy.steps;

  it('deploys on pushes to claude/proa-2 and by hand (deploy or restart), one at a time', () => {
    expect(workflow.on.push.branches).toEqual(['claude/proa-2']);
    expect(workflow.on.push.paths).toContain('docker/**');
    expect(workflow.on.workflow_dispatch.inputs.action.options).toEqual(['deploy', 'restart']);
    expect(workflow.concurrency).toEqual({ group: 'demo-deploy', 'cancel-in-progress': false });
    expect(workflow.jobs.deploy['runs-on']).toBe('ubuntu-24.04');
  });

  it('pins every action by commit, as CI 2.0 does', () => {
    const ci = read('.github/workflows/ci-2.yml');
    for (const uses of steps.flatMap((s) => (s.uses ? [s.uses] : []))) {
      expect(uses).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(ci, uses).toContain(uses);
    }
  });

  it('installs a pinned flyctl with its checksum, and skips everything without FLY_API_TOKEN', () => {
    expect(workflow.env['FLYCTL_VERSION']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(workflow.env['FLYCTL_SHA256']).toMatch(/^[0-9a-f]{64}$/);
    expect(text).toContain('sha256sum -c -');
    expect(steps[0]?.id).toBe('fly');
    expect(steps[0]?.run).toContain('::notice title=Demo deploy skipped::');
    for (const step of steps.slice(1)) {
      expect(step.if, step.uses ?? step.run).toMatch(/^steps\.fly\.outputs\.enabled == 'true'/);
    }
    expect(text).toContain('flyctl deploy "$@"');
    expect(text).toContain('--config docker/fly.demo.toml');
    expect(text).toContain('--ha=false');
    // Every run and every re-run seeds afresh: the seed id is the build arg's only input.
    expect(text).toContain('SEED_ID: ${{ github.run_id }}.${{ github.run_attempt }}');
    expect(text).toContain('--build-arg "PROA_DEMO_SEED=$SEED_ID"');
    expect(text).toContain('pnpm --filter @proa/demo check');
  });
});
