import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { DEMO_SKIP, probeServer } from './server-mode';

/**
 * Auto-accept rules in the browser (owner decision 19) against a running
 * server with the built UI: a project from eval/corpus/nordwind-handel with
 * its golden chain and an agent token; the agent proposes key-tier pairs ad
 * hoc over REST (one the owner accepts, two at 0.97/0.96, one at 0.6). The
 * tab „Regeln“ shows the system rule and the empty state; a rule is created
 * with its live preview (history precision, open count), saved and enabled,
 * and applied to the open proposals (dry run, then „2 Vorschläge annehmen“).
 * The Relations tab marks and filters the two; the review screen names rule,
 * revision, owner and agent; the rule's „Widerrufen…“ returns both to
 * „Prüfen“, marked „widerrufen“. A placement rule (over REST) shows its mark
 * on the chain page. Then the rule dialog meets a 412 (the rule was raised
 * over REST meanwhile) and „Neuere Revision laden“ puts the newer revision
 * into the form, and „Annahmen eines Agenten widerrufen“ revokes the agent's
 * remaining acceptance. No CSP violation on the way. With
 * PROA_SCREENSHOTS_DIR it writes d19-*.png. Skips itself when no server
 * answers.
 */

const ROOT = join(import.meta.dirname, '../../..');
const CORPUS = join(ROOT, 'eval/corpus/nordwind-handel/models');
const GOLDEN = join(ROOT, 'eval/value-chains/nordwind-handel/value-chain.vc.json');
const PROJECT = `autoaccept-${Date.now().toString(36)}`;
const BASE = `/api/v1/projects/${PROJECT}`;
const CHAIN = `${BASE}/value-chains/main`;
const SHOTS = process.env['PROA_SCREENSHOTS_DIR'];
const RULE_NAME = 'Schlüssel-Vorschläge ab 95 %';

interface Relation {
  id: string;
  type: string;
  from: string;
  to: string;
  status: string;
  tier: string;
  version: number;
}

