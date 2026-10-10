import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The value chain's placement agent in the browser (M4 §3.2, S5) against a
 * running server with the built UI: a project with the dev landscape and its
 * golden chain (as `proa seed --value-chains` creates it) waits for the agent
 * with every process due; `proa-agent-sim --kinds placement` (a child process,
 * over MCP with an agent token) works the chain's one placement task; the
 * panel then shows „Wartet auf Prüfung“, nothing due, and „Agent unsicher“
 * with the agent's reasons as text and „Platzieren“, which opens the manual
 * placement form. A reviewer's rejection then makes a process due without a
 * task, and „Aufgabe einplanen“ queues one. No CSP violation on the way. The
 * dev landscape only; with PROA_SCREENSHOTS_DIR it writes m4-14. Skips itself
 * when no server answers.
 */

const ROOT = join(import.meta.dirname, '../../..');
const CORPUS = join(ROOT, 'eval/corpus/nordwind-handel/models');
const GOLDEN = join(ROOT, 'eval/value-chains/nordwind-handel/value-chain.vc.json');
const SIM_MAIN = join(ROOT, 'apps/agent-sim/src/main.ts');
const PROJECT = `vc-agent-${Date.now().toString(36)}`;
const SHOTS = process.env['PROA_SCREENSHOTS_DIR'];
const AGENT = 'agent-sim';
const CHAIN = `/api/v1/projects/${PROJECT}/value-chains/main`;

interface Pipeline {
  stage: string;
  due: number;
  unsure: number;
}
interface ChainDetail {
  pipeline: Pipeline;
  unsure: { process: string; reason: string; by: string }[];
}
interface SimReport {
  stop: string;
  kinds: string[];
  byKind: {
    relations: { tasks: number };
    placement: {
      tasks: number;
      submitted: number;
      failed: number;
      unsure: number;
      outcomes: { invalid: number };
    };
  };
}

let owner: APIRequestContext;
let base = '';
let secret = '';
let tokenId = '';

function bpmnFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? bpmnFiles(path) : name.endsWith('.bpmn') ? [path] : [];
  });
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), animations: 'disabled' });
}

async function detail(): Promise<ChainDetail> {
  const res = await owner.get(CHAIN);
  expect(res.ok()).toBe(true);
  return (await res.json()) as ChainDetail;
}

