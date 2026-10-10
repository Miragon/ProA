// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';
import { build, type Plugin, type UserConfig } from 'vite';

/**
 * The bundle guard of the value chain page (M4 §5, moved from S0 to S3): two
 * production builds of the web app into memory (as `pnpm build` makes them),
 * reading the module ids of every chunk.
 *
 * 1. One copy each of diagram-js, zod v4 (no zod v3), the renderer and
 *    schema-model in the web chunks.
 * 2. The entry chunk and its static imports hold none of them, nor the chain
 *    page, its components or the step view: those load with their routes.
 *    The entry stays under a gzip ceiling, so a page that slips into it shows.
 * 3. The main CSS has no `.vc-` rule (the renderer's CSS comes with the chunk).
 * 4. Budget: with the diagram-js (+ diagram-js-direct-editing) dependency
 *    closure split into a shared chunk, the code only the chain canvas (and
 *    the import's document check, which shares schema-model and zod with it)
 *    loads is at most 40 KB gzip. It counts the chunks reachable from those
 *    two dynamic imports and from no other entry: the page's route chunk is an
 *    entry of its own, so panels, dialogs and the save logic there do not
 *    count; only what the canvas module itself pulls in does (zod, the
 *    renderer and schema-model take about 35 KB). Raising the budget is an
 *    owner decision.
 */

const WEB = resolve(import.meta.dirname, '..');
const BUDGET = 40 * 1024;
/**
 * The entry chunk with its static imports, gzip (Node's default level): 192.9 KB
 * measured after the S3 review moved the value chain routes out of it. Raise
 * it on purpose, with the new measurement, when the app shell grows.
 */
const ENTRY_CEILING = 200 * 1024;

interface ChunkInfo {
  fileName: string;
  code: string;
  moduleIds: string[];
  isEntry: boolean;
  isDynamicEntry: boolean;
  facadeModuleId: string | null;
  imports: string[];
  dynamicImports: string[];
  importedCss: string[];
}

interface BuildReport {
  chunks: ChunkInfo[];
  css: Map<string, string>;
}

const outDirs: string[] = [];
afterAll(() => {
  for (const dir of outDirs) rmSync(dir, { recursive: true, force: true });
});

async function buildReport(extra: UserConfig['build'] = {}): Promise<BuildReport> {
  const report: BuildReport = { chunks: [], css: new Map() };
  const collect: Plugin = {
    name: 'proa-bundle-report',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          const meta = (item as { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata;
          report.chunks.push({
            fileName: item.fileName,
            code: item.code,
            moduleIds: [...item.moduleIds],
            isEntry: item.isEntry,
            isDynamicEntry: item.isDynamicEntry,
            facadeModuleId: item.facadeModuleId,
            imports: [...item.imports],
            dynamicImports: [...item.dynamicImports],
            importedCss: [...(meta?.importedCss ?? [])],
          });
        } else if (item.fileName.endsWith('.css')) {
          report.css.set(
            item.fileName,
            typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source),
          );
        }
      }
    },
  };
  const outDir = mkdtempSync(join(tmpdir(), 'proa-web-bundle-'));
  outDirs.push(outDir);
  // vitest sets NODE_ENV=test, which builds React's development code and JSX into the bundle;
  // measure what `pnpm build` ships.
  const nodeEnv = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    await build({
      root: WEB,
      configFile: join(WEB, 'vite.config.ts'),
      logLevel: 'silent',
      mode: 'production',
      plugins: [collect],
      build: { outDir, write: false, emptyOutDir: false, ...extra },
    });
  } finally {
    process.env['NODE_ENV'] = nodeEnv;
  }
  return report;
}

/** `node_modules/.pnpm/<name>@<version>/…` directories of a package in module ids. */
function versionsOf(ids: readonly string[], name: string): Set<string> {
  const pattern = new RegExp(`[\\\\/]\\.pnpm[\\\\/]${name.replace('/', '\\+')}@([^\\\\/_]+)`);
  const found = new Set<string>();
  for (const id of ids) {
    const match = pattern.exec(id);
    if (match?.[1]) found.add(match[1]);
  }
  return found;
}

/** Real package directories of `name` and its dependencies, recursively (pnpm layout). */
function closure(from: string, name: string, seen = new Set<string>()): Set<string> {
  const link = join(from, name);
  if (!existsSync(link)) return seen;
  const dir = realpathSync(link);
  if (seen.has(dir)) return seen;
  seen.add(dir);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  // In pnpm's store a package's dependencies are its siblings in node_modules.
  const siblings = name.includes('/') ? dirname(dirname(dir)) : dirname(dir);
  for (const dep of Object.keys(pkg.dependencies ?? {})) closure(siblings, dep, seen);
  return seen;
}

/** Chunk file names reachable from `start` over static imports. */
function reachable(chunks: readonly ChunkInfo[], start: string): Set<string> {
  const byName = new Map(chunks.map((c) => [c.fileName, c]));
  const out = new Set<string>();
  const walk = (name: string) => {
    if (out.has(name)) return;
    out.add(name);
    for (const next of byName.get(name)?.imports ?? []) walk(next);
  };
  walk(start);
  return out;
}

const isChainEntry = (c: ChunkInfo) =>
  c.isDynamicEntry && (c.facadeModuleId ?? '').endsWith(`canvas${sep}chain-canvas.tsx`);
/**
 * The import's document check (M4 §3.3), loaded by the page before an import:
 * part of the chain code, so what it shares with the canvas (schema-model,
 * zod) still counts as chain-only.
 */
const isChainCheckEntry = (c: ChunkInfo) =>
  c.isDynamicEntry && (c.facadeModuleId ?? '').endsWith(`canvas${sep}check-document.ts`);
