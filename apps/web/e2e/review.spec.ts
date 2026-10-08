import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The M2 review flow (M2 item 7) against a running server with the built UI.
 * It creates its own project from eval/corpus/nordwind-handel, works part of
 * the pipeline as an agent over REST with an agent token (claim, submit
 * proposals built from the claim input's lexical candidates, release one
 * task, keep one claimed), then reviews in the browser: inbox by stage, the
 * review screen with both models, A/R/H/C and J/K, the held list with an
 * answer, a correction and its timeline, a version conflict and the bulk
 * accept of the key tier. With PROA_SCREENSHOTS_DIR set it writes
 * m2-*.png there. Skips itself when no server answers.
 */

const CORPUS = join(import.meta.dirname, '../../../eval/corpus/nordwind-handel/models');
const PROJECT = `review-${Date.now().toString(36)}`;
const SHOTS = process.env['PROA_SCREENSHOTS_DIR'];
const AGENT_NAME = 'e2e-sim';

interface ClaimFact {
  ref: string;
  kind: string;
  label: string;
}
interface Claimed {
  taskId: string;
  modelKey: string;
  leaseToken: string;
  procedure: { id: string; version: string };
  input: {
    facts: ClaimFact[];
    candidates: [string, string, string, string, number][];
    partners: Record<string, { label: string }>;
  };
}
interface SubmissionResult {
  items: { index: number; result: string; relationId: string | null }[];
}
interface Relation {
  id: string;
  status: string;
  version: number;
  tier: string;
  from: string;
  to: string;
}

/** Relations the agent proposed, in submission order (highest confidence first). */
const proposed: string[] = [];
/** The proposal whose rationale carries HTML (must render as text); lowest confidence. */
let hostileId = '';
/** The tier most agent proposals landed in (the server computes it); the flow walks it. */
let agentTier = '';
/** The owner (session cookie) and the agent (bearer token) as API clients. */
let owner: APIRequestContext;
let agent: APIRequestContext;

function bpmnFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? bpmnFiles(path) : name.endsWith('.bpmn') ? [path] : [];
  });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