/** Runs `proa-agent-sim --kinds placement` against the server until no placement task is left. */
function runSimAgent(): Promise<SimReport> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [SIM_MAIN, '--url', base, '--project', PROJECT, '--kinds', 'placement', '--json', '-q'],
      { env: { ...process.env, PROA_TOKEN: secret } },
    );
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
  base = baseURL ?? 'http://127.0.0.1:7400';
  const probe = await playwright.request.newContext({ baseURL: base });
  const health = await probe.get('/health', { timeout: 3000 }).catch(() => null);
  await probe.dispose();
  test.skip(!health?.ok(), 'no ProA server at PROA_E2E_URL; start one to run the agent flow');

  owner = await playwright.request.newContext({ baseURL: base });
  expect((await owner.post('/api/v1/session', { data: { client: 'proa-web' } })).ok()).toBe(true);
  expect(
    (
      await owner.post('/api/v1/projects', {
        data: { key: PROJECT, name: 'Nordwind Handel (Platzierungen)' },
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
  // As `proa seed --value-chains`: the golden chain after the import, without placements.
  const created = await owner.put(`${CHAIN}/content`, {
    headers: { 'if-none-match': '*', 'content-type': 'application/json' },
    data: readFileSync(GOLDEN, 'utf8'),
  });
  expect(created.status()).toBe(201);
  const token = await owner.post(`/api/v1/projects/${PROJECT}/agent-tokens`, {
    data: { name: AGENT, scopes: ['proa:read', 'proa:propose'], expiresInDays: 1 },
  });
  expect(token.status()).toBe(201);
  ({ secret, id: tokenId } = (await token.json()) as { secret: string; id: string });
});

test.afterAll(async () => {
  if (owner && tokenId) await owner.delete(`/api/v1/projects/${PROJECT}/agent-tokens/${tokenId}`);
  await owner?.dispose();
});

test('before the agent: the chain waits for it, every open process due', async ({ page }) => {
  const { pipeline } = await detail();
  expect(pipeline.stage).toBe('waiting_for_agent');
  expect(pipeline.due).toBeGreaterThan(1);
  await page.goto(`/projects/${PROJECT}/value-chain`);
  const stage = page.getByTestId('chain-stage');
  await expect(stage).toHaveAttribute('data-stage', 'waiting_for_agent');
  await expect(stage).toContainText('Wartet auf den Agenten');
  await expect(page.getByTestId('chain-due')).toHaveText(`${pipeline.due} Prozesse fällig`);
  await expect(page.getByRole('region', { name: 'Agent unsicher' })).toHaveCount(0);
});

test('after the agent: waiting for review, nothing due, „Agent unsicher“ with „Platzieren“', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const report = await runSimAgent();
  expect(report.stop).toBe('no-work');
  expect(report.kinds).toEqual(['placement']);
  expect(report.byKind.relations.tasks).toBe(0);
  expect(report.byKind.placement).toMatchObject({ tasks: 1, submitted: 1, failed: 0 });
  expect(report.byKind.placement.outcomes.invalid).toBe(0);

  const after = await detail();
  expect(after.pipeline).toMatchObject({ stage: 'waiting_for_review', due: 0 });
  expect(after.unsure.length).toBe(report.byKind.placement.unsure);
  expect(after.unsure.length).toBeGreaterThan(0);

  await page.goto(`/projects/${PROJECT}/value-chain`);
  const stage = page.getByTestId('chain-stage');
  await expect(stage).toHaveAttribute('data-stage', 'waiting_for_review');
  await expect(stage).toContainText('Wartet auf Prüfung');
  await expect(page.getByTestId('chain-due')).toHaveCount(0);

  const section = page.getByRole('region', { name: 'Agent unsicher' });
  await expect(section.getByRole('heading')).toHaveText(`Agent unsicher(${after.unsure.length})`);
  const items = section.getByTestId('unsure-process');
  await expect(items).toHaveCount(after.unsure.length);
  const first = after.unsure[0];
  const item = section.locator(`[data-process="${first?.process ?? ''}"]`);
  await expect(item).toContainText(first?.reason ?? '');
  await expect(item).toContainText(`agent:${AGENT}`);
  await item.scrollIntoViewIfNeeded();
  await shot(page, 'm4-14-agent-unsure');

  await item.getByRole('button', { name: 'Platzieren' }).click();
  const placing = item.getByTestId('manual-placement-form');
  await expect(placing).toBeVisible();
  await placing.getByRole('button', { name: 'Abbrechen' }).click();
  await expect(placing).toHaveCount(0);
  // The focus returns to „Platzieren“.
  await expect(item.getByRole('button', { name: 'Platzieren' })).toBeFocused();
});

test('a reviewer’s rejection makes a process due without a task; „Aufgabe einplanen“ queues it', async ({
  page,
}) => {
  const list = await owner.get(`${CHAIN}/placements?limit=200&status=proposed`);
  expect(list.ok()).toBe(true);
  const { items } = (await list.json()) as {
    items: { id: string; source: string | null }[];
  };
  const agentProposal = items.find((p) => p.source === 'agent');
  expect(agentProposal).toBeTruthy();
  const decided = await owner.post(`${CHAIN}/placements/${agentProposal?.id ?? ''}/decision`, {
    data: { verdict: 'reject', reason: 'Gehört zu einem anderen Schritt.' },
  });
  expect(decided.ok()).toBe(true);
  const before = await detail();
  expect(before.pipeline.due).toBe(1);
  expect(before.pipeline.stage).not.toBe('waiting_for_agent');

  await page.goto(`/projects/${PROJECT}/value-chain`);
  await expect(page.getByTestId('chain-due')).toHaveText('1 Prozess fällig');
  const hint = page.getByTestId('chain-requeue');
  await expect(hint).toContainText('Für diese Prozesse ist keine Aufgabe eingeplant');
  await hint.getByRole('button', { name: 'Aufgabe einplanen' }).click();
  await expect(page.getByText('Eingeplant', { exact: true })).toBeVisible();
  const stage = page.getByTestId('chain-stage');
  await expect(stage).toHaveAttribute('data-stage', 'waiting_for_agent');
  await expect(page.getByTestId('chain-requeue')).toHaveCount(0);
  expect((await detail()).pipeline.stage).toBe('waiting_for_agent');
});