let owner: APIRequestContext;
let agent: APIRequestContext;
let tokenId = '';
/** The two proposals the rule accepts (0.97, 0.96). */
const accepted: string[] = [];

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
  const response = await owner.get(`${BASE}/relations/${id}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Relation;
}

test.describe.configure({ mode: 'serial' });

const cspViolations: string[] = [];
test.beforeEach(({ page }) => {
  cspViolations.length = 0;
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|CSP violation/i.test(message.text()))
      cspViolations.push(message.text());
  });
});
test.afterEach(() => {
  expect(cspViolations).toEqual([]);
});

test.beforeAll(async ({ playwright, baseURL }) => {
  test.setTimeout(120_000);
  const base = baseURL ?? 'http://127.0.0.1:7400';
  const probe = await playwright.request.newContext({ baseURL: base });
  const mode = await probeServer(probe);
  await probe.dispose();
  test.skip(mode === 'down', 'no ProA server at PROA_E2E_URL; start one to run the rules flow');
  test.skip(mode === 'demo', DEMO_SKIP);

  owner = await playwright.request.newContext({ baseURL: base });
  expect((await owner.post('/api/v1/session', { data: { client: 'proa-web' } })).ok()).toBe(true);
  expect(
    (
      await owner.post('/api/v1/projects', { data: { key: PROJECT, name: 'Nordwind (Regeln)' } })
    ).status(),
  ).toBe(201);
  const form = new FormData();
  for (const file of bpmnFiles(CORPUS)) {
    form.append(
      'files',
      new File([readFileSync(file)], relative(CORPUS, file), { type: 'application/xml' }),
    );
  }
  expect((await owner.post(`${BASE}/imports`, { multipart: form })).ok()).toBe(true);
  expect(
    (
      await owner.put(`${CHAIN}/content`, {
        headers: { 'if-none-match': '*', 'content-type': 'application/json' },
        data: readFileSync(GOLDEN, 'utf8'),
      })
    ).status(),
  ).toBe(201);
  const token = await owner.post(`${BASE}/agent-tokens`, {
    data: { name: 'e2e-rules', scopes: ['proa:read', 'proa:propose'], expiresInDays: 1 },
  });
  expect(token.status()).toBe(201);
  const created = (await token.json()) as { secret: string; id: string };
  tokenId = created.id;
  agent = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { authorization: `Bearer ${created.secret}` },
  });

  // The agent proposes four key-tier pairs the rule tier proposed (messages and signals, no calls).
  const landscape = (await (await owner.get(`${BASE}/landscape`)).json()) as {
    relations: Relation[];
  };
  const pairs = landscape.relations
    .filter((r) => r.status === 'proposed' && r.tier === 'key' && r.type !== 'call')
    .slice(0, 4);
  expect(pairs).toHaveLength(4);
  const propose = async (r: Relation, confidence: number) => {
    const response = await agent.post(`${BASE}/relations`, {
      data: {
        type: r.type,
        from: r.from,
        to: r.to,
        confidence,
        rationale: 'Gleicher Name auf beiden Seiten.',
        llmModel: 'e2e-model',
      },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { relation: Relation }).relation;
  };
  // History: a proposal at 0.98 the owner accepts.
  const decided = await propose(pairs[0]!, 0.98);
  expect(
    (
      await owner.post(`${BASE}/relations/${decided.id}/decision`, {
        data: { verdict: 'accept', version: decided.version },
      })
    ).ok(),
  ).toBe(true);
  accepted.push((await propose(pairs[1]!, 0.97)).id, (await propose(pairs[2]!, 0.96)).id);
  await propose(pairs[3]!, 0.6);
});

test.afterAll(async () => {
  if (owner && tokenId) await owner.delete(`${BASE}/agent-tokens/${tokenId}`);
  await agent?.dispose();
  await owner?.dispose();
});

test('the tab „Regeln“: system rule, empty state, a rule with its live preview, apply', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT}/rules`);
  await expect(page.getByTestId('system-rule')).toContainText('Systemregel: Eindeutige Aufrufe');
  await expect(page.getByTestId('system-rule')).toContainText('immer aktiv, nicht änderbar');
  await expect(page.getByTestId('rules-empty')).toContainText(
    'Ohne Regeln entscheidest du jeden Vorschlag selbst.',
  );
  await shot(page, 'd19-01-rules-empty');

  await page.getByTestId('new-rule').click();
  const dialog = page.getByTestId('rule-dialog');
  await dialog.getByLabel('Name').fill(RULE_NAME);
  await expect(dialog.getByLabel('Stufe')).toHaveValue('key');
  await expect(dialog.getByLabel('ab Konfidenz (%)')).toHaveValue('95');
  // Ad-hoc proposals count only when the rule says so.
  await expect(dialog.getByTestId('preview-open')).toHaveText('Jetzt offen: 0 würden angenommen');
  await dialog.getByLabel('Auch Ad-hoc-Vorschläge').click();
  await expect(dialog.getByTestId('preview-open')).toHaveText('Jetzt offen: 2 würden angenommen');
  await expect(dialog.getByTestId('preview-history')).toContainText('(Trefferquote 100 %)');
  await shot(page, 'd19-02-rule-dialog');
  await dialog.getByTestId('save-on').click();

  // Enabled with open matches: the offer, then the dry run list and „2 Vorschläge annehmen“.
  const offer = page.getByTestId('offer-apply');
  await expect(offer).toContainText('2 offene Vorschläge erfüllen die Regel bereits');
  await offer.getByRole('button', { name: 'Liste ansehen…' }).click();
  const apply = page.getByTestId('apply-dialog');
  await expect(apply.getByTestId('apply-summary')).toHaveText(
    '2 offene Vorschläge erfüllen die Regel.',
  );
  await expect(apply.getByTestId('apply-item')).toHaveCount(2);
  await shot(page, 'd19-03-apply');
  await apply.getByRole('button', { name: '2 Vorschläge annehmen' }).click();
  await expect(apply).toBeHidden();
  const row = page.getByTestId('rule-row');
  await expect(row).toHaveAttribute('data-enabled', 'true');
  await expect(row.getByTestId('rule-stats')).toContainText('2 in Kraft0 widerrufen');
  await shot(page, 'd19-04-rules');
  for (const id of accepted) expect((await relationOf(id)).status).toBe('accepted');
});

