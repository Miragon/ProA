import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

import { DEMO_SKIP, probeServer } from './server-mode';

/**
 * The value chain page (M4 S3) against a running server with the built UI:
 * the empty state and a chain created in the browser, the golden dev chain
 * pushed over REST with its badges and findings, placements proposed by an
 * agent over REST and reviewed in the panel (A, R, H, C, the HTML rationale
 * as text), a rename with the dry-run dialog and the bulk re-confirm, a save
 * conflict with the download of the local copy, a draft that survives a
 * reload, a deleted and re-added step getting a fresh id, link set, undo and
 * clear with the rule tier's proposal, the drill-down, a re-import plus a
 * layout-only save that keeps decided placements, the agent's `reviewUrl`,
 * and the CSS check of the bpmn-js review screen around the chain page
 * (M4 §5). With PROA_SCREENSHOTS_DIR set it writes m4-*.png there. Uses
 * eval/corpus/nordwind-handel and its golden chain only. Skips itself when no
 * server answers.
 */

const ROOT = join(import.meta.dirname, '../../..');
const CORPUS = join(ROOT, 'eval/corpus/nordwind-handel/models');
const GOLDEN = join(ROOT, 'eval/value-chains/nordwind-handel/value-chain.vc.json');
const STAMP = Date.now().toString(36);
const PROJECT = `vc-${STAMP}`;
const EMPTY = `vc-empty-${STAMP}`;
const SKETCH = `vc-sketch-${STAMP}`;
const SHOTS = process.env['PROA_SCREENSHOTS_DIR'];
const ID = /^shape_[0-9A-HJKMNP-TV-Z]{26}$/;
const API = (project: string) => `/api/v1/projects/${project}/value-chains/main`;

interface Placement {
  id: string;
  elementId: string;
  generation: number;
  stepLive: boolean;
  process: string;
  status: string;
  endpointState: string;
  tier: string;
  version: number;
  source: string | null;
  provenance: { sourceKind: string; handle: string } | null;
}
interface Detail {
  valueChain: { id: string; headRev: number; name: string };
  steps: {
    elementId: string;
    name: string;
    counts: { accepted: number; proposed: number; held: number };
  }[];
  placements: Placement[];
  findings: { kind: string; elementId: string | null }[];
}

let owner: APIRequestContext;
let agent: APIRequestContext;
/** Placements the agent proposed, by role in the flow. */
const proposed: Record<string, string> = {};
/** Every element id any revision of the chain had (fresh-id check). */
const seenIds = new Set<string>();

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
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

async function detail(project = PROJECT): Promise<Detail> {
  const response = await owner.get(API(project));
  expect(response.ok()).toBe(true);
  return (await response.json()) as Detail;
}

async function content(project = PROJECT): Promise<{ text: string; rev: number; doc: Doc }> {
  const response = await owner.get(`${API(project)}/content`);
  expect(response.ok()).toBe(true);
  const text = await response.text();
  const rev = Number(/"r(\d+)"/.exec(response.headers()['etag'] ?? '')?.[1]);
  const doc = JSON.parse(text) as Doc;
  for (const e of doc.elements) seenIds.add(e.id);
  return { text, rev, doc };
}

interface Doc {
  meta: { name: string };
  elements: {
    id: string;
    elementType: string;
    name: string;
    link?: string;
    bounds: { x: number };
  }[];
  connections: unknown[];
}

async function placement(id: string): Promise<Placement> {
  const response = await owner.get(`${API(PROJECT)}/placements/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Placement;
}

async function allPlacements(query = ''): Promise<Placement[]> {
  const response = await owner.get(`${API(PROJECT)}/placements?limit=200${query}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { items: Placement[] }).items;
}

const canvas = (page: Page) => page.getByTestId('vc-canvas');

async function chainPage(page: Page, search = '', project = PROJECT): Promise<void> {
  await page.goto(`/projects/${project}/value-chain${search}`);
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
}

async function enterEdit(page: Page): Promise<void> {
  await page.getByTestId('edit-chain').click();
  await expect(canvas(page)).toHaveAttribute('data-mode', 'edit');
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
}

async function finishEdit(page: Page): Promise<void> {
  await page.getByTestId('finish-edit').click();
  await expect(canvas(page)).toHaveAttribute('data-mode', 'view');
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
}

/** The diagram element on the canvas (its hit area selects it). */
const shape = (page: Page, elementId: string): Locator =>
  page.locator(`[data-testid=vc-canvas] .djs-element[data-element-id="${elementId}"]`);

async function selectOnCanvas(page: Page, elementId: string): Promise<void> {
  // A click on the selected element deselects it (diagram-js), so click only when needed.
  const panel = page.getByTestId('step-panel');
  if ((await panel.count()) > 0 && (await panel.getAttribute('data-element-id')) === elementId)
    return;
  await shape(page, elementId).click();
  await expect(page.getByTestId('step-panel')).toHaveAttribute('data-element-id', elementId);
}