async function relationOf(id: string): Promise<Relation> {
  const response = await owner.get(`/api/v1/projects/${PROJECT}/relations/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Relation;
}

/** Waits until the review screen shows `id` with both diagrams imported. */
async function onReviewScreen(page: Page, id?: string): Promise<string> {
  if (id) await expect(page).toHaveURL(new RegExp(`/review/${id}`));
  await expect(page.getByTestId('review-details')).toBeVisible();
  const canvases = page.getByTestId('bpmn-canvas');
  // the panes mount after the details; count them only once one is there
  await expect(canvases.first()).toBeVisible();
  const count = await canvases.count();
  for (let i = 0; i < count; i += 1) {
    await expect(canvases.nth(i)).toHaveAttribute('data-imported', 'true');
  }
  const match = /\/review\/(rel_[0-9A-Z]+)/.exec(page.url());
  return match?.[1] ?? '';
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
  const probe = await playwright.request.newContext({
    baseURL: baseURL ?? 'http://127.0.0.1:7400',
  });
  const health = await probe.get('/health', { timeout: 3000 }).catch(() => null);
  await probe.dispose();
  test.skip(!health?.ok(), 'no ProA server at PROA_E2E_URL; start one to run the review flow');

  // owner: project, models, agent token (the context keeps the session cookie)
  owner = await playwright.request.newContext({ baseURL: baseURL ?? 'http://127.0.0.1:7400' });
  const request = owner;
  expect((await request.post('/api/v1/session', { data: { client: 'proa-web' } })).ok()).toBe(true);
  const created = await request.post('/api/v1/projects', {
    data: { key: PROJECT, name: 'Nordwind Handel (Review)' },
  });
  expect(created.status()).toBe(201);
  const form = new FormData();
  for (const file of bpmnFiles(CORPUS)) {
    form.append(
      'files',
      new File([readFileSync(file)], relative(CORPUS, file), { type: 'application/xml' }),
    );
  }
  const imported = await request.post(`/api/v1/projects/${PROJECT}/imports`, { multipart: form });
  expect(imported.ok()).toBe(true);
  const token = await request.post(`/api/v1/projects/${PROJECT}/agent-tokens`, {
    data: { name: AGENT_NAME, scopes: ['proa:read', 'proa:propose'] },
  });
  expect(token.status()).toBe(201);
  const { secret } = (await token.json()) as { secret: string };
  agent = await playwright.request.newContext({
    baseURL: baseURL ?? 'http://127.0.0.1:7400',
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  });

  // agent: claim ten tasks, submit eight, release one, keep one claimed
  const claimed: Claimed[] = [];
  for (let round = 0; round < 2; round += 1) {
    const claim = await agent.post('/api/v1/analyses/claim', {
      data: { projectId: PROJECT, max: 5 },
    });
    expect(claim.ok()).toBe(true);
    claimed.push(...((await claim.json()) as { items: Claimed[] }).items);
  }
  expect(claimed.length).toBe(10);
  const used = new Set<string>();
  let rank = 0;
  for (const [n, task] of claimed.slice(0, 8).entries()) {
    const labelOf = (ref: string) =>
      task.input.facts.find((f) => f.ref === ref)?.label ?? task.input.partners[ref]?.label ?? ref;
    const evidenceTask = task.input.facts.find((f) => f.kind === 'task')?.ref;
    const picks = task.input.candidates
      .filter(([, from, to, basis]) => basis === 'lexical' && !used.has(`${from}>${to}`))
      .sort((a, b) => b[4] - a[4])
      .slice(0, 2);
    const relations = picks.map(([type, from, to], i) => {
      used.add(`${from}>${to}`);
      const first = n === 0 && i === 0;
      const hostile = n === 1 && i === 0;
      rank += 1;
      return {
        type,
        from,
        to,
        // above every rule proposal outside the key tier (≤ 0.8), falling in submission order
        confidence: hostile ? 0.81 : Math.round((0.97 - rank * 0.005) * 1000) / 1000,
        rationale: hostile
          ? `„${labelOf(from)}“ löst „${labelOf(to)}“ aus. <img src=x onerror="alert(1)"> <b>kein HTML</b>`
          : `„${labelOf(from)}“ und „${labelOf(to)}“ beschreiben denselben fachlichen Vorgang; die Bezeichnungen unterscheiden sich nur in der Formulierung.`,
        evidence: [from, to, ...(evidenceTask ? [evidenceTask] : []), 'Prozesshandbuch Kap. 3'],
        question: first ? 'Gilt das auch für Teillieferungen?' : null,
      };
    });
    const submitted = await agent.post(`/api/v1/analyses/${task.taskId}/submission`, {
      data: {
        leaseToken: task.leaseToken,
        submissionId: randomUUID(),
        procedure: task.procedure,
        llmModel: 'sim-e2e',
        relations,
        summary: `${relations.length} Vorschläge`,
      },
    });
    expect(submitted.ok()).toBe(true);
    const result = (await submitted.json()) as SubmissionResult;
    for (const item of result.items) {
      if (item.result === 'applied' && item.relationId) {
        proposed.push(item.relationId);
        if (n === 1 && item.index === 0) hostileId = item.relationId;
      }
    }
  }
  const release = claimed[8]!;
  expect(
    (
      await agent.post(`/api/v1/analyses/${release.taskId}/release`, {
        data: { leaseToken: release.leaseToken, reason: 'e2e' },
      })
    ).ok(),
  ).toBe(true);
  expect(proposed.length).toBeGreaterThanOrEqual(6);
  expect(hostileId).not.toBe('');
  const tiers = new Map<string, number>();
  for (const id of proposed) {
    const { tier } = await relationOf(id);
    tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
  }
  agentTier = [...tiers].sort((a, b) => b[1] - a[1])[0]![0];
  // the flow decides four proposals of that tier and keeps the HTML one for last
  expect(tiers.get(agentTier)).toBeGreaterThanOrEqual(5);
});

test.afterAll(async () => {
  await agent?.dispose();
  await owner?.dispose();
});

test('inbox: models by stage and the review queue', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/review`);
  await expect(page.getByRole('link', { name: /Prüfen/ }).first()).toBeVisible();
  const stage = (s: string) => page.locator(`[data-testid=stage-filter][data-stage=${s}]`);
  await expect(stage('agent_working')).toHaveAttribute('data-count', '1');
  await expect(stage('waiting_for_agent')).toHaveAttribute('data-count', '22');
  await expect(page.getByTestId('queue-row').first()).toBeVisible();
  const rows = await page.getByTestId('queue-row').count();
  expect(rows).toBeGreaterThan(proposed.length);
  await shot(page, 'm2-01-inbox');

  // a stage is a filter: who works on what
  await stage('agent_working').click();
  await expect(page.getByTestId('stage-model-row')).toHaveCount(1);
  await expect(page.getByTestId('stage-model-row')).toContainText(`agent:${AGENT_NAME}`);
  await stage('agent_working').click();
  await expect(page.getByTestId('stage-models')).toHaveCount(0);
});

