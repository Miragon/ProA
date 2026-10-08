// The runtime is pinned exactly and in one version everywhere: CI reads
// .node-version, the image uses NODE_IMAGE, and pnpm comes from packageManager.
// Dependencies are pinned exactly too and come from the registry: no link:,
// file:, portal:, tarball or Git specifiers in any workspace package.json or in
// pnpm-lock.yaml (M4 §5); workspace: stays for the workspace's own packages.
// The value chain packages, diagram-js and zod v4 are locked in one version
// each, and every pin of a value chain package names it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = new URL('../../../../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

describe('runtime pins', () => {
  const nodeVersion = read('.node-version').trim();
  const dockerfile = read('docker/Dockerfile');
  const pkg = JSON.parse(read('package.json')) as {
    packageManager: string;
    engines: { node: string };
  };

  it('pins Node exactly, the same in .node-version (CI) and the Docker image', () => {
    expect(nodeVersion).toMatch(/^24\.\d+\.\d+$/);
    expect(dockerfile).toContain(`ARG NODE_IMAGE=node:${nodeVersion}-`);
    expect(pkg.engines.node).toBe('>=24');
  });

  it('pins pnpm and the Dockerfile frontend exactly', () => {
    const pnpm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager)?.[1];
    expect(pnpm).toBeDefined();
    expect(dockerfile).toContain(`ARG PNPM_VERSION=${pnpm}`);
    expect(dockerfile.split('\n')[0]).toMatch(/^# syntax=docker\/dockerfile:\d+\.\d+\.\d+$/);
  });
});

// ---------------------------------------------------------------------------------------
// Dependency specifiers

const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

/** Why a dependency specifier is not allowed, or null for an exact version or workspace:. */
function specifierProblem(
  name: string,
  spec: string,
  internal: ReadonlySet<string>,
): string | null {
  if (EXACT.test(spec)) return null;
  if (spec.startsWith('workspace:')) {
    return internal.has(name) ? null : 'workspace: for a package outside the workspace';
  }
  for (const protocol of ['link:', 'file:', 'portal:']) {
    if (spec.startsWith(protocol)) return `${protocol} specifier`;
  }
  if (/^(?:https?:|git[+:]|github:)/.test(spec) || /\.(?:tgz|tar\.gz|tar)$/.test(spec)) {
    return 'tarball or Git specifier';
  }
  return 'not an exact version';
}

interface Manifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface LockDependency {
  specifier: string;
  version: string;
}

interface Lockfile {
  lockfileVersion: string;
  overrides?: Record<string, string>;
  importers: Record<string, Partial<Record<string, Record<string, LockDependency>>>>;
  packages: Record<string, { resolution: Record<string, unknown> }>;
  snapshots: Record<string, Partial<Record<string, Record<string, string>>> | null>;
}

const workspace = parse(read('pnpm-workspace.yaml')) as {
  packages: string[];
  overrides?: Record<string, string>;
};

/** Workspace package directories relative to the root ('.' is the root package). */
function workspaceDirs(): string[] {
  const dirs = ['.'];
  for (const pattern of workspace.packages) {
    const parent = pattern.endsWith('/*') ? pattern.slice(0, -2) : null;
    const candidates = parent
      ? readdirSync(new URL(`${parent}/`, root)).map((entry) => `${parent}/${entry}`)
      : [pattern];
    dirs.push(...candidates.filter((dir) => existsSync(new URL(`${dir}/package.json`, root))));
  }
  return dirs.sort();
}

