import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * M2 end to end against a running ProA (the Docker stack or `node
 * apps/server/src/main.ts` with the built UI): pipeline → review → decision
 * memory, with the real simulation agent instead of hand-made proposals.
 *
 * 1. The owner creates a project from eval/corpus/nordwind-handel and an
 *    agent token (read, propose).
 * 2. `proa-agent-sim` (apps/agent-sim, a child process) works the whole
 *    pipeline over MCP with that token; every model leaves "waiting for
 *    agent" for "waiting for review" or "incorporated".
 * 3. In the browser: the agent's proposals with their provenance; accept,
 *    reject with a reason (twice), hold with a question, answer it in the
 *    held list, correct a proposal, bulk-accept the key tier with the
 *    flagged pairs left open.
 * 4. A modeler re-uploads a changed model: the rejection whose endpoint
 *    changed shows "Endpunkt geändert", the model waits for the agent again;
 *    an agent repeating the unchanged rejected pair over MCP gets
 *    `suppressed`; deciding over MCP is `human-decision-required` with a
 *    reviewUrl that opens the review screen; the agent's second run reopens
 *    the changed pair, while accepted and held relations keep their status.
 *
 * With PROA_SCREENSHOTS_DIR set it writes m2-08 … m2-12 there. Skips itself
 * when no server answers.
 */

const CORPUS = join(import.meta.dirname, '../../../eval/corpus/nordwind-handel/models');
const SIM_MAIN = join(import.meta.dirname, '../../agent-sim/src/main.ts');
const PROJECT = `pipeline-${Date.now().toString(36)}`;
const SHOTS = process.env['PROA_SCREENSHOTS_DIR'];
const AGENT = 'agent-sim';
/** The model the modeler changes in step 4. */
const CHANGED_MODEL = 'finanzen/zahlungslauf';

/** The pairs the flow decides (all proposed by the agent in step 2). */
const PAIRS = {
  /** key tier, identical message name: accepted, touches the changed model */
  accept: [
    'finanzen/zahlungslauf#Event_ZahlungAngeordnet',
    'finanzen/lieferantenrechnung#Event_ZahlungAngeordnet',
  ],
  /** near miss (LieferungVerspaetet vs LieferungVersendet): rejected, later repeated → suppressed */
  rejectKept: [
    'logistik/shipping#Event_DeliveryDelayed',
    'finanzen/rechnungsstellung#Start_LieferungVersendet',
  ],
  /** other words ("Vorgezogene Zahlung" vs "Eilzahlung"): rejected; the start is renamed → reopened */
  rejectReopened: [
    'finanzen/lieferantenrechnung#Event_VorgezogeneZahlungAngefordert',
    'finanzen/zahlungslauf#Start_EilzahlungAngefordert',
  ],
  /** an agent question: held with a question of the reviewer, touches the changed model */
  hold: [
    'finanzen/zahlungslauf#Event_ZahlungAngeordnet',
    'finanzen/forderungsmanagement#Event_ZahlungZugeordnet',
  ],
  /** the dynamic call `${ausgabekanal}`: corrected to the letter channel */
  correct: [
    'finanzen/rechnungsstellung#Call_RechnungAusgeben',
    'finanzen/e-rechnung-versand#Process_ERechnungVersand',
  ],
} as const;
const CORRECTED_TO = 'finanzen/briefversand#Process_Briefversand';

interface Provenance {
  sourceKind: string;
  handle: string | null;
  clientId: string | null;
  procedure: { id: string; version: string } | null;
  llmModel: string | null;
  rationale: string | null;
  question: string | null;
  kind: string;
  verdict: string | null;
}
interface Relation {
  id: string;
  type: string;
  status: string;
  endpointState: string;
  version: number;
  tier: string;
  from: string;
  to: string;
  provenance: Provenance | null;
}
interface SimReport {
  stop: string;
  procedure: { id: string; version: string } | null;
  prompt: boolean;
  tasks: { modelKey: string; outcome: string; attempt: number }[];
  totals: {
    tasks: number;
    submitted: number;
    failed: number;
    proposed: number;
    questions: number;
    withdrawn: number;
    outcomes: Record<'applied' | 'duplicate' | 'suppressed' | 'reopened' | 'invalid', number>;
  };
}
interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: { type: string; text?: string }[];
}