test('review screen: both models, highlights, rationale, evidence, provenance', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT}/review?tier=${agentTier}`);
  const first = page.getByTestId('queue-row').first();
  await first.getByRole('link', { name: /Prüfen/ }).click();
  await onReviewScreen(page);
  await expect(page.getByTestId('review-pane')).toHaveCount(2);
  await expect(page.locator('.proa-overlay', { hasText: 'Von' })).toBeVisible();
  await expect(page.locator('.proa-overlay', { hasText: 'Nach' })).toBeVisible();
  await expect(page.locator('.djs-element.proa-endpoint')).toHaveCount(2);
  const details = page.getByTestId('review-details');
  await expect(details).toContainText('beschreiben denselben fachlichen Vorgang');
  await expect(details).toContainText(`agent:${AGENT_NAME}`);
  await expect(details).toContainText('proa-relations@');
  await expect(details).toContainText('sim-e2e');
  await expect(page.getByTestId('queue-position')).toContainText(/^1 von \d+/);

  await shot(page, 'm2-02-review');

  // evidence refs into the models are clickable and highlight the element
  const evidence = page.getByTestId('evidence-ref');
  if ((await evidence.count()) > 2) {
    await evidence.nth(2).click();
    await expect(page.locator('.proa-overlay', { hasText: 'Beleg' })).toBeVisible();
  }
  await expect(details).toContainText('Prozesshandbuch Kap. 3');

  // J/K walk the queue
  const id = await onReviewScreen(page);
  await page.keyboard.press('j');
  await expect(page).not.toHaveURL(new RegExp(id));
  await expect(page.getByTestId('queue-position')).toContainText(/^2 von/);
  await page.keyboard.press('k');
  await onReviewScreen(page, id);
});

test('decide with the keyboard: A accepts, R rejects with a reason, H holds', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/review?tier=${agentTier}`);
  await page
    .getByTestId('queue-row')
    .first()
    .getByRole('link', { name: /Prüfen/ })
    .click();
  const accepted = await onReviewScreen(page);

  await page.keyboard.press('a');
  await expect(page.getByTestId('toast').filter({ hasText: 'Angenommen' })).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(accepted));
  expect((await relationOf(accepted)).status).toBe('accepted');

  const rejected = await onReviewScreen(page);
  await page.keyboard.press('r');
  await page.getByLabel('Grund der Ablehnung').fill('Anderer Vorgang trotz ähnlicher Bezeichnung.');
  await page.keyboard.press('Control+Enter');
  await expect(page.getByTestId('toast').filter({ hasText: 'Abgelehnt' })).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(rejected));
  expect((await relationOf(rejected)).status).toBe('rejected');

  const held = await onReviewScreen(page);
  await page.keyboard.press('h');
  await page
    .getByLabel('Notiz')
    .fill('Fachbereich muss bestätigen, ob die Nachricht hier ankommt.');
  await page.getByLabel('Frage (optional)').fill('Kommt die Meldung auch bei Expresslieferungen?');
  await page.getByLabel('Label (optional)').fill('mit Fachbereich Logistik klären');
  await page.getByRole('button', { name: 'Vormerken' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Vorgemerkt' })).toBeVisible();
  expect((await relationOf(held)).status).toBe('held');
});