/** The keys of the drafts the browser keeps for a project (`proa:vc-draft:<project>:…`). */
async function draftKeys(page: Page, project = PROJECT): Promise<string[]> {
  return page.evaluate(
    (prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
    `proa:vc-draft:${project}:`,
  );
}

async function rename(page: Page, name: string): Promise<void> {
  const field = page.getByLabel('Name', { exact: true });
  await field.fill(name);
  await field.press('Enter');
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
}

/** Saves; with `confirm`, the impact dialog must appear and is confirmed. Returns the new rev. */
async function save(page: Page, confirm = false): Promise<number> {
  await page.getByTestId('save-chain').click();
  if (confirm) {
    await expect(page.getByTestId('impact-dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Trotzdem speichern' }).click();
  }
  const toast = page
    .getByTestId('toast')
    .filter({ hasText: /(Gespeichert|Angelegt) als r\d+/ })
    .last();
  await expect(toast).toBeVisible();
  const rev = Number(/r(\d+)/.exec((await toast.textContent()) ?? '')?.[1]);
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'false');
  return rev;
}

/** Places a new step from the palette at a free spot of the canvas; returns its element id. */
async function addStep(page: Page, name: string): Promise<string> {
  const box = await canvas(page).boundingBox();
  if (!box) throw new Error('no canvas');
  const x = box.x + box.width * 0.82;
  const y = box.y + box.height * 0.74;
  await page.locator('.djs-palette [data-action="create.step"]').click();
  await page.mouse.move(x - 40, y - 20, { steps: 4 });
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.click(x, y);
  const panel = page.getByTestId('step-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('new-step-hint')).toBeVisible();
  const id = (await panel.getAttribute('data-element-id')) ?? '';
  expect(id).toMatch(ID);
  await rename(page, name);
  return id;
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
  page.on('dialog', (dialog) => {
    // an agent's text must never run: alert() from a rationale fails the test
    cspViolations.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
});
test.afterEach(() => {
  expect(cspViolations).toEqual([]);
});

test.beforeAll(async ({ playwright, baseURL }) => {
  test.setTimeout(120_000);
  const url = baseURL ?? 'http://127.0.0.1:7400';
  const probe = await playwright.request.newContext({ baseURL: url });
  const mode = await probeServer(probe);
  await probe.dispose();
  test.skip(
    mode === 'down',
    'no ProA server at PROA_E2E_URL; start one to run the value chain flow',
  );
  test.skip(mode === 'demo', DEMO_SKIP);

  owner = await playwright.request.newContext({ baseURL: url });
  expect((await owner.post('/api/v1/session', { data: { client: 'proa-web' } })).ok()).toBe(true);
  for (const [key, name] of [
    [PROJECT, 'Nordwind Handel (Kette)'],
    [EMPTY, 'Leeres Projekt'],
    [SKETCH, 'Skizze'],
  ] as const) {
    expect((await owner.post('/api/v1/projects', { data: { key, name } })).status()).toBe(201);
  }
  expect(
    (await owner.post(`/api/v1/projects/${PROJECT}/imports`, { multipart: modelsForm() })).ok(),
  ).toBe(true);
  const token = await owner.post(`/api/v1/projects/${PROJECT}/agent-tokens`, {
    data: { name: 'e2e-vc', scopes: ['proa:read', 'proa:propose'] },
  });
  expect(token.status()).toBe(201);
  const { secret } = (await token.json()) as { secret: string };
  agent = await playwright.request.newContext({
    baseURL: url,
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  });
});

test.afterAll(async () => {
  await agent?.dispose();
  await owner?.dispose();
});

test('empty state, then a chain created in the browser and saved as r1', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(`/projects/${EMPTY}/value-chain`);
  const empty = page.getByTestId('empty-chain');
  await expect(empty).toContainText('Noch keine Wertschöpfungskette');
  await expect(empty.getByTestId('code-block')).toHaveText(
    `proa value-chain push kette.vc.json -p ${EMPTY}`,
  );
  await shot(page, 'm4-07-empty');

  await page.getByTestId('create-chain').click();
  await expect(canvas(page)).toHaveAttribute('data-mode', 'edit');
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  // nothing stored before the first save
  expect((await owner.get(API(EMPTY))).status()).toBe(404);
  const id = await addStep(page, 'Einkauf');
  const rev = await save(page);
  expect(rev).toBe(1);
  const created = await detail(EMPTY);
  expect(created.valueChain.headRev).toBe(1);
  expect(created.steps.map((s) => [s.elementId, s.name])).toEqual([[id, 'Einkauf']]);
  await finishEdit(page);
  await expect(page.getByTestId('chain-rev')).toHaveText('r1');
});

test('the golden dev chain pushed over REST renders with badges and findings', async ({ page }) => {
  const pushed = await owner.put(`${API(PROJECT)}/content`, {
    headers: { 'if-none-match': '*', 'content-type': 'application/json' },
    data: readFileSync(GOLDEN, 'utf8'),
  });
  expect(pushed.status()).toBe(201);
  await content();
  await chainPage(page);
  await expect(canvas(page)).toHaveAttribute('data-import-warnings', '0');
  await expect(page.getByTestId('step-tree-item')).toHaveCount(34);
  // the rule tier's four key proposals (equal names), one per step: open, not homed yet
  const badges = canvas(page).locator('.proa-vc-badge');
  await expect(badges.filter({ hasText: /^1 offen$/ })).toHaveCount(4);
  await expect(badges.filter({ hasText: /Prozess/ })).toHaveCount(0);
  await expect(badges.filter({ hasText: 'nichts angenommen' }).first()).toBeVisible();
  await expect(page.locator('.djs-element.proa-vc-finding').first()).toBeVisible();
  await expect(page.getByTestId('chain-summary')).toContainText('34 Schritte');
  await expect(page.getByTestId('unplaced-chip')).toBeVisible();
  await shot(page, 'm4-01-chain-view');
});

test('agent proposals over REST are reviewed in the panel: A, R, H, C, HTML as text', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const items = [
    [
      'accept',
      'step-bestellwesen',
      'einkauf/bestellfreigabe#Process_Bestellfreigabe',
      'Gibt Bestellungen frei.',
      null,
    ],
    [
      'reject',
      'step-kommissionierung',
      'service/returns#Process_Returns',
      'Retouren gehen durchs Lager.',
      null,
    ],
    [
      'hold',
      'step-retouren',
      'finanzen/gutschrift#Process_Gutschrift',
      'Gutschrift nach Retoure.',
      'Gehört die Gutschrift zu Retouren oder zur Fakturierung?',
    ],
    [
      'correct',
      'step-wareneingang',
      'qualitaet/wareneingangspruefung#Process_Wareneingangspruefung',
      'Prüft eingehende Ware.',
      null,
    ],
    [
      'outside',
      '@outside',
      'einkauf/archiv/bestellfreigabe-2019#Process_Bestellfreigabe',
      'Archivkopie von einkauf/bestellfreigabe#Process_Bestellfreigabe.',
      null,
    ],
    [
      'hostile',
      'step-paketversand',
      'logistik/shipping#Process_Shipping',
      'Paketversand. <img src=x onerror="alert(1)"> <b>kein HTML</b>',
      null,
    ],
  ] as const;
  const response = await agent.post(`${API(PROJECT)}/placements`, {
    data: {
      kind: 'propose',
      procedure: { id: 'proa-placements', version: '0.1.0' },
      llmModel: 'e2e-sim',
      placements: items.map(([, step, process, rationale, question]) => ({
        step,
        process,
        confidence: 0.82,
        rationale,
        evidence: [process, ...(step.startsWith('@') ? [] : [`step:${step}`])],
        question,
      })),
    },
  });
  expect(response.ok()).toBe(true);
  const result = (await response.json()) as {
    items: { index: number; result: string; placementId: string | null }[];
  };
  for (const item of result.items) {
    expect(item.result).toBe('applied');
    proposed[items[item.index]![0]] = item.placementId ?? '';
  }

  // the step with the rule tier's proposal and the agent's
  await chainPage(page, '?step=step-wareneingang');
  const panel = page.getByTestId('step-panel');
  await expect(panel.getByTestId('placement-card')).toHaveCount(2);
  await expect(panel.getByTestId('rule-basis')).toHaveText('Regel: gleicher Name');
  await shot(page, 'm4-02-step-panel');

  // A
  await chainPage(page, `?placement=${proposed['accept']}`);
  const card = (id: string) =>
    page.locator(`[data-testid=placement-card][data-placement-id="${id}"]`);
  await expect(card(proposed['accept']!)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('a');
  await expect.poll(async () => (await placement(proposed['accept']!)).status).toBe('accepted');

  // R with a reason (Ctrl+Enter)
  await chainPage(page, `?placement=${proposed['reject']}`);
  await expect(card(proposed['reject']!)).toHaveAttribute('data-active', 'true');
  await page.keyboard.press('r');
  await page.getByLabel('Grund der Ablehnung').fill('Retouren sind ein eigener Schritt.');
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => (await placement(proposed['reject']!)).status).toBe('rejected');

  // H with a note and a question
  await chainPage(page, `?placement=${proposed['hold']}`);
  await expect(card(proposed['hold']!)).toContainText('Gehört die Gutschrift zu Retouren');
  await page.keyboard.press('h');
  await page.getByLabel('Notiz').fill('Mit der Buchhaltung klären.');
  await page.getByLabel('Frage (optional)').fill('Wer erstellt die Gutschrift?');
  await page.keyboard.press('Control+Enter');
  await expect.poll(async () => (await placement(proposed['hold']!)).status).toBe('held');

  // C to another step
  await chainPage(page, `?placement=${proposed['correct']}`);
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Schritt suchen').fill('Qualitätsprüfung');
  await dialog
    .locator('[data-testid=correct-step-option][data-step="step-qualitaetspruefung"]')
    .click();
  await dialog.getByLabel('Begründung').fill('Die Prüfung ist ein eigener Schritt.');
  await dialog.getByRole('button', { name: 'Korrigieren' }).click();
  await expect.poll(async () => (await placement(proposed['correct']!)).status).toBe('rejected');
  const corrected = await allPlacements('&elementId=step-qualitaetspruefung');
  expect(corrected).toContainEqual(
    expect.objectContaining({
      process: 'qualitaet/wareneingangspruefung#Process_Wareneingangspruefung',
      status: 'accepted',
      tier: 'manual',
    }),
  );

  // @outside in the overview; the HTML rationale stays text
  await chainPage(page);
  await expect(page.getByLabel('Außerhalb der Kette')).toContainText('Archivkopie von');
  await chainPage(page, `?placement=${proposed['hostile']}`);
  const hostile = card(proposed['hostile']!);
  await expect(hostile).toContainText('<img src=x onerror="alert(1)">');
  await expect(hostile.locator('img')).toHaveCount(0);
  await expect(hostile.locator('b')).toHaveCount(0);
});