let owner: APIRequestContext;
let agent: APIRequestContext;
let base = '';
let secret = '';
let tokenId = '';
const ids: Partial<Record<keyof typeof PAIRS, string>> = {};

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

/** Runs `proa-agent-sim` against the server until no task is left. */
function runSimAgent(): Promise<SimReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SIM_MAIN, '--url', base, '--json', '-q'], {
      env: { ...process.env, PROA_TOKEN: secret },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(JSON.parse(out) as SimReport);
      else reject(new Error(`proa-agent-sim exited ${String(code)}: ${err}${out}`));
    });
  });
}

/** One MCP tool call as a 2025-11-25 client (stateless Streamable HTTP, agent token). */
async function mcpTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    'mcp-protocol-version': '2025-11-25',
  };
  const init = await agent.post('/mcp', {
    headers,
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e-pipeline', version: '0' },
      },
    },
  });
  expect(init.status()).toBe(200);
  const res = await agent.post('/mcp', {
    headers,
    data: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  // JSON, or one SSE `data:` event
  const json = text.trimStart().startsWith('{')
    ? text
    : text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5))
        .join('');
  return (JSON.parse(json) as { result: ToolResult }).result;
}

async function relations(): Promise<Relation[]> {
  const response = await owner.get(`/api/v1/projects/${PROJECT}/relations?limit=200`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { items: Relation[] }).items;
}

