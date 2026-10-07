import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

/**
 * Smoke test (M1): projects → relations → model view, against a running
 * server. It creates its own project from eval/corpus/_sample, so it never
 * touches existing data, and it skips itself when no server answers.
 */

const SAMPLE = join(import.meta.dirname, '../../../eval/corpus/_sample/models');
const PROJECT = `e2e-${Date.now().toString(36)}`;
const CALL_FROM = 'vertrieb/auftragsabwicklung';
const CALL_TO = 'finance/payment-collection';

function bpmnFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? bpmnFiles(path) : name.endsWith('.bpmn') ? [path] : [];
  });
}

async function serverUp(request: APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get('/health', { timeout: 3000 });
    return response.ok();
  } catch {
    return false;
  }
}

test.describe.configure({ mode: 'serial' });

// The server sends a strict CSP for the UI (script-src 'self', no framing);
// a violation (bpmn-js, Radix, fonts, the watermark) must fail the smoke test.
const cspViolations: string[] = [];
test.beforeEach(async ({ page }) => {
  cspViolations.length = 0;
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /Content Security Policy|CSP violation/i.test(message.text())
    ) {
      cspViolations.push(message.text());
    }
  });
});
test.afterEach(() => {
  expect(cspViolations).toEqual([]);
});

test.beforeAll(async ({ request }) => {
  test.skip(
    !(await serverUp(request)),
    'no ProA server at PROA_E2E_URL; start one to run the smoke test',
  );
  // The API request context keeps the owner session cookie, like the browser does.
  expect((await request.post('/api/v1/session', { data: { client: 'proa-web' } })).ok()).toBe(true);
  const created = await request.post('/api/v1/projects', {
    data: { key: PROJECT, name: `E2E ${PROJECT}` },
  });
  expect(created.status()).toBe(201);
  const form = new FormData();
  for (const file of bpmnFiles(SAMPLE)) {
    const path = relative(SAMPLE, file);
    form.append('files', new File([readFileSync(file)], path, { type: 'application/xml' }));
  }
  const imported = await request.post(`/api/v1/projects/${PROJECT}/imports`, { multipart: form });
  expect(imported.ok()).toBe(true);
  const result = (await imported.json()) as { files: { outcome: string }[] };
  expect(result.files.map((f) => f.outcome)).toEqual(['created', 'created', 'created']);
});

test('projects → relations → model view', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Projekte' })).toBeVisible();
  await expect(page.getByTestId('server-status')).toContainText('Server verbunden');
  await page.getByRole('link', { name: `E2E ${PROJECT}` }).click();

  // models tab: three models, engines read from the XML
  await expect(page.getByTestId('model-row')).toHaveCount(3);
  await expect(page.getByTestId('model-row').filter({ hasText: CALL_FROM })).toContainText('C7');
  await expect(
    page.getByTestId('model-row').filter({ hasText: 'finanzen/rechnungsstellung' }),
  ).toContainText('C8');

  // relations tab: the unambiguous call is accepted by the rule, names are key-tier proposals
  await page.getByRole('link', { name: /Relationen/ }).click();
  const accepted = page.locator('[data-testid=relation-row][data-status=accepted][data-tier=rule]');
  await expect(accepted).toHaveCount(1);
  await expect(accepted).toContainText('Zahlung abwickeln');
  await expect(accepted).toContainText('proa-rules/1.0.0');
  await expect(
    page.locator('[data-testid=relation-row][data-status=proposed][data-tier=key]').first(),
  ).toBeVisible();

  await page.getByRole('button', { name: /Schlüssel-Vorschläge/ }).click();
  await expect(page).toHaveURL(/status=proposed/);
  await expect(accepted).toHaveCount(0);
  await page.getByRole('button', { name: /^Alle \d/ }).click();

  // model view: the call's endpoint is highlighted in the caller …
  await accepted.getByRole('link', { name: /Relation im Modell/ }).click();
  await expect(page).toHaveURL(new RegExp(`/models/${CALL_FROM}\\?relation=rel_`));
  await expect(page.getByTestId('bpmn-canvas')).toHaveAttribute('data-imported', 'true');
  await expect(
    page.locator('.djs-element.proa-endpoint[data-element-id=Call_ZahlungAbwickeln]'),
  ).toHaveCount(1);
  await expect(page.locator('.proa-overlay', { hasText: 'Von' })).toBeVisible();

  // … and the switch leads to the called process in the other model
  await page.getByTestId('switch-model').click();
  await expect(page).toHaveURL(new RegExp(`/models/${CALL_TO}\\?relation=rel_`));
  await expect(page.getByRole('heading', { name: CALL_TO })).toBeVisible();
  await expect(page.getByTestId('bpmn-canvas')).toHaveAttribute('data-imported', 'true');
  await expect(page.locator('[data-testid=model-relation][data-selected=true]')).toHaveCount(1);
});

test('upload: a folder keeps its paths, so re-importing it changes nothing', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/upload`);
  await page.getByTestId('folder-input').setInputFiles(SAMPLE);
  await expect(page.getByTestId('import-outcome')).toHaveCount(3);
  await expect(page.locator('[data-testid=import-outcome][data-outcome=unchanged]')).toHaveCount(3);
  await expect(page.getByRole('link', { name: CALL_FROM })).toBeVisible();
  await expect(page.getByTestId('toast').filter({ hasText: '3 Dateien importiert' })).toBeVisible();
});

test('findings and the connect page render for the project', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/findings`);
  await expect(page.getByRole('heading', { name: /Dynamischer Aufruf/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Aufruf ohne Ziel/ })).toBeVisible();

  await page.goto(`/projects/${PROJECT}/agents`);
  await page.getByRole('button', { name: 'Token erstellen' }).click();
  const secret = page.getByTestId('created-secret');
  await expect(secret).toContainText('proa_at_');
  await expect(page.getByTestId('code-block').first()).toContainText(
    'claude mcp add --transport http proa',
  );
  await expect(page.getByTestId('token-row')).toHaveCount(1);
});