test('marks and the filter in the Relations tab, provenance on the review screen', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT}/relations`);
  await page.getByRole('button', { name: /^Automatisch angenommen/ }).click();
  await expect(page).toHaveURL(/auto=any/);
  const rows = page.getByTestId('relation-row');
  await expect(rows).toHaveCount(2);
  for (const id of accepted) {
    await expect(
      page.locator(`[data-relation-id="${id}"]`).getByTestId('auto-accept-mark'),
    ).toHaveText(`Automatisch angenommen – Regel „${RULE_NAME}“`);
  }
  await shot(page, 'd19-05-relations');

  await page.goto(`/projects/${PROJECT}/review/${accepted[0]}`);
  const provenance = page.getByTestId('auto-accept-provenance');
  await expect(provenance).toContainText(`Entschieden durch Regel „${RULE_NAME}“ (Revision 1)`);
  await expect(provenance).toContainText('ausgelöst von agent:e2e-rules mit 0,97');
  await expect(page.locator('[data-auto="decision"]')).toContainText('Automatisch angenommen');
  await shot(page, 'd19-06-review');
});

test('revoking the rule returns both to „Prüfen“, marked „widerrufen“', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/rules`);
  await page.getByTestId('rule-revoke').click();
  const dialog = page.getByTestId('revoke-dialog');
  await expect(dialog.getByTestId('revoke-summary')).toHaveText(
    '2 automatische Annahmen: 2 gehen zurück in die Prüfung (ein Agentenvorschlag ist noch offen).',
  );
  await dialog.getByLabel('Grund (optional)').fill('Stichprobe');
  await shot(page, 'd19-07-revoke');
  await dialog.getByRole('button', { name: '2 widerrufen' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('rule-row').getByTestId('rule-stats')).toContainText(
    '0 in Kraft2 widerrufen',
  );
  for (const id of accepted) expect((await relationOf(id)).status).toBe('proposed');

  await page.goto(`/projects/${PROJECT}/review`);
  for (const id of accepted) {
    await expect(
      page
        .locator(`[data-testid="queue-row"][data-relation-id="${id}"]`)
        .getByTestId('queue-revoked'),
    ).toHaveText('widerrufen');
  }
  await page
    .locator(`[data-testid="queue-row"][data-relation-id="${accepted[0]}"]`)
    .scrollIntoViewIfNeeded();
  await shot(page, 'd19-08-review-revoked');
});

test('a placement rule marks its acceptance on the chain page', async ({ page }) => {
  // The agent places a process without a home step on a leaf step.
  const unplaced = (await (await owner.get(`${CHAIN}/unplaced-processes?limit=200`)).json()) as {
    items: { process: string }[];
  };
  const detail = (await (await owner.get(CHAIN)).json()) as {
    steps: { elementId: string; childIds: string[] }[];
  };
  const step = detail.steps.find((s) => s.childIds.length === 0)?.elementId;
  const process = unplaced.items[0]?.process;
  expect(step && process).toBeTruthy();
  const proposed = await agent.post(`${CHAIN}/placements`, {
    data: {
      kind: 'propose',
      llmModel: 'e2e-model',
      placements: [{ step, process, confidence: 0.99, rationale: 'Passt fachlich genau.' }],
    },
  });
  expect(proposed.ok()).toBe(true);
  const placements = (await (await owner.get(`${CHAIN}/placements?limit=200`)).json()) as {
    items: { id: string; process: string; elementId: string; tier: string }[];
  };
  const placement = placements.items.find((p) => p.process === process && p.elementId === step);
  expect(placement).toBeDefined();

  // A placement rule of that tier, enabled, applied (dry run, then expectedCount).
  const rule = await owner.post(`${BASE}/auto-accept-rules`, {
    data: {
      name: 'Platzierungen ab 98 %',
      kind: 'placement',
      tier: placement!.tier,
      minConfidence: 0.98,
      includeAdHoc: true,
      enabled: true,
    },
  });
  expect(rule.status()).toBe(201);
  const { rule: saved } = (await rule.json()) as { rule: { id: string; revision: number } };
  const dry = (await (
    await owner.post(`${BASE}/auto-accept-rules/${saved.id}/apply?dryRun=true`, { data: {} })
  ).json()) as { count: number };
  expect(dry.count).toBe(1);
  expect(
    (
      await owner.post(`${BASE}/auto-accept-rules/${saved.id}/apply`, {
        data: { revision: saved.revision, expectedCount: 1 },
      })
    ).ok(),
  ).toBe(true);

  await page.goto(`/projects/${PROJECT}/value-chain`);
  await page.getByTestId('filter-auto').click();
  const card = page.locator(`[data-testid="placement-card"][data-placement-id="${placement!.id}"]`);
  await expect(card.getByTestId('auto-accept-mark')).toHaveText(
    'Automatisch angenommen – Regel „Platzierungen ab 98 %“',
  );
  await shot(page, 'd19-09-chain');
});