async function relationOf(id: string | undefined): Promise<Relation> {
  const response = await owner.get(`/api/v1/projects/${PROJECT}/relations/${id ?? ''}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Relation;
}

async function stages(): Promise<Record<string, number>> {
  const response = await owner.get(`/api/v1/projects/${PROJECT}/models?limit=200`);
  const items = ((await response.json()) as { items: { key: string; stage: string }[] }).items;
  const counts: Record<string, number> = {};
  for (const m of items) counts[m.stage] = (counts[m.stage] ?? 0) + 1;
  return counts;
}

async function stageOf(modelKey: string): Promise<string> {
  const response = await owner.get(`/api/v1/projects/${PROJECT}/models?limit=200`);
  const items = ((await response.json()) as { items: { key: string; stage: string }[] }).items;
  return items.find((m) => m.key === modelKey)?.stage ?? '';
}

/**
 * Opens the review screen of `id` and waits until the diagrams are imported
 * and the endpoints are marked: both ends of an event pair; for a call only
 * the call activity, since its target is a whole process without a shape.
 */
async function review(page: Page, id: string | undefined, markers = 2): Promise<void> {
  await page.goto(`/projects/${PROJECT}/review/${id ?? ''}`);
  await expect(page.getByTestId('review-details')).toBeVisible();
  const canvases = page.getByTestId('bpmn-canvas');
  await expect(canvases.first()).toBeVisible();
  const count = await canvases.count();
  for (let i = 0; i < count; i += 1) {
    await expect(canvases.nth(i)).toHaveAttribute('data-imported', 'true');
  }
  await expect(page.locator('.djs-element.proa-endpoint')).toHaveCount(markers);
  await expect(page.locator('.proa-overlay', { hasText: 'Von' })).toBeVisible();
  if (markers === 2) await expect(page.locator('.proa-overlay', { hasText: 'Nach' })).toBeVisible();
}

async function expectStageCounts(page: Page, expected: Record<string, number>): Promise<void> {
  for (const stage of [
    'waiting_for_agent',
    'agent_working',
    'agent_failed',
    'waiting_for_review',
    'waiting_for_clarification',
    'incorporated',
  ]) {
    await expect(
      page.locator(`[data-testid=stage-filter][data-stage=${stage}]`),
      `stage ${stage}`,
    ).toHaveAttribute('data-count', String(expected[stage] ?? 0));
  }
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
    cspViolations.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
});
test.afterEach(() => {
  expect(cspViolations).toEqual([]);
});

test.beforeAll(async ({ playwright, baseURL }) => {
  test.setTimeout(180_000);
  base = baseURL ?? 'http://127.0.0.1:7400';
  const probe = await playwright.request.newContext({ baseURL: base });
  const health = await probe.get('/health', { timeout: 3000 }).catch(() => null);
  await probe.dispose();
  test.skip(!health?.ok(), 'no ProA server at PROA_E2E_URL; start one to run the pipeline flow');

  owner = await playwright.request.newContext({ baseURL: base });
  expect((await owner.post('/api/v1/session', { data: { client: 'proa-web' } })).ok()).toBe(true);
  expect(
    (
      await owner.post('/api/v1/projects', {
        data: { key: PROJECT, name: 'Nordwind Handel (Pipeline)' },
      })
    ).status(),
  ).toBe(201);
  const form = new FormData();
  for (const file of bpmnFiles(CORPUS)) {
    form.append(
      'files',
      new File([readFileSync(file)], relative(CORPUS, file), { type: 'application/xml' }),
    );
  }
  expect((await owner.post(`/api/v1/projects/${PROJECT}/imports`, { multipart: form })).ok()).toBe(
    true,
  );
  const token = await owner.post(`/api/v1/projects/${PROJECT}/agent-tokens`, {
    data: { name: AGENT, scopes: ['proa:read', 'proa:propose'], expiresInDays: 1 },
  });
  expect(token.status()).toBe(201);
  ({ secret, id: tokenId } = (await token.json()) as { secret: string; id: string });
  agent = await playwright.request.newContext({
    baseURL: base,
    extraHTTPHeaders: { authorization: `Bearer ${secret}` },
  });

  // before the agent: every model waits for it
  const before = await stages();
  expect(before['waiting_for_agent']).toBe(bpmnFiles(CORPUS).length);

  const report = await runSimAgent();
  expect(report.stop).toBe('no-work');
  expect(report.prompt).toBe(true);
  expect(report.procedure?.id).toBe('proa-relations');
  expect(report.totals.tasks).toBe(bpmnFiles(CORPUS).length);
  expect(report.totals.submitted).toBe(report.totals.tasks);
  expect(report.totals.failed).toBe(0);
  expect(report.totals.outcomes.invalid).toBe(0);
  expect(report.totals.outcomes.applied).toBeGreaterThan(0);
  expect(report.tasks.every((t) => t.attempt === 1 && t.outcome === 'submitted')).toBe(true);

  const all = await relations();
  for (const [name, [from, to]] of Object.entries(PAIRS) as [
    keyof typeof PAIRS,
    readonly [string, string],
  ][]) {
    const r = all.find((x) => x.from === from && x.to === to);
    expect(r, `${name}: ${from} → ${to} proposed by the agent`).toBeDefined();
    expect(r?.status).toBe('proposed');
    expect(r?.provenance).toMatchObject({
      sourceKind: 'agent',
      handle: `agent:${AGENT}`,
      clientId: tokenId,
      procedure: { id: 'proa-relations' },
      llmModel: 'sim-policy-1',
    });
    ids[name] = r?.id;
  }
});

test.afterAll(async () => {
  if (owner && tokenId) await owner.delete(`/api/v1/projects/${PROJECT}/agent-tokens/${tokenId}`);
  await agent?.dispose();
  await owner?.dispose();
});

test('after the agent run: no model waits for the agent; the inbox counts the stages', async ({
  page,
}) => {
  const counts = await stages();
  expect(counts['waiting_for_agent'] ?? 0).toBe(0);
  expect(counts['agent_working'] ?? 0).toBe(0);
  expect(counts['agent_failed'] ?? 0).toBe(0);
  expect(counts['waiting_for_review']).toBeGreaterThan(0);
  expect(counts['incorporated']).toBeGreaterThan(0);

  await page.goto(`/projects/${PROJECT}/review`);
  await expectStageCounts(page, counts);
  await expect(page.getByTestId('queue-row').first()).toBeVisible();
  // the agent's borderline cases carry its question
  await expect(page.getByTestId('queue-row').filter({ hasText: 'Frage' }).first()).toBeVisible();
  await shot(page, 'm2-08-pipeline-stages');

  // the relations table shows the agent's provenance
  await page.goto(`/projects/${PROJECT}/relations?status=proposed`);
  await expect(page.getByText(`agent:${AGENT}`).first()).toBeVisible();
  await expect(page.getByText('sim-policy-1').first()).toBeVisible();
});

test('review screen: the agent proposal with rationale, question and provenance; accept', async ({
  page,
}) => {
  const held = await relationOf(ids.hold);
  await review(page, ids.hold);
  const details = page.getByTestId('review-details');
  await expect(details).toContainText(held.provenance?.rationale?.slice(0, 60) ?? '-');
  await expect(page.getByTestId('agent-question')).toContainText(
    held.provenance?.question?.slice(0, 60) ?? '-',
  );
  await expect(details).toContainText(`agent:${AGENT}`);
  await expect(details).toContainText('proa-relations@0.0.1');
  await expect(details).toContainText('sim-policy-1');
  await expect(page.locator('.djs-element.proa-endpoint')).toHaveCount(2);
  await shot(page, 'm2-09-agent-proposal');

  await review(page, ids.accept);
  await page.keyboard.press('a');
  await expect(page.getByTestId('toast').filter({ hasText: 'Angenommen' })).toBeVisible();
  expect((await relationOf(ids.accept)).status).toBe('accepted');
});

test('reject with a reason (twice) and hold with a question; answer it in the held list', async ({
  page,
}) => {
  for (const [name, reason] of [
    ['rejectKept', 'Eine Verspätung startet keine Rechnungsstellung.'],
    ['rejectReopened', '„Eilzahlung“ und „Vorgezogene Zahlung“ sind hier verschiedene Vorgänge.'],
  ] as const) {
    await review(page, ids[name]);
    await page.keyboard.press('r');
    await page.getByLabel('Grund der Ablehnung').fill(reason);
    await page.keyboard.press('Control+Enter');
    await expect(page.getByTestId('toast').filter({ hasText: 'Abgelehnt' })).toBeVisible();
    expect((await relationOf(ids[name])).status).toBe('rejected');
  }

  await review(page, ids.hold);
  await page.keyboard.press('h');
  await page
    .getByLabel('Notiz')
    .fill('Zuordnung und Anordnung klingen ähnlich, sind es aber nicht.');
  await page
    .getByLabel('Frage (optional)')
    .fill('Meldet der Zahlungslauf Anordnungen an das Forderungsmanagement?');
  await page.getByLabel('Label (optional)').fill('mit Finanzbuchhaltung klären');
  await page.getByRole('button', { name: 'Vormerken' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Vorgemerkt' })).toBeVisible();
  expect((await relationOf(ids.hold)).status).toBe('held');

  await page.goto(`/projects/${PROJECT}/review?view=held`);
  const item = page.getByTestId('held-item').filter({ hasText: 'mit Finanzbuchhaltung klären' });
  await expect(item).toContainText('Meldet der Zahlungslauf Anordnungen');
  await item
    .getByRole('textbox', { name: 'Antwort' })
    .fill('Nein, nur Zuordnungen aus dem Zahlungseingang.');
  await item.getByRole('button', { name: /Antwort speichern/ }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Antwort gespeichert' })).toBeVisible();
  await expect(item.getByTestId('held-answer')).toContainText('nur Zuordnungen');
  // the answer is a note: the status stays held
  expect((await relationOf(ids.hold)).status).toBe('held');
});

test('correct: the dynamic call goes to the letter channel instead', async ({ page }) => {
  await review(page, ids.correct, 1);
  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'Relation korrigieren' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Passendes Element suchen').fill('Briefversand');
  await dialog.locator(`[data-testid=correction-candidate][data-ref="${CORRECTED_TO}"]`).click();
  await dialog.getByLabel('Begründung').fill('Der Ausgabekanal ist hier der Briefversand.');
  await dialog.getByRole('button', { name: 'Korrigieren' }).click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Korrigiert' })).toBeVisible();

  expect((await relationOf(ids.correct)).status).toBe('rejected');
  const manual = (await relations()).find(
    (r) => r.type === 'manual' && r.from === PAIRS.correct[0] && r.to === CORRECTED_TO,
  );
  expect(manual?.status).toBe('accepted');
  expect(manual?.provenance).toMatchObject({ sourceKind: 'human', verdict: 'accept' });
});

test('bulk accept of the key tier: flagged pairs stay open', async ({ page }) => {
  await page.goto(`/projects/${PROJECT}/review`);
  await page.locator('[data-testid=bulk-open][data-tier=key]').click();
  const dialog = page.getByTestId('bulk-dialog');
  await expect(dialog).toBeVisible();
  const rows = dialog.getByTestId('bulk-row');
  const total = await rows.count();
  const flagged = dialog.locator('[data-testid=bulk-row][data-flagged=true]');
  const nFlagged = await flagged.count();
  expect(nFlagged).toBeGreaterThan(0);
  expect(nFlagged).toBeLessThan(total);
  const before = await relations();
  const rowOf = (id: string | undefined) =>
    dialog.locator(`[data-testid=bulk-row][data-relation-id="${id ?? ''}"]`);
  // the generic message name "Antwort" (expected.yaml: must_not_link, generic-name)
  const antwort = before.find(
    (r) =>
      r.from === 'service/reklamation#Task_AntwortSenden' &&
      r.to === 'finanzen/kreditpruefung#Event_AntwortErhalten',
  );
  const antwortRow = rowOf(antwort?.id);
  await expect(antwortRow).toHaveAttribute('data-flagged', 'true');
  await expect(
    antwortRow.locator('[data-testid=generic-flag][data-flag=generic-word]').first(),
  ).toContainText('„Antwort“');
  await expect(antwortRow.getByRole('checkbox')).not.toBeChecked();
  // the process id defined twice: the agent asked which target is meant
  const ambiguous = before.filter(
    (r) => r.from === 'einkauf/bestellanforderung#Call_Bestellfreigabe' && r.tier === 'key',
  );
  expect(ambiguous).toHaveLength(2);
  for (const r of ambiguous) {
    const row = rowOf(r.id);
    await expect(row).toHaveAttribute('data-flagged', 'true');
    await expect(row.locator('[data-flag=agent-question]')).toContainText('Der Agent fragt nach');
    await expect(row.locator('[data-flag=ambiguous-target]')).toContainText(
      '„Process_Bestellfreigabe“ ist mehrfach definiert',
    );
    await expect(row.getByRole('checkbox')).not.toBeChecked();
  }
  await rowOf(ambiguous[0]?.id).scrollIntoViewIfNeeded();
  await shot(page, 'm2-10-bulk-flags');

  await dialog.getByRole('button', { name: new RegExp(`^${total - nFlagged} annehmen$`) }).click();
  await expect(
    page.getByTestId('toast').filter({ hasText: `${total - nFlagged} Relationen angenommen` }),
  ).toBeVisible();
  const after = await relations();
  for (const id of [antwort?.id, ...ambiguous.map((r) => r.id)]) {
    expect(after.find((r) => r.id === id)?.status).toBe('proposed');
  }
  expect(after.filter((r) => r.tier === 'key' && r.status === 'proposed')).toHaveLength(nFlagged);
});

test('decision memory: a changed model reopens its rejection, an unchanged one stays suppressed', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // the modeler renames the start event of the payment run and uploads the model again
  const xml = readFileSync(join(CORPUS, `${CHANGED_MODEL}.bpmn`), 'utf8');
  const renamed = xml.replace(
    'name="Eilzahlung angefordert"',
    'name="Vorgezogene Zahlung angefordert"',
  );
  expect(renamed).not.toBe(xml);
  const put = await owner.put(
    `/api/v1/projects/${PROJECT}/models/by-key/${encodeURIComponent(CHANGED_MODEL)}`,
    { data: renamed, headers: { 'content-type': 'application/xml' } },
  );
  expect(put.status()).toBe(200);
  expect(await put.json()).toMatchObject({ outcome: 'revised' });

  // the rejection stays, but its endpoint changed; the model waits for the agent again
  expect(await relationOf(ids.rejectReopened)).toMatchObject({
    status: 'rejected',
    endpointState: 'changed',
  });
  expect(await stageOf(CHANGED_MODEL)).toBe('waiting_for_agent');
  await review(page, ids.rejectReopened);
  await expect(page.getByTestId('review-details')).toContainText('Endpunkt geändert');
  await shot(page, 'm2-11-endpoint-changed');

  // an agent repeating the unchanged rejected pair: suppressed, nothing recorded
  const kept = await relationOf(ids.rejectKept);
  const proposal = await mcpTool('propose_relation', {
    projectId: PROJECT,
    type: 'message',
    from: PAIRS.rejectKept[0],
    to: PAIRS.rejectKept[1],
    confidence: 0.9,
    rationale: 'Beide Ereignisse betreffen eine Lieferung.',
  });
  expect(proposal.isError).not.toBe(true);
  expect(proposal.structuredContent).toMatchObject({
    result: 'suppressed',
    relation: { id: ids.rejectKept, status: 'rejected' },
  });
  expect(await relationOf(ids.rejectKept)).toMatchObject({
    status: 'rejected',
    version: kept.version,
  });

  // deciding over MCP is refused; the reviewUrl opens the review screen
  const decided = await mcpTool('decide_relation', {
    projectId: PROJECT,
    relationId: ids.rejectReopened,
    verdict: 'accept',
  });
  expect(decided.isError).toBe(true);
  const problem = JSON.parse(decided.content[0]?.text ?? '{}') as Record<string, unknown>;
  const reviewUrl = `${base}/projects/${PROJECT}/review/${ids.rejectReopened ?? ''}`;
  expect(problem).toMatchObject({ code: 'human-decision-required', status: 403, reviewUrl });
  await page.goto(reviewUrl);
  await expect(page.getByTestId('review-details')).toContainText(PAIRS.rejectReopened[1]);

  // the agent's second run: one task, the changed pair reopened
  const report = await runSimAgent();
  expect(report.tasks.map((t) => t.modelKey)).toEqual([CHANGED_MODEL]);
  expect(report.totals.outcomes.reopened).toBe(1);
  expect(report.totals.outcomes.invalid).toBe(0);
  expect(await relationOf(ids.rejectReopened)).toMatchObject({
    status: 'proposed',
    endpointState: 'ok',
    provenance: { sourceKind: 'agent', handle: `agent:${AGENT}` },
  });
  // human decisions on the changed model survive the re-upload and the new submission
  expect((await relationOf(ids.accept)).status).toBe('accepted');
  expect((await relationOf(ids.hold)).status).toBe('held');
  expect((await relationOf(ids.rejectKept)).status).toBe('rejected');
  expect(await stageOf(CHANGED_MODEL)).not.toBe('waiting_for_agent');

  // the timeline: proposal → rejection → the reopening proposal (the basis)
  await review(page, ids.rejectReopened);
  const entries = page.getByTestId('timeline-entry');
  await expect(entries.first()).toHaveAttribute('data-kind', 'proposal');
  await expect(page.locator('[data-testid=timeline-entry][data-verdict=reject]')).toContainText(
    'verschiedene Vorgänge',
  );
  await expect(entries.last()).toHaveAttribute('data-kind', 'proposal');
  await expect(entries.last()).toContainText('maßgeblich');
  await expect(page.getByTestId('review-details')).toContainText('Vorgezogene Zahlung angefordert');
  await entries.last().scrollIntoViewIfNeeded();
  await shot(page, 'm2-12-reopened');

  // now the reviewer accepts it
  await page.keyboard.press('a');
  await expect(page.getByTestId('toast').filter({ hasText: 'Angenommen' })).toBeVisible();
  expect((await relationOf(ids.rejectReopened)).status).toBe('accepted');
});