test('held list: answer a held question', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/review?view=held`);
  const item = page.getByTestId('held-item').first();
  await expect(item).toContainText('mit Fachbereich Logistik klären');
  await expect(item).toContainText('Kommt die Meldung auch bei Expresslieferungen?');
  await item
    .getByRole('textbox', { name: 'Antwort' })
    .fill('Ja, Logistik bestätigt: auch bei Expresslieferungen.');
  await item.getByRole('button', { name: /Antwort speichern/ }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Antwort gespeichert' })).toBeVisible();
  await expect(item.getByTestId('held-answer')).toContainText('auch bei Expresslieferungen');
  await shot(page, 'm2-04-held');
});

test('correct: another endpoint becomes a manual relation; the timeline links both', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT}/review?tier=${agentTier}`);
  await page
    .getByTestId('queue-row')
    .first()
    .getByRole('link', { name: /Prüfen/ })
    .click();
  const original = await onReviewScreen(page);
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Relation korrigieren' });
  await expect(dialog).toBeVisible();
  const candidates = dialog.getByTestId('correction-candidate');
  await expect(candidates.first()).toBeVisible();
  await candidates.first().click();
  await dialog.getByLabel('Begründung').fill('Der Vorgang endet beim anderen Empfänger.');
  await shot(page, 'm2-05-correct');
  await dialog.getByRole('button', { name: 'Korrigieren' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Korrigiert' })).toBeVisible();

  await page.goto(`/projects/${PROJECT}/review/${original}`);
  await onReviewScreen(page, original);
  const reject = page.locator('[data-testid=timeline-entry][data-verdict=reject]');
  await expect(reject).toContainText('Der Vorgang endet beim anderen Empfänger.');
  await reject.getByRole('link', { name: /Korrigiert durch/ }).scrollIntoViewIfNeeded();
  await shot(page, 'm2-06-timeline');
  await reject.getByRole('link', { name: /Korrigiert durch/ }).click();
  await onReviewScreen(page);
  await expect(page.getByTestId('review-details')).toContainText('Manuell');
  await expect(
    page.locator('[data-testid=timeline-entry][data-verdict=accept]').getByRole('link'),
  ).toContainText(original);
});

test('agent text renders as text, and a stale decision shows a conflict', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/review/${hostileId}`);
  await onReviewScreen(page, hostileId);
  const details = page.getByTestId('review-details');
  await expect(details).toContainText('<img src=x onerror="alert(1)"> <b>kein HTML</b>');
  await expect(details.locator('img, b')).toHaveCount(0);

  // meanwhile the relation changes (another decision); the UI still has the old version
  const before = await relationOf(hostileId);
  const hold = await owner.post(`/api/v1/projects/${PROJECT}/relations/${hostileId}/decision`, {
    data: { verdict: 'hold', note: 'In einem anderen Fenster vorgemerkt', version: before.version },
  });
  expect(hold.ok()).toBe(true);
  await page.getByRole('button', { name: /Ablehnen/ }).click();
  await page.getByLabel('Grund der Ablehnung').fill('Passt nicht.');
  await page.getByRole('button', { name: 'Ablehnen' }).click();
  const conflict = page.getByTestId('decision-conflict');
  await expect(conflict).toContainText('Die Relation wurde inzwischen geändert');
  await expect(conflict).toContainText(`du hast Version ${before.version} gesehen`);
  await shot(page, 'm2-07-conflict');
  expect((await relationOf(hostileId)).status).toBe('held');
});

test('bulk accept of the key tier with generic names flagged', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/review`);
  await page.locator('[data-testid=bulk-open][data-tier=key]').click();
  const dialog = page.getByTestId('bulk-dialog');
  await expect(dialog).toBeVisible();
  const rows = dialog.getByTestId('bulk-row');
  const total = await rows.count();
  expect(total).toBeGreaterThan(10);
  const flagged = dialog.locator('[data-testid=bulk-row][data-flagged=true]');
  await expect(flagged.first()).toBeVisible();
  await expect(dialog.getByTestId('generic-flag').first()).toBeVisible();
  const nFlagged = await flagged.count();
  await shot(page, 'm2-03-bulk');
  await dialog.getByRole('button', { name: new RegExp(`^${total - nFlagged} annehmen$`) }).click();
  await expect(
    page.getByTestId('toast').filter({ hasText: `${total - nFlagged} Relationen angenommen` }),
  ).toBeVisible();
  await expect(dialog).toHaveCount(0);
  // the flagged pairs stay open for a closer look
  await page.goto(`/projects/${PROJECT}/review?tier=key`);
  await expect(page.getByTestId('queue-row')).toHaveCount(nFlagged);
  const landscape = (await (await owner.get(`/api/v1/projects/${PROJECT}/landscape`)).json()) as {
    relations: Relation[];
  };
  expect(
    landscape.relations.filter((r) => r.tier === 'key' && r.status === 'proposed').length,
  ).toBe(nFlagged);
});