test('the rule dialog loads a newer revision after a 412; one agent’s acceptances are revoked in the tab', async ({
  page,
}) => {
  await page.goto(`/projects/${PROJECT}/rules`);
  const row = page.getByTestId('rule-row').filter({ hasText: RULE_NAME });
  await row.getByRole('button', { name: 'Bearbeiten' }).click();
  const dialog = page.getByTestId('rule-dialog');
  await expect(dialog.getByLabel('ab Konfidenz (%)')).toHaveValue('95');

  // Meanwhile another owner (here: over REST) raises the threshold.
  const list = (await (await owner.get(`${BASE}/auto-accept-rules`)).json()) as {
    items: Array<Record<string, unknown> & { id: string; name: string; revision: number }>;
  };
  const current = list.items.find((r) => r.name === RULE_NAME);
  expect(current).toBeDefined();
  const fields = [
    'name',
    'enabled',
    'note',
    'kind',
    'tier',
    'relationType',
    'agentPrincipalId',
    'llmModel',
    'includeAdHoc',
  ] as const;
  const draft = Object.fromEntries(fields.map((f) => [f, current![f]]));
  const raised = await owner.put(`${BASE}/auto-accept-rules/${current!.id}`, {
    headers: { 'if-match': `"r${current!.revision}"` },
    data: { ...draft, minConfidence: 0.97 },
  });
  expect(raised.ok()).toBe(true);

  // Saving the stale form is refused; loading the newer revision puts it into the form.
  await dialog.getByLabel('Notiz (optional)').fill('nur eine Notiz');
  await dialog.getByTestId('save-on').click();
  await expect(dialog).toContainText(
    `Die Regel wurde inzwischen geändert (Revision ${current!.revision + 1})`,
  );
  await dialog.getByRole('button', { name: 'Neuere Revision laden' }).click();
  await expect(dialog.getByTestId('reloaded')).toContainText('ab Konfidenz: 95 % → 97 %');
  await expect(dialog.getByLabel('ab Konfidenz (%)')).toHaveValue('97');
  await expect(dialog.getByLabel('Notiz (optional)')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(dialog).toBeHidden();

  // The placement acceptance of the agent is still in force: revoke it per agent.
  const section = page.getByTestId('agent-revoke');
  await expect(section.getByLabel('Agent')).toContainText('agent:e2e-rules (1 in Kraft)');
  await section.getByTestId('agent-revoke-open').click();
  const revoke = page.getByTestId('revoke-dialog');
  await expect(revoke.getByTestId('revoke-summary')).toHaveText(
    '1 automatische Annahme: 1 geht zurück in die Prüfung (ein Agentenvorschlag ist noch offen). 2 waren schon widerrufen.',
  );
  await revoke.getByRole('button', { name: '1 widerrufen' }).click();
  await expect(revoke).toBeHidden();
  await expect(section).toBeHidden();
});
