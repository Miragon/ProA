import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

/**
 * The import check of the value chain renderer (M4 §5 and §9, moved from S0
 * to S3): in a real browser, a document imports without warnings and every
 * stored connection's waypoints equal what the renderer's layouter computes
 * for it (rounded like `serializeDocument`), for the golden dev chain and for
 * synthetic chains drawn through the modeling API; and ProA's element factory
 * never repeats an id. The page is `e2e/harness`, served by Vite's dev server
 * from inside this spec, so it needs no ProA server.
 *
 * The holdout chain is never read here. `PROA_E2E_VC_EXTRA=<path>` lets the
 * owner run it (or any `.vc.json`): the output is counts only.
 */

const WEB = resolve(import.meta.dirname, '..');
const GOLDEN = resolve(WEB, '../../eval/value-chains/nordwind-handel/value-chain.vc.json');
const EXTRA = process.env['PROA_E2E_VC_EXTRA'];

interface CheckResult {
  warnings: number;
  connections: number;
  mismatches: { index: number; type: string }[];
}

let server: ViteDevServer;
let url = '';
let cacheDir = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(120_000);
  cacheDir = mkdtempSync(join(tmpdir(), 'proa-vc-harness-'));
  server = await createServer({
    root: join(WEB, 'e2e/harness'),
    configFile: false,
    cacheDir,
    logLevel: 'warn',
    clearScreen: false,
    resolve: { alias: { '@': join(WEB, 'src') } },
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  url = server.resolvedUrls?.local[0] ?? '';
  expect(url).not.toBe('');
});

test.afterAll(async () => {
  await server?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

async function open(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => window.vcHarness?.ready === true, undefined, {
    timeout: 60_000,
  });
  expect(errors).toEqual([]);
}

test('the golden dev chain imports without warnings and its waypoints are the layouter’s', async ({
  page,
}) => {
  await open(page);
  const text = readFileSync(GOLDEN, 'utf8');
  const result = await page.evaluate((t) => window.vcHarness.check(t), text);
  expect(result).toEqual({ warnings: 0, connections: 39, mismatches: [] } satisfies CheckResult);
});

test('synthetic chains drawn with the modeling API round-trip with the layouter’s waypoints', async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(() => window.vcHarness.roundTrip());
  expect(result.built.mismatches).toEqual([]);
  expect(result.warnings).toBe(0);
  expect(result.mismatches).toEqual([]);
  // 3 top-level steps, 3 + 3 + 1 sub-steps, 1 org unit
  expect(result.elements).toBe(11);
  // 2 sequence, 7 hierarchy, 2 assignment
  expect(result.connections).toBe(11);
});

test('ProA’s element factory never repeats an id; the stock one does in a new session', async ({
  page,
}) => {
  await open(page);
  const result = await page.evaluate(() => window.vcHarness.ids());
  // created, deleted, created again, appended (step and connection), a second session;
  // plus anything pasted (copy-paste copies nothing in renderer 0.3.0: no `element.copy` rule)
  expect(result.created).toBe(5 + result.pasted);
  expect(result.unique).toBe(result.created);
  expect(result.wellFormed).toBe(result.created);
  // The renderer's own factory restarts its counter per instance (upstream ask 4).
  expect(result.stock).toEqual(['shape_1', 'shape_1']);
});

test('an extra chain from PROA_E2E_VC_EXTRA (counts only)', async ({ page }) => {
  test.skip(!EXTRA, 'set PROA_E2E_VC_EXTRA=<path to a .vc.json> to check another chain');
  const path = resolve(EXTRA ?? '');
  expect(existsSync(path)).toBe(true);
  await open(page);
  const result = await page.evaluate((t) => window.vcHarness.check(t), readFileSync(path, 'utf8'));
  // Counts and indexes only: the holdout's names never reach the output.
  console.log(
    `extra chain: ${result.warnings} warnings, ${result.connections} connections, ${result.mismatches.length} mismatches`,
  );
  expect(result.warnings).toBe(0);
  expect(result.mismatches.length).toBe(0);
});
