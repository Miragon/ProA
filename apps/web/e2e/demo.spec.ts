import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page, type Request, type Response } from '@playwright/test';

import { probeServer } from './server-mode';

/**
 * The read-only demo in the browser (issue #3), against the demo image
 * (`docker/compose.demo.yaml`, PROA_E2E_URL=http://127.0.0.1:7480). It clicks
 * through every read view of both seeded landscapes and fails on any request
 * that is not a read (the viewer session aside), on any API answer 4xx/5xx,
 * on a CSP violation and on any write action shown (by its text or its test
 * id). The review shows the simulation agent's proposals, questions,
 * no-links (tab „Kein Zusammenhang“) and placement proposals (owner decision
 * 20(4)). Skips itself unless the server reports `demo: "readonly"`.
 * PROA_SCREENSHOTS_DIR=<dir> saves `demo-*.png` screenshots there.
 */

const PROJECTS = ['nordwind-handel', 'stadtwerke-auental'] as const;
const SHOTS = process.env['PROA_SCREENSHOTS_DIR'];

/** Texts of actions that change something; none may appear on the demo. */
const WRITE_ACTIONS = [
  /Neues Projekt/,
  /^Hochladen$/,
  /Modelle hochladen/,
  /^Agent verbinden$/,
  /^Regeln$/,
  /annehmen…/,
  /Erneut einplanen/,
  /Aufgabe einplanen/,
  /^Bearbeiten$/,
  /^Annehmen/,
  /^Erneut annehmen/,
  /^Ablehnen/,
  /^Vormerken/,
  /^Korrigieren/,
  /Antwort speichern/,
  /Token erstellen/,
  /^Prozess hinzufügen$/,
  /^Platzieren$/,
  /erneut bestätigen/,
  /^Speichern$/,
  /^Importieren$/,
];

/** Test ids of the value chain's write actions (stable where texts may change). */
const WRITE_TEST_IDS = [
  'add-process',
  'requeue-chain',
  'import-chain',
  'save-chain',
  'edit-chain',
  'bulk-open',
  'placement-decision',
];

const unexpected: string[] = [];

function watch(page: Page): void {
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' || request.method() === 'HEAD') return;
    if (request.method() === 'POST' && url.pathname === '/api/v1/session') return;
    unexpected.push(`${request.method()} ${url.pathname}`);
  });
  page.on('response', (response: Response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/') && response.status() >= 400) {
      unexpected.push(`${response.status()} ${response.request().method()} ${url.pathname}`);
    }
  });
  page.on('console', (message) => {
    if (/Content Security Policy|CSP violation/i.test(message.text())) {
      unexpected.push(`CSP: ${message.text()}`);
    }
  });
}

async function noWriteActions(page: Page): Promise<void> {
  for (const name of WRITE_ACTIONS) {
    await expect(page.getByRole('button', { name }), String(name)).toHaveCount(0);
    await expect(page.getByRole('link', { name }), String(name)).toHaveCount(0);
  }
  for (const id of WRITE_TEST_IDS) await expect(page.getByTestId(id), id).toHaveCount(0);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `demo-${name}.png`) });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const mode = await probeServer(request);
  test.skip(mode !== 'demo', 'the server at PROA_E2E_URL is not the read-only demo');
});

test.beforeEach(({ page }) => {
  unexpected.length = 0;
  watch(page);
});

test.afterEach(() => {
  expect(unexpected).toEqual([]);
});

test('projects: the banner, both landscapes as a reader, nothing to create', async ({ page }) => {
  await page.goto('/');
  const banner = page.getByTestId('demo-banner');
  await expect(banner).toContainText('Demo – nur lesen.');
  await expect(banner.getByRole('link', { name: /ProA auf GitHub/ })).toHaveAttribute(
    'href',
    'https://github.com/Miragon/ProA',
  );
  await expect(page.locator('html')).toHaveAttribute('data-proa-demo', 'readonly');
  const rows = page.getByTestId('project-row');
  await expect(rows).toHaveCount(PROJECTS.length);
  for (const row of await rows.all()) await expect(row).toContainText('Leser');
  await noWriteActions(page);
  await expect(page.getByText(/Testlandschaften laden/)).toHaveCount(0);
  await shot(page, '01-projects');
});