test('a rename asks before sending an accepted placement to re-confirm; bulk re-confirm', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await chainPage(page);
  await enterEdit(page);
  await selectOnCanvas(page, 'step-bestellwesen');
  await rename(page, 'Bestellung & Freigabe');
  await page.getByTestId('save-chain').click();
  const impact = page.getByTestId('impact-dialog');
  await expect(impact).toBeVisible();
  await expect(impact.getByTestId('impact-changed')).toContainText('Bestellwesen');
  await expect(impact.getByTestId('impact-changed')).toContainText('erneut bestätigen');
  await shot(page, 'm4-04-save-impact');
  await impact.getByRole('button', { name: 'Trotzdem speichern' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Gespeichert als r2' })).toBeVisible();
  await content();
  expect((await placement(proposed['accept']!)).endpointState).toBe('changed');
  await finishEdit(page);

  // the overview (no step selected) offers the bulk re-confirm
  await chainPage(page);
  await page.getByTestId('open-bulk-reconfirm').click();
  const bulk = page.getByTestId('bulk-reconfirm-dialog');
  await expect(bulk.getByTestId('reconfirm-row')).toHaveCount(1);
  await shot(page, 'm4-08-reconfirm');
  await bulk.getByRole('button', { name: '1 erneut bestätigen' }).click();
  await expect.poll(async () => (await placement(proposed['accept']!)).endpointState).toBe('ok');
});

test('a save over a newer revision conflicts; the local copy downloads, then r3 loads', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await chainPage(page);
  await enterEdit(page);
  await selectOnCanvas(page, 'step-disposition');
  await rename(page, 'Disposition (lokal)');

  // meanwhile someone saves r3 over REST
  const head = await content();
  const changed = { ...head.doc, meta: { name: 'Nordwind Handel – Kette (REST)' } };
  const saved = await owner.put(`${API(PROJECT)}/content`, {
    headers: { 'if-match': `"r${head.rev}"`, 'content-type': 'application/json' },
    data: JSON.stringify(changed),
  });
  expect(saved.status()).toBe(200);

  await page.getByTestId('save-chain').click();
  const conflict = page.getByTestId('conflict-dialog');
  await expect(conflict).toContainText('Inzwischen wurde r3 gespeichert, du hast r2 bearbeitet.');
  await shot(page, 'm4-05-conflict');
  const download = page.waitForEvent('download');
  await conflict.getByRole('button', { name: 'Neuere Revision laden' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${PROJECT}-r2-entwurf.vc.json`);
  const local = JSON.parse(readFileSync((await file.path()) ?? '', 'utf8')) as Doc;
  expect(local.elements.find((e) => e.id === 'step-disposition')?.name).toBe('Disposition (lokal)');
  await expect(page.getByTestId('chain-rev')).toHaveText('r3');
  await expect(canvas(page)).toHaveAttribute('data-mode', 'edit');
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'false');
  await finishEdit(page);
});

test('an unsaved edit survives a reload as a draft; restore, then discard', async ({ page }) => {
  test.setTimeout(90_000);
  await chainPage(page);
  await enterEdit(page);
  await selectOnCanvas(page, 'step-disposition');
  await rename(page, 'Disposition (Entwurf)');
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-mode', 'view');
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');

  const stored = await draftKeys(page);
  expect(stored).toHaveLength(1);
  await page.getByTestId('edit-chain').click();
  const draft = page.getByTestId('draft-dialog');
  await expect(draft).toContainText('Ungespeicherter Entwurf gefunden');
  // the import behind the dialog never clears the draft; Escape does not dismiss it; the focus
  // is on the safe action
  await page.waitForTimeout(1000);
  expect(await draftKeys(page)).toEqual(stored);
  await page.keyboard.press('Escape');
  await expect(draft).toBeVisible();
  const restore = draft.getByRole('button', { name: 'Entwurf wiederherstellen' });
  await expect(restore).toBeFocused();
  await restore.click();
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  await page.waitForTimeout(1000);
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  expect(await draftKeys(page)).toEqual(stored);
  await selectOnCanvas(page, 'step-disposition');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Disposition (Entwurf)');

  await page.getByTestId('finish-edit').click();
  await page.getByTestId('discard-dialog').getByRole('button', { name: 'Verwerfen' }).click();
  await expect(canvas(page)).toHaveAttribute('data-mode', 'view');
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  await enterEdit(page);
  await expect(page.getByTestId('draft-dialog')).toHaveCount(0);
  await finishEdit(page);
});

test('a new chain drawn but not saved survives a reload as a draft and stays unsaved', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(`/projects/${SKETCH}/value-chain`);
  await page.getByTestId('create-chain').click();
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  // nothing drawn yet: nothing unsaved, no draft
  await page.waitForTimeout(500);
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'false');
  expect(await draftKeys(page, SKETCH)).toEqual([]);
  await addStep(page, 'Skizzierter Schritt');
  await expect.poll(() => draftKeys(page, SKETCH)).toEqual([`proa:vc-draft:${SKETCH}:new:r0`]);

  await page.reload();
  await page.getByTestId('create-chain').click();
  const draft = page.getByTestId('draft-dialog');
  await expect(draft).toContainText('eine neue Kette gezeichnet');
  await draft.getByRole('button', { name: 'Entwurf wiederherstellen' }).click();
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  // the re-import must not mark it clean and delete the draft 300 ms later
  await page.waitForTimeout(1000);
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  expect(await draftKeys(page, SKETCH)).toEqual([`proa:vc-draft:${SKETCH}:new:r0`]);
  const stored = await page.evaluate(
    (key) => localStorage.getItem(key) ?? '',
    `proa:vc-draft:${SKETCH}:new:r0`,
  );
  expect(stored).toContain('Skizzierter Schritt');
  // the restored step is on the canvas: its panel opens
  const restoredId = (JSON.parse((JSON.parse(stored) as { text: string }).text) as Doc).elements[0]!
    .id;
  await selectOnCanvas(page, restoredId);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Skizzierter Schritt');

  // „Fertig“ asks; discarding removes the draft and nothing was stored
  await page.getByTestId('finish-edit').click();
  await page.getByTestId('discard-dialog').getByRole('button', { name: 'Verwerfen' }).click();
  await expect(page.getByTestId('empty-chain')).toBeVisible();
  expect(await draftKeys(page, SKETCH)).toEqual([]);
  expect((await owner.get(API(SKETCH))).status()).toBe(404);
});

test('an edit committed by the click on „Fertig“ or a link is not lost', async ({ page }) => {
  test.setTimeout(90_000);
  await chainPage(page);
  await enterEdit(page);
  await selectOnCanvas(page, 'step-disposition');
  // typed, no Enter: the click on „Fertig“ commits it by leaving the field
  await page.getByLabel('Name', { exact: true }).fill('Disposition (beim Klick)');
  await page.getByTestId('finish-edit').click();
  const dialog = page.getByTestId('discard-dialog');
  await expect(dialog).toContainText('Bearbeitung beenden?');
  await dialog.getByRole('button', { name: 'Weiter bearbeiten' }).click();
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Disposition (beim Klick)');
  expect(await draftKeys(page)).toHaveLength(1);

  // the same through a link of the header
  await page.getByLabel('Name', { exact: true }).fill('Disposition (beim Link)');
  await page.getByRole('link', { name: 'Prüfen' }).click();
  await expect(dialog).toContainText('Seite verlassen?');
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/value-chain`));
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/value-chain`));

  await page.getByTestId('finish-edit').click();
  await dialog.getByRole('button', { name: 'Verwerfen' }).click();
  await expect(canvas(page)).toHaveAttribute('data-mode', 'view');
  expect(await draftKeys(page)).toEqual([]);
});

test('a step deleted and re-added in a new session gets a fresh id and no old placements', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await chainPage(page);
  await enterEdit(page);
  const first = await addStep(page, 'Neuer Schritt A');
  await save(page);
  await content();
  await finishEdit(page);

  // a manual placement on it
  await chainPage(page, `?step=${first}`);
  await page.getByTestId('add-process').click();
  await page.getByLabel(/Prozess für .* suchen/).fill('Zahlungslauf');
  await page
    .locator(
      '[data-testid=manual-process-option][data-ref="finanzen/zahlungslauf#Process_Zahlungslauf"]',
    )
    .click();
  await page
    .getByTestId('manual-placement-form')
    .getByRole('button', { name: 'Platzieren' })
    .click();
  await expect
    .poll(async () => (await allPlacements(`&elementId=${first}`)).map((p) => p.status))
    .toEqual(['accepted']);
  const [old] = await allPlacements(`&elementId=${first}`);

  // delete it: the dry run names it with its accepted placement
  await enterEdit(page);
  await selectOnCanvas(page, first);
  await page.locator('.djs-context-pad [data-action="delete"]').click();
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  await page.getByTestId('save-chain').click();
  const impact = page.getByTestId('impact-dialog');
  await expect(impact.getByTestId('impact-removed')).toContainText('Neuer Schritt A');
  await expect(impact.getByTestId('impact-removed')).toContainText('bleibt als offener Punkt');
  await impact.getByRole('button', { name: 'Trotzdem speichern' }).click();
  await expect(
    page
      .getByTestId('toast')
      .filter({ hasText: /Gespeichert als r\d+/ })
      .last(),
  ).toBeVisible();
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'false');

  // a new session: the modeler's own factory would hand out the deleted id again
  await page.reload();
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  await enterEdit(page);
  const second = await addStep(page, 'Neuer Schritt B');
  await save(page);
  expect(second).not.toBe(first);
  expect(seenIds.has(second)).toBe(false);
  await content();
  const after = await detail();
  expect(after.steps.find((s) => s.elementId === second)?.counts).toEqual({
    accepted: 0,
    proposed: 0,
    held: 0,
  });
  const stale = await placement(old!.id);
  expect(stale).toMatchObject({ stepLive: false, endpointState: 'missing', status: 'accepted' });
  await finishEdit(page);
});

test('link: set via the process picker, undo, set again; the rule proposal; clear', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const process = 'finanzen/forderungsmanagement#Process_Forderungsmanagement';
  await chainPage(page);
  await enterEdit(page);
  await selectOnCanvas(page, 'step-offene-posten');
  const editor = page.getByTestId('link-editor');
  await editor.getByRole('radio', { name: 'ProA-Prozess' }).click();
  await editor.getByLabel('Prozess suchen').fill('Forderungsmanagement');
  const option = editor.locator(`[data-testid=link-process-option][data-ref="${process}"]`);
  await option.click();
  await expect(option).toHaveAttribute('data-state', 'checked');
  await shot(page, 'm4-03-edit-link');
  // picking only marks the process; „Übernehmen“ sets the link
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'false');
  await editor.getByTestId('apply-process-link').click();
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');

  // Ctrl+Z on the canvas undoes the link in one step
  await page.locator('[data-testid=vc-canvas] svg').first().focus();
  await page.keyboard.press('Control+z');
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'false');
  await expect(
    page.getByTestId('link-editor').getByRole('radio', { name: 'Kein Link' }),
  ).toHaveAttribute('data-state', 'on');

  await page.getByTestId('link-editor').getByRole('radio', { name: 'ProA-Prozess' }).click();
  await page.getByTestId('link-editor').getByLabel('Prozess suchen').fill('Forderungsmanagement');
  // by keyboard: the arrows only move the mark, Enter sets the link; the focus stays in the list
  await page.getByTestId('link-editor').getByLabel('Prozess suchen').press('Tab');
  const marked = page.locator(`[data-testid=link-process-option][data-ref="${process}"]`);
  await expect(marked).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  await expect(marked).toBeFocused();
  await save(page);
  const linked = await content();
  expect(linked.doc.elements.find((e) => e.id === 'step-offene-posten')?.link).toBe(
    `proa:process/${process}`,
  );
  const rule = (await allPlacements('&elementId=step-offene-posten')).find(
    (p) => p.process === process,
  );
  expect(rule).toMatchObject({
    status: 'proposed',
    tier: 'key',
    source: 'rule',
    provenance: expect.objectContaining({ sourceKind: 'rule', handle: 'proa-rules' }),
  });
  await finishEdit(page);

  // view mode: a double-click follows the link into the model view
  await shape(page, 'step-offene-posten').dblclick();
  await expect(page).toHaveURL(
    /\/models\/finanzen\/forderungsmanagement\?element=Process_Forderungsmanagement$/,
  );
  await expect(page.getByTestId('model-view')).toBeVisible();

  // clear it: no link in the content, the rule proposal is obsolete
  await chainPage(page);
  await enterEdit(page);
  await selectOnCanvas(page, 'step-offene-posten');
  await page.getByTestId('link-editor').getByRole('radio', { name: 'Kein Link' }).click();
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  await save(page);
  const cleared = await content();
  expect(cleared.doc.elements.find((e) => e.id === 'step-offene-posten')?.link).toBeUndefined();
  expect((await placement(rule!.id)).status).toBe('obsolete');
  await finishEdit(page);
});

test('drill-down: double-click opens the step view with sub-steps, processes and calls', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // an accepted call: its caller placed on Auftragsabwicklung, so the callee is reached by call
  const landscape = (await (await owner.get(`/api/v1/projects/${PROJECT}/landscape`)).json()) as {
    relations: { id: string; type: string; status: string; from: string; to: string }[];
  };
  const models = (await (
    await owner.get(`/api/v1/projects/${PROJECT}/models?limit=200`)
  ).json()) as {
    items: { id: string; key: string; headRevisionId: string }[];
  };
  const call = landscape.relations.find((r) => r.type === 'call' && r.status === 'accepted');
  expect(call).toBeDefined();
  const callerKey = call!.from.split('#')[0]!;
  const callerModel = models.items.find((m) => m.key === callerKey)!;
  const facts = (await (
    await owner.get(
      `/api/v1/projects/${PROJECT}/models/${callerModel.id}/revisions/${callerModel.headRevisionId}/facts`,
    )
  ).json()) as { facts: { ref: string; processId: string | null }[] };
  const caller = `${callerKey}#${facts.facts.find((f) => f.ref === call!.from)?.processId}`;
  const manual = await owner.post(`${API(PROJECT)}/placements`, {
    data: { kind: 'manual', step: 'step-auftragsabwicklung', process: caller, rationale: 'e2e' },
  });
  expect(manual.ok()).toBe(true);

  await chainPage(page);
  await shape(page, 'step-vertrieb').dblclick();
  await expect(page).toHaveURL(/\/value-chain\/steps\/step-vertrieb$/);
  await expect(page.getByTestId('step-breadcrumb')).toContainText('Wertschöpfungskette');
  await page.getByTestId('sub-step').filter({ hasText: 'Auftragsabwicklung' }).click();
  await expect(page.getByTestId('step-breadcrumb')).toContainText(
    /Wertschöpfungskette.*Vertrieb.*Auftragsabwicklung/,
  );
  const own = page.getByTestId('step-view-placement').filter({ hasText: caller });
  await expect(own).toBeVisible();
  await expect(page.getByTestId('reached-by-call')).toContainText(call!.to);
  await expect(page.getByTestId('via-relation').first()).toHaveAttribute(
    'href',
    `/projects/${PROJECT}/review/${call!.id}`,
  );
  await shot(page, 'm4-06-step-view');
  await own.getByRole('link', { name: 'Im Modell' }).click();
  await expect(page).toHaveURL(new RegExp(`/models/${callerKey}\\?element=`));
});