describe('dependency specifiers', () => {
  const dirs = workspaceDirs();
  const manifests = new Map(
    dirs.map((dir) => [dir, JSON.parse(read(`${dir}/package.json`)) as Manifest]),
  );
  const internal = new Set(
    [...manifests.values()].flatMap((manifest) => (manifest.name ? [manifest.name] : [])),
  );
  const dirOf = new Map([...manifests].map(([dir, manifest]) => [manifest.name, dir]));
  const lock = parse(read('pnpm-lock.yaml')) as Lockfile;

  it('classifies the forbidden forms', () => {
    const problem = (spec: string, name = 'x') => specifierProblem(name, spec, internal);
    expect(problem('1.2.3')).toBeNull();
    expect(problem('1.2.3-rc.1')).toBeNull();
    expect(problem('workspace:0.0.0', '@proa/contracts')).toBeNull();
    expect(problem('workspace:0.0.0', 'left-pad')).toMatch(/outside the workspace/);
    expect(problem('link:../value-chain-modeler/packages/renderer')).toBe('link: specifier');
    expect(problem('file:../vc-renderer-0.3.0.tgz')).toBe('file: specifier');
    expect(problem('portal:../value-chain-modeler')).toBe('portal: specifier');
    expect(problem('https://registry.npmjs.org/x/-/x-1.0.0.tgz')).toMatch(/tarball/);
    expect(problem('./vendor/x-1.0.0.tgz')).toMatch(/tarball/);
    expect(problem('github:Miragon/value-chain-modeler')).toMatch(/Git/);
    expect(problem('^1.2.3')).toBe('not an exact version');
    expect(problem('npm:zod@4.6.5')).toBe('not an exact version');
  });

  it('finds every workspace package', () => {
    expect(dirs).toContain('apps/server');
    expect(dirs).toContain('apps/web');
    expect(dirs).toContain('eval/tools');
    expect(Object.keys(lock.importers).sort()).toEqual(dirs);
  });

  it('every workspace package.json pins exact versions or workspace:', () => {
    const problems: string[] = [];
    for (const [dir, manifest] of manifests) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
          const problem = specifierProblem(name, spec, internal);
          if (problem)
            problems.push(`${dir}/package.json ${field}.${name}: "${spec}" (${problem})`);
        }
      }
    }
    for (const [name, spec] of Object.entries(workspace.overrides ?? {})) {
      if (!EXACT.test(spec)) problems.push(`pnpm-workspace.yaml overrides.${name}: "${spec}"`);
    }
    expect(problems).toEqual([]);
  });

  it('pnpm-lock.yaml resolves every package from the registry at its exact pin', () => {
    expect(lock.lockfileVersion).toBe('9.0');
    const problems: string[] = [];
    for (const [name, spec] of Object.entries(lock.overrides ?? {})) {
      if (!EXACT.test(spec)) problems.push(`overrides.${name}: "${spec}"`);
    }
    for (const [importer, groups] of Object.entries(lock.importers)) {
      for (const [field, deps] of Object.entries(groups)) {
        for (const [name, { specifier, version }] of Object.entries(deps ?? {})) {
          const where = `importers.${importer}.${field}.${name}`;
          const problem = specifierProblem(name, specifier, internal);
          if (problem) {
            problems.push(`${where}: specifier "${specifier}" (${problem})`);
          } else if (specifier.startsWith('workspace:')) {
            // pnpm locks a workspace dependency as a link to the package's directory.
            const target = dirOf.get(name);
            const link = target && `link:${posix.relative(importer, target)}`;
            if (version !== link) problems.push(`${where}: "${version}" is not ${link}`);
          } else if (version !== specifier && !version.startsWith(`${specifier}(`)) {
            problems.push(`${where}: resolved "${version}", pinned "${specifier}"`);
          }
        }
      }
    }
    const nameAtExact = /^(?:@[^/@]+\/)?[^/@]+@(.+)$/;
    for (const [key, { resolution }] of Object.entries(lock.packages)) {
      const version = nameAtExact.exec(key)?.[1] ?? '';
      if (!EXACT.test(version)) problems.push(`packages.${key}: not <name>@<exact version>`);
      // A registry package is locked by its integrity alone; tarball, directory and Git
      // resolutions carry tarball, directory, repo or commit.
      if (Object.keys(resolution).join() !== 'integrity') {
        problems.push(`packages.${key}: resolution ${JSON.stringify(resolution)}`);
      }
    }
    // Snapshot dependencies: an exact version (or an npm alias name@version) plus peer suffixes.
    const snapshotVersion =
      /^(?:(?:@[^/@]+\/)?[^/@]+@)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\(.+\))*$/;
    for (const [key, snapshot] of Object.entries(lock.snapshots)) {
      for (const [field, deps] of Object.entries(snapshot ?? {})) {
        if (field !== 'dependencies' && field !== 'optionalDependencies') continue;
        for (const [name, version] of Object.entries(deps ?? {})) {
          if (!snapshotVersion.test(version)) {
            problems.push(`snapshots.${key}.${field}.${name}: "${version}"`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('locks one release of the value chain packages, diagram-js and zod v4, and every pin names it', () => {
    // M4 §5. The server stores what its schema-model serializes, the web validates with its own
    // copy and the renderer's, the validator checks the golden chains with the eval/tools pin:
    // all of them must be the same release. bpmn-js and the renderer share one diagram-js, and
    // the server and the schema-model one zod v4 (zod 3.25.76 is shadcn's CLI's).
    const lockedVersions = (name: string) =>
      Object.keys(lock.packages)
        .filter((key) => key.startsWith(`${name}@`))
        .map((key) => key.slice(name.length + 1));
    const candidates: Record<string, string[]> = {
      '@miragon/value-chain-schema-model': lockedVersions('@miragon/value-chain-schema-model'),
      '@miragon/value-chain-renderer': lockedVersions('@miragon/value-chain-renderer'),
      'diagram-js': lockedVersions('diagram-js'),
      'diagram-js-direct-editing': lockedVersions('diagram-js-direct-editing'),
      'zod 4.x': lockedVersions('zod').filter((version) => version.startsWith('4.')),
    };
    const problems: string[] = [];
    const locked = new Map<string, string>();
    for (const [name, versions] of Object.entries(candidates)) {
      const [version, ...more] = versions;
      if (version !== undefined && more.length === 0) locked.set(name, version);
      else problems.push(`packages: ${name} locked as [${versions.join(', ')}], expected one`);
    }
    for (const [dir, manifest] of manifests) {
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
          if (!name.startsWith('@miragon/value-chain-')) continue;
          const version = locked.get(name);
          if (spec !== version) {
            problems.push(`${dir}/package.json ${field}.${name}: "${spec}", locked ${version}`);
          }
        }
      }
    }
    const dependenciesOf = (name: string) =>
      lock.snapshots[`${name}@${locked.get(name)}`]?.dependencies ?? {};
    const schemaModel = locked.get('@miragon/value-chain-schema-model');
    const rendererSchemaModel = dependenciesOf('@miragon/value-chain-renderer')[
      '@miragon/value-chain-schema-model'
    ];
    if (rendererSchemaModel !== schemaModel) {
      problems.push(`the renderer uses schema-model ${rendererSchemaModel}, not ${schemaModel}`);
    }
    const serverZod = lock.importers['apps/server']?.dependencies?.zod?.version;
    const schemaModelZod = dependenciesOf('@miragon/value-chain-schema-model').zod;
    if (schemaModelZod !== serverZod) {
      problems.push(`the schema-model uses zod ${schemaModelZod}, the server ${serverZod}`);
    }
    expect(problems).toEqual([]);
  });
});
