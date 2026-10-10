import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

/**
 * Import of a drafted `.vc.json` on the value chain page (M4 §3.3, S5) against
 * a running server with the built UI: an invented draft with rough waypoints
 * (as an agent writes it with the MCP prompt `draft_value_chain`) starts a
 * new chain from the empty state; the page lays every connection out again,
 * so the saved r1 has exactly the waypoints the renderer's layouter computes
 * (checked in the import harness, `e2e/harness`, served by Vite from inside
 * this spec); and an import over the golden dev chain asks first, then the
 * save shows the impact dialog. No CSP violation on the way. Invented data
 * and the dev landscape only. Skips itself when no server answers.
 */

const WEB = resolve(import.meta.dirname, '..');
const ROOT = join(WEB, '../..');
const CORPUS = join(ROOT, 'eval/corpus/nordwind-handel/models');
const GOLDEN = join(ROOT, 'eval/value-chains/nordwind-handel/value-chain.vc.json');
const STAMP = Date.now().toString(36);
const NEW = `vc-draft-${STAMP}`;
const OVER = `vc-over-${STAMP}`;
const SHOTS = process.env['PROA_SCREENSHOTS_DIR'];
const API = (project: string) => `/api/v1/projects/${project}/value-chains/main`;

/** Rough waypoints, as an agent may write them: two points each, nowhere near the shapes. */
const ROUGH = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

/** An invented draft (a university, no corpus names): a small chain with sub-steps and support steps. */
const DRAFT = {
  schemaVersion: 1,
  meta: { name: 'Musterhochschule – Wertschöpfungskette' },
  elements: [
    {
      id: 'step-hochschulsteuerung',
      elementType: 'step',
      name: 'Hochschulsteuerung',
      color: 'hsl(287, 65%, 44%)',
      bounds: { x: 40, y: 20, width: 160, height: 60 },
    },
    {
      id: 'step-bewerbung-zulassung',
      elementType: 'step',
      name: 'Bewerbung & Zulassung',
      bounds: { x: 40, y: 140, width: 160, height: 60 },
    },
    {
      id: 'step-bewerbung',
      elementType: 'step',
      name: 'Bewerbung',
      bounds: { x: 40, y: 240, width: 160, height: 60 },
    },
    {
      id: 'step-zulassung',
      elementType: 'step',
      name: 'Zulassung',
      bounds: { x: 40, y: 340, width: 160, height: 60 },
    },
    {
      id: 'step-studium',
      elementType: 'step',
      name: 'Studium',
      bounds: { x: 260, y: 140, width: 160, height: 60 },
    },
    {
      id: 'step-abschluss',
      elementType: 'step',
      name: 'Abschluss',
      bounds: { x: 480, y: 140, width: 160, height: 60 },
    },
    {
      id: 'step-rechenzentrum',
      elementType: 'step',
      name: 'Rechenzentrum',
      color: 'hsl(150, 86%, 34%)',
      bounds: { x: 40, y: 600, width: 160, height: 60 },
    },
  ],
  connections: [
    {
      id: 'seq-zulassung-studium',
      connectionType: 'sequence',
      source: 'step-bewerbung-zulassung',
      target: 'step-studium',
      waypoints: ROUGH,
    },
    {
      id: 'seq-studium-abschluss',
      connectionType: 'sequence',
      source: 'step-studium',
      target: 'step-abschluss',
      waypoints: ROUGH,
    },
    {
      id: 'hier-bewerbung',
      connectionType: 'hierarchy',
      source: 'step-bewerbung-zulassung',
      target: 'step-bewerbung',
      waypoints: ROUGH,
    },
    {
      id: 'hier-zulassung',
      connectionType: 'hierarchy',
      source: 'step-bewerbung-zulassung',
      target: 'step-zulassung',
      waypoints: ROUGH,
    },
  ],
};

interface CheckResult {
  warnings: number;
  connections: number;
  mismatches: { index: number; type: string }[];
}