test('re-import and a layout-only save keep decided placements decided and ok', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const before = (await allPlacements()).map((p) => [p.id, p.status, p.endpointState]);
  const reimported = await owner.post(`/api/v1/projects/${PROJECT}/imports`, {
    multipart: modelsForm(),
  });
  expect(reimported.ok()).toBe(true);
  const outcomes = (await reimported.json()) as { files: { outcome: string }[] };
  expect(new Set(outcomes.files.map((f) => f.outcome))).toEqual(new Set(['unchanged']));

  await chainPage(page);
  const head = await content();
  await enterEdit(page);
  await selectOnCanvas(page, 'step-kundenservice');
  await page.locator('[data-testid=vc-canvas] svg').first().focus();
  await page.keyboard.press('Shift+ArrowDown');
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'true');
  // a save nobody has to confirm shows no impact dialog, even when the request takes a while
  await page.route(`**${API(PROJECT)}/content`, async (route) => {
    if (route.request().method() === 'PUT' && !route.request().url().includes('dryRun')) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  await page.getByTestId('save-chain').click();
  await expect(page.getByTestId('save-chain')).toBeDisabled();
  await expect(page.getByTestId('impact-dialog')).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(page.getByTestId('impact-dialog')).toHaveCount(0);
  const toast = page
    .getByTestId('toast')
    .filter({ hasText: /Gespeichert als r\d+/ })
    .last();
  await expect(toast).toBeVisible();
  await page.unroute(`**${API(PROJECT)}/content`);
  const rev = Number(/r(\d+)/.exec((await toast.textContent()) ?? '')?.[1]);
  await expect(canvas(page)).toHaveAttribute('data-dirty', 'false');
  expect(rev).toBe(head.rev + 1);
  const moved = await content();
  expect(moved.text).not.toBe(head.text);
  const revisions = (await (await owner.get(`${API(PROJECT)}/revisions?limit=2`)).json()) as {
    items: { structureHash: string }[];
  };
  expect(revisions.items[0]!.structureHash).toBe(revisions.items[1]!.structureHash);
  expect((await allPlacements()).map((p) => [p.id, p.status, p.endpointState])).toEqual(before);
  expect((await placement(proposed['accept']!)).endpointState).toBe('ok');
  await finishEdit(page);
});