for (const project of PROJECTS) {
  test(`${project}: models, relations, findings and the model view read`, async ({ page }) => {
    await page.goto(`/projects/${project}`);
    await expect(page.getByTestId('model-row').first()).toBeVisible();
    await noWriteActions(page);
    await page.getByRole('link', { name: /^Relationen/ }).click();
    await expect(page.getByTestId('relation-row').first()).toBeVisible();
    await page.getByRole('link', { name: /^Befunde/ }).click();
    await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
    await page.goto(`/projects/${project}`);
    await page.getByTestId('model-row').first().getByRole('link').first().click();
    await expect(page.getByTestId('model-view')).toBeVisible();
    await expect(page.locator('.djs-container')).toBeVisible();
    if (project === 'nordwind-handel') await shot(page, '02-model-view');
  });

  test(`${project}: the review inbox and screen in read mode`, async ({ page }) => {
    await page.goto(`/projects/${project}/review`);
    const queue = page.getByTestId('queue-row');
    await expect(queue.first()).toBeVisible();
    expect(await queue.count()).toBeGreaterThan(0);
    await noWriteActions(page);
    if (project === 'nordwind-handel') await shot(page, '03-inbox');
    await queue
      .first()
      .getByRole('link', { name: /Prüfen/ })
      .first()
      .click();
    await expect(page.getByTestId('review-screen')).toBeVisible();
    await expect(page.getByTestId('read-only-review')).toHaveText(
      'Nur lesen – in der Demo entscheidest du nicht.',
    );
    // The decision shortcuts do nothing; J walks on.
    await page.keyboard.press('a');
    await page.keyboard.press('r');
    await page.keyboard.press('h');
    await page.keyboard.press('c');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await noWriteActions(page);
    await expect(page.locator('[data-testid=review-pane] .djs-container').first()).toBeVisible();
    if (project === 'nordwind-handel') await shot(page, '04-review');
    const before = page.url();
    await page.keyboard.press('j');
    await expect(page).not.toHaveURL(before);
  });

  test(`${project}: the agent's no-links, read-only`, async ({ page }) => {
    await page.goto(`/projects/${project}/review`);
    await page.getByRole('tab', { name: /^Kein Zusammenhang/ }).click();
    await expect(page).toHaveURL(/view=no-links/);
    const items = page.getByTestId('no-link-item');
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThan(0);
    await expect(items.first()).toContainText('Kein Zusammenhang laut');
    await expect(items.first()).toContainText('agent:');
    await expect(items.first().getByRole('button')).toHaveCount(0);
    await noWriteActions(page);
    if (project === 'nordwind-handel') await shot(page, '06-no-links');
  });

  test(`${project}: the value chain with the agent's placements, and a step`, async ({ page }) => {
    await page.goto(`/projects/${project}/value-chain`);
    await expect(page.getByTestId('value-chain-page')).toBeVisible();
    await expect(page.getByTestId('vc-canvas')).toBeVisible();
    await expect(page.getByTestId('chain-overview')).toBeVisible();
    await expect(page.getByTestId('chain-stage')).toBeVisible();
    await expect(page.getByTestId('edit-chain')).toHaveCount(0);
    await expect(page.getByTestId('import-chain')).toHaveCount(0);
    await noWriteActions(page);
    const open = page.getByTestId('open-placement');
    if ((await open.count()) > 0) {
      await open.first().click();
      await expect(page.getByTestId('placement-card').first()).toBeVisible();
      await noWriteActions(page);
    }
    if (project === 'nordwind-handel') await shot(page, '05-value-chain');
    // From the overview: a step, its panel, then the step view.
    await page.goto(`/projects/${project}/value-chain`);
    const item = page.getByTestId('step-tree-item').first();
    await item.click();
    await expect(page.getByTestId('step-panel')).toBeVisible();
    await noWriteActions(page);
    await page.getByTestId('open-step').click();
    await expect(page.getByTestId('step-view')).toBeVisible();
    await noWriteActions(page);
  });

  test(`${project}: write pages answer with a notice`, async ({ page }) => {
    for (const [path, text] of [
      ['upload', 'In der Demo kannst du keine Modelle hochladen.'],
      ['agents', 'In der Demo verbindet sich kein Agent'],
      ['rules', 'In der Demo gibt es keine Annahmeregeln.'],
    ] as const) {
      await page.goto(`/projects/${project}/${path}`);
      await expect(page.getByTestId('read-only-notice')).toContainText(text);
    }
  });
}

test('the API refuses writes and MCP from the browser context too', async ({ request }) => {
  const write = await request.post('/api/v1/projects', { data: { key: 'x', name: 'x' } });
  expect(write.status()).toBe(403);
  expect(((await write.json()) as { code: string }).code).toBe('demo-readonly');
  expect((await request.post('/mcp', { data: {} })).status()).toBe(404);
});