let owner: APIRequestContext;
let harness: ViteDevServer | null = null;
let harnessUrl = '';
let cacheDir = '';

function bpmnFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? bpmnFiles(path) : name.endsWith('.bpmn') ? [path] : [];
  });
}

function modelsForm(): FormData {
  const form = new FormData();
  for (const file of bpmnFiles(CORPUS)) {
    form.append(
      'files',
      new File([readFileSync(file)], relative(CORPUS, file), { type: 'application/xml' }),
    );
  }
  return form;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

const canvas = (page: Page) => page.getByTestId('vc-canvas');

async function chooseDraft(page: Page, name = 'entwurf.vc.json'): Promise<void> {
  await page.getByTestId('import-file').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(DRAFT, null, 2)),
  });
}

/** The stored content of the chain head. */
async function content(project: string): Promise<{ text: string; rev: number }> {
  const response = await owner.get(`${API(project)}/content`);
  expect(response.ok()).toBe(true);
  const rev = Number(/"r(\d+)"/.exec(response.headers()['etag'] ?? '')?.[1]);
  return { text: await response.text(), rev };
}

/** The import harness (counts and indexes only) on a stored document. */
async function layouterCheck(page: Page, text: string): Promise<CheckResult> {
  await page.goto(harnessUrl);
  await page.waitForFunction(() => window.vcHarness?.ready === true, undefined, {
    timeout: 60_000,
  });
  return page.evaluate((t) => window.vcHarness.check(t), text);
}

test.describe.configure({ mode: 'serial' });

const cspViolations: string[] = [];
test.beforeEach(async ({ page }) => {
  cspViolations.length = 0;
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|CSP violation/i.test(message.text()))
      cspViolations.push(message.text());
  });
});
test.afterEach(() => {
  expect(cspViolations).toEqual([]);
});

test.beforeAll(async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  const url = baseURL ?? 'http://127.0.0.1:7400';
  const probe = await playwright.request.newContext({ baseURL: url });
  const health = await probe.get('/health', { timeout: 3000 }).catch(() => null);
  await probe.dispose();
  test.skip(!health?.ok(), 'no ProA server at PROA_E2E_URL; start one to run the import flow');

  owner = await playwright.request.newContext({ baseURL: url });
  expect((await owner.post('/api/v1/session', { data: { client: 'proa-web' } })).ok()).toBe(true);
  for (const [key, name] of [
    [NEW, 'Entwurf (Import)'],
    [OVER, 'Nordwind Handel (Import)'],
  ] as const) {
    expect((await owner.post('/api/v1/projects', { data: { key, name } })).status()).toBe(201);
  }
  expect(
    (await owner.post(`/api/v1/projects/${OVER}/imports`, { multipart: modelsForm() })).ok(),
  ).toBe(true);
  const pushed = await owner.put(`${API(OVER)}/content`, {
    headers: { 'if-none-match': '*', 'content-type': 'application/json' },
    data: readFileSync(GOLDEN, 'utf8'),
  });
  expect(pushed.status()).toBe(201);

  cacheDir = mkdtempSync(join(tmpdir(), 'proa-vc-draft-harness-'));
  harness = await createServer({
    root: join(WEB, 'e2e/harness'),
    configFile: false,
    cacheDir,
    logLevel: 'warn',
    clearScreen: false,
    resolve: { alias: { '@': join(WEB, 'src') } },
    server: { host: '127.0.0.1', port: 0 },
  });
  await harness.listen();
  harnessUrl = harness.resolvedUrls?.local[0] ?? '';
  expect(harnessUrl).not.toBe('');
});

test.afterAll(async () => {
  await harness?.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
  await owner?.dispose();
});