test('an agent cannot decide; its reviewUrl opens the chain page with the card active', async ({
  page,
}) => {
  const refused = await agent.post(`${API(PROJECT)}/placements/${proposed['hostile']}/decision`, {
    data: { verdict: 'accept' },
  });
  expect(refused.status()).toBe(403);
  const problem = (await refused.json()) as { code: string; reviewUrl: string };
  expect(problem.code).toBe('human-decision-required');
  const url = new URL(problem.reviewUrl);
  expect(`${url.pathname}${url.search}`).toBe(
    `/projects/${PROJECT}/value-chain?placement=${proposed['hostile']}`,
  );
  await page.goto(`${url.pathname}${url.search}`);
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  await expect(
    page.locator(`[data-testid=placement-card][data-placement-id="${proposed['hostile']}"]`),
  ).toHaveAttribute('data-active', 'true');
  expect((await placement(proposed['hostile']!)).status).toBe('proposed');

  // a card far down the overview (outside the chain) scrolls into view
  await chainPage(page, `?placement=${proposed['outside']}`);
  const outside = page.locator(
    `[data-testid=placement-card][data-placement-id="${proposed['outside']}"]`,
  );
  await expect(outside).toHaveAttribute('data-active', 'true');
  await expect(outside).toBeInViewport();
});