const CHAIN_PACKAGES = [
  'zod',
  '@miragon/value-chain-renderer',
  '@miragon/value-chain-schema-model',
  'diagram-js',
];
const isChainModule = (id: string) =>
  CHAIN_PACKAGES.some((name) => versionsOf([id], name).size > 0);
/** The value chain page, its components and the step view (route chunks). */
const isChainPageModule = (id: string) =>
  [
    join(WEB, 'src/routes/value-chain-page.tsx'),
    join(WEB, 'src/routes/value-chain-step-page.tsx'),
    join(WEB, 'src/components/value-chain') + sep,
  ].some((path) => id === path || id.startsWith(path));

describe('web bundle (M4 §5 bundle guard)', { timeout: 120_000 }, () => {
  it('holds one diagram-js and one zod v4, keeps the chain code lazy and its CSS out of the main CSS', async () => {
    const { chunks, css } = await buildReport();
    const ids = chunks.flatMap((c) => c.moduleIds);

    expect(versionsOf(ids, 'diagram-js').size).toBe(1);
    const zod = [...versionsOf(ids, 'zod')];
    expect(zod).toHaveLength(1);
    expect(zod[0]).toMatch(/^4\./);
    expect([...versionsOf(ids, '@miragon/value-chain-renderer')]).toEqual(['0.3.0']);
    expect([...versionsOf(ids, '@miragon/value-chain-schema-model')]).toEqual(['0.3.0']);

    const entry = chunks.find((c) => c.isEntry);
    expect(entry).toBeDefined();
    const main = reachable(chunks, entry?.fileName ?? '');
    const mainModules = chunks.filter((c) => main.has(c.fileName)).flatMap((c) => c.moduleIds);
    expect(mainModules.filter(isChainModule)).toEqual([]);
    expect(chunks.some(isChainEntry)).toBe(true);
    // The chain page, its panels and the step view load with their routes, not with every page.
    expect(mainModules.filter(isChainPageModule).map((id) => relative(WEB, id))).toEqual([]);
    const entryGzip = chunks
      .filter((c) => main.has(c.fileName))
      .reduce((sum, c) => sum + gzipSync(c.code).length, 0);
    console.log(
      `entry chunk and its static imports: ${(entryGzip / 1024).toFixed(1)} KB gzip (ceiling ${ENTRY_CEILING / 1024} KB)`,
    );
    expect(entryGzip).toBeLessThanOrEqual(ENTRY_CEILING);

    const mainCss = chunks
      .filter((c) => main.has(c.fileName))
      .flatMap((c) => c.importedCss)
      .map((file) => css.get(file) ?? '');
    expect(mainCss.length).toBeGreaterThan(0);
    // A rule of the renderer starts its selector with `.vc-`; ProA's own are scoped (`.proa-vc .vc-…`).
    const rendererRule = /(?:^|[{},])\s*\.vc-[a-z]/;
    expect(mainCss.filter((sheet) => rendererRule.test(sheet))).toHaveLength(0);
    const chainCss = chunks.filter(isChainEntry).flatMap((c) => c.importedCss);
    expect(chainCss.some((file) => rendererRule.test(css.get(file) ?? ''))).toBe(true);
  });

  it(`keeps the chain-only code within ${BUDGET / 1024} KB gzip beyond the shared diagram-js code`, async () => {
    const renderer = realpathSync(join(WEB, 'node_modules/@miragon/value-chain-renderer'));
    const from = dirname(dirname(renderer));
    const shared = [...closure(from, 'diagram-js'), ...closure(from, 'diagram-js-direct-editing')];
    expect(shared.length).toBeGreaterThan(3);
    const inShared = (id: string) => shared.some((dir) => id.startsWith(dir + sep));

    const { chunks } = await buildReport({
      rolldownOptions: {
        output: {
          codeSplitting: {
            includeDependenciesRecursively: false,
            groups: [{ name: 'djs', test: (id: string) => inShared(id) }],
          },
        },
      },
    });
    const chain = chunks.find(isChainEntry);
    expect(chain).toBeDefined();
    const check = chunks.find(isChainCheckEntry);
    expect(check).toBeDefined();
    const others = new Set<string>();
    for (const c of chunks) {
      if ((c.isEntry || c.isDynamicEntry) && c !== chain && c !== check)
        for (const name of reachable(chunks, c.fileName)) others.add(name);
    }
    const djs = new Set(
      chunks
        .filter((c) => c.moduleIds.length > 0 && c.moduleIds.every(inShared))
        .map((c) => c.fileName),
    );
    expect(djs.size).toBeGreaterThan(0);
    const only = [
      ...new Set([
        ...reachable(chunks, chain?.fileName ?? ''),
        ...reachable(chunks, check?.fileName ?? ''),
      ]),
    ]
      .filter((name) => !others.has(name) && !djs.has(name))
      .map((name) => chunks.find((c) => c.fileName === name))
      .filter((c): c is ChunkInfo => c !== undefined);
    // No diagram-js module may hide in the counted chunks (it would be counted twice or not at all).
    expect(only.flatMap((c) => c.moduleIds).filter(inShared)).toEqual([]);

    const sizes = only.map((c) => ({ chunk: c.fileName, gzip: gzipSync(c.code).length }));
    const total = sizes.reduce((sum, s) => sum + s.gzip, 0);
    const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
    console.log(
      [
        `chain-only code: ${kb(total)} gzip (budget ${kb(BUDGET)})`,
        ...sizes.map((s) => `  ${s.chunk}: ${kb(s.gzip)}`),
        `shared diagram-js chunk(s): ${[...djs]
          .map((name) => kb(gzipSync(chunks.find((c) => c.fileName === name)?.code ?? '').length))
          .join(', ')}`,
      ].join('\n'),
    );
    expect(total).toBeLessThanOrEqual(BUDGET);
  });
});