test('an invented draft imported into a new chain gets the layouter’s waypoints and saves as r1', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`/projects/${NEW}/value-chain`);
  const empty = page.getByTestId('empty-chain');
  await expect(empty.getByTestId('import-chain')).toBeVisible();
  await chooseDraft(page);
  await expect(canvas(page)).toHaveAttribute('data-mode', 'edit');
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  await expect(canvas(page)).toHaveAttribute('data-import-warnings', '0');
  await expect(page.getByTestId('unsaved')).toBeVisible();
  await expect(page.getByTestId('chain-rev')).toHaveText('neu');
  await expect(
    page.getByTestId('toast').filter({ hasText: '„entwurf.vc.json“ importiert' }),
  ).toBeVisible();
  // Kept as a draft of the new chain until it is saved.
  const drafts = await page.evaluate(
    (prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
    `proa:vc-draft:${NEW}:`,
  );
  expect(drafts).toEqual([`proa:vc-draft:${NEW}:new:r0`]);
  await shot(page, 'm4-12-import');
  // Nothing is stored before the save; the save of a new chain needs no confirmation.
  expect((await owner.get(API(NEW))).status()).toBe(404);
  await page.getByTestId('save-chain').click();
  await expect(
    page.getByTestId('toast').filter({ hasText: 'Angelegt als r1' }).last(),
  ).toBeVisible();
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'false');

  const stored = await content(NEW);
  expect(stored.rev).toBe(1);
  const doc = JSON.parse(stored.text) as typeof DRAFT;
  expect(doc.meta.name).toBe(DRAFT.meta.name);
  expect(doc.elements.map((e) => e.id).sort()).toEqual(DRAFT.elements.map((e) => e.id).sort());
  // Every connection was laid out again: none keeps the rough waypoints.
  expect(doc.connections).toHaveLength(DRAFT.connections.length);
  for (const c of doc.connections) expect(c.waypoints).not.toEqual(ROUGH);
  // …and exactly as the renderer's layouter lays it out.
  expect(await layouterCheck(page, stored.text)).toEqual({
    warnings: 0,
    connections: DRAFT.connections.length,
    mismatches: [],
  } satisfies CheckResult);
});

test('an import over an existing chain asks first; its save shows the impact dialog', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto(`/projects/${OVER}/value-chain`);
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  // Viewing: no import; editing: the toolbar has it.
  await expect(page.getByTestId('import-chain')).toHaveCount(0);
  await page.getByTestId('edit-chain').click();
  await expect(canvas(page)).toHaveAttribute('data-mode', 'edit');
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  await expect(page.getByTestId('import-chain')).toBeVisible();

  // A file that is no chain is refused in German, the drawing stays.
  await page.getByTestId('import-file').setInputFiles({
    name: 'notiz.vc.json',
    mimeType: 'application/json',
    buffer: Buffer.from('Notizen, kein JSON'),
  });
  await expect(
    page.getByTestId('toast').filter({ hasText: '„notiz.vc.json“ ist keine JSON-Datei' }),
  ).toBeVisible();
  await expect(page.getByTestId('unsaved')).toHaveCount(0);

  await chooseDraft(page, 'neu.vc.json');
  const confirm = page.getByTestId('import-confirm');
  await expect(confirm).toContainText('Die aktuelle Zeichnung wird durch „neu.vc.json“ ersetzt.');
  await page.getByTestId('import-replace').click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByTestId('unsaved')).toBeVisible();
  // The base stays the head the edit started from.
  await expect(page.getByTestId('chain-rev')).toHaveText('r1');

  await page.getByTestId('save-chain').click();
  // The golden steps are gone: their rule-tier proposals are withdrawn, so the save asks.
  await expect(page.getByTestId('impact-dialog')).toBeVisible();
  // The screenshot without the toasts of the refused file and the import over the dialog's buttons.
  if (SHOTS) await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 15_000 });
  await shot(page, 'm4-13-import-impact');
  await page.getByRole('button', { name: 'Trotzdem speichern' }).click();
  await expect(
    page.getByTestId('toast').filter({ hasText: 'Gespeichert als r2' }).last(),
  ).toBeVisible();
  const stored = await content(OVER);
  expect(stored.rev).toBe(2);
  expect(await layouterCheck(page, stored.text)).toMatchObject({ warnings: 0, mismatches: [] });
});