// ---------------------------------------------------------------- CSS check

interface Probe {
  [key: string]: string;
}

/** Computed styles of the bpmn-js review screen that diagram-js.css and bpmn-js.css decide. */
async function probeReview(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const style = (selector: string, props: string[]) => {
      const el = document.querySelector(selector);
      if (!el) return { missing: selector };
      const css = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [`${selector} ${p}`, css.getPropertyValue(p)]));
    };
    return {
      ...style('.djs-container', ['font-family', 'position', 'overflow']),
      ...style('.djs-shape .djs-visual > rect', ['stroke', 'fill', 'stroke-width']),
      ...style('.djs-connection .djs-visual > path', ['stroke', 'stroke-width', 'fill']),
      ...style('.djs-label', ['font-family', 'font-size', 'fill']),
      ...style('.proa-overlay', ['background-color', 'font-family', 'font-size', 'padding-left']),
      ...style('.djs-element.proa-endpoint .djs-visual > :first-child', ['stroke', 'stroke-width']),
      ...style('[role=group][aria-label=Zoom]', [
        'background-color',
        'border-top-color',
        'padding-top',
      ]),
      ...style('aside[aria-label=Prüfung]', ['font-family', 'font-size', 'background-color']),
      ...style('.bjs-powered-by', ['position', 'z-index']),
    };
  });
}

async function probeChain(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const style = (selector: string, props: string[]) => {
      const el = document.querySelector(selector);
      if (!el) return { missing: selector };
      const css = getComputedStyle(el);
      return Object.fromEntries(props.map((p) => [`${selector} ${p}`, css.getPropertyValue(p)]));
    };
    return {
      ...style('.vc-container', ['font-family', 'background-color', 'position']),
      ...style('.djs-shape .djs-visual > path', ['stroke', 'stroke-width', 'fill']),
      ...style('.djs-shape .djs-visual > text', ['font-family', 'font-size', 'fill']),
      ...style('.djs-connection .djs-visual > path', ['stroke', 'stroke-width']),
      ...style('.proa-vc-badge', ['background-color', 'font-family', 'font-size']),
    };
  });
}

/** In-app navigation (no reload, so the session's stylesheets stay). */
async function spaNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

async function reviewReady(page: Page): Promise<void> {
  await expect(page.getByTestId('review-details')).toBeVisible();
  const canvases = page.getByTestId('bpmn-canvas');
  await expect(canvases.first()).toBeVisible();
  for (let i = 0; i < (await canvases.count()); i += 1)
    await expect(canvases.nth(i)).toHaveAttribute('data-imported', 'true');
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
}

async function paneShots(page: Page): Promise<Buffer[]> {
  const panes = page.getByTestId('review-pane');
  const out: Buffer[] = [];
  for (let i = 0; i < (await panes.count()); i += 1)
    out.push(await panes.nth(i).screenshot({ animations: 'disabled' }));
  return out;
}

test('CSS check: the bpmn-js review screen is unchanged after the chain page', async ({ page }) => {
  test.setTimeout(120_000);
  const landscape = (await (await owner.get(`/api/v1/projects/${PROJECT}/landscape`)).json()) as {
    relations: { id: string; from: string; to: string }[];
  };
  const relation = landscape.relations.find((r) => r.from.split('#')[0] !== r.to.split('#')[0]);
  expect(relation).toBeDefined();
  const reviewPath = `/projects/${PROJECT}/review/${relation!.id}`;

  await page.goto(reviewPath);
  await reviewReady(page);
  const before = await probeReview(page);
  expect(Object.keys(before)).not.toContain('missing');
  const shotsBefore = await paneShots(page);

  // to the chain page through the project tabs, view and edit mode, and back
  await page.getByRole('link', { name: /Prüfliste/ }).click();
  await page.getByRole('link', { name: /^Wertschöpfungskette/ }).click();
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  await enterEdit(page);
  await finishEdit(page);
  await spaNavigate(page, reviewPath);
  await reviewReady(page);
  expect(await probeReview(page)).toEqual(before);
  expect(await paneShots(page)).toEqual(shotsBefore);
});

test('CSS check: the chain page is unchanged after the review screen', async ({ page }) => {
  test.setTimeout(120_000);
  const landscape = (await (await owner.get(`/api/v1/projects/${PROJECT}/landscape`)).json()) as {
    relations: { id: string; from: string; to: string }[];
  };
  const relation = landscape.relations.find((r) => r.from.split('#')[0] !== r.to.split('#')[0]);
  const chainPath = `/projects/${PROJECT}/value-chain`;
  await chainPage(page);
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  const before = await probeChain(page);
  expect(Object.keys(before)).not.toContain('missing');
  const shotBefore = await canvas(page).screenshot({ animations: 'disabled' });

  await spaNavigate(page, `/projects/${PROJECT}/review/${relation!.id}`);
  await reviewReady(page);
  await spaNavigate(page, chainPath);
  await expect(canvas(page)).toHaveAttribute('data-imported', 'true');
  await page.mouse.move(0, 0);
  expect(await probeChain(page)).toEqual(before);
  expect(await canvas(page).screenshot({ animations: 'disabled' })).toEqual(shotBefore);
});
