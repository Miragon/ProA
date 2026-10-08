/**
 * Claims under concurrency and the pending long-poll, over real HTTP
 * against real PostgreSQL (CONCEPT §8: "lease races need it"):
 * - several clients (agent tokens of two projects and the owner, who claims
 *   across both) claim at once: every task is claimed exactly once, also
 *   again after the leases expired;
 * - `GET /analyses/pending?wait=` wakes on Postgres NOTIFY, is bounded,
 *   shares one LISTEN connection, bounds the waits per caller and lets go of
 *   aborted requests.
 */
import type { ClaimResult, PendingAnalyses } from '@proa/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startTestApp, testClock, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';
import { fakeBpmn } from '../support/fake-analysis.ts';
import { listen } from '../support/http.ts';

const MINUTE = 60_000;
const MODELS_PER_PROJECT = 12;

let database: TestDatabase;
let t: TestApp;
let server: { url: string; close: () => Promise<void> };
const clock = testClock(new Date('2026-10-08T08:00:00.000Z'));
const secrets: Record<'a' | 'b', string[]> = { a: [], b: [] };

function model(i: number) {
  return fakeBpmn({
    processes: [
      {
        id: `Process_${i}`,
        name: `Prozess ${i}`,
        elements: [{ kind: 'msg_throw', id: `Event_${i}`, name: `Ereignis ${i}`, ref: `Msg${i}` }],
      },
    ],
  });
}

type Credential = { bearer: string } | { cookie: string };

function headers(c: Credential): Record<string, string> {
  return 'bearer' in c ? { authorization: `Bearer ${c.bearer}` } : { cookie: c.cookie };
}

async function claimOver(c: Credential, max: number): Promise<{ id: string; who: string }[]> {
  const res = await fetch(`${server.url}/api/v1/analyses/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers(c) },
    body: JSON.stringify({ max }),
  });
  expect(res.status).toBe(200);
  const who = 'bearer' in c ? c.bearer.slice(0, 16) : 'owner';
  return ((await res.json()) as ClaimResult).items.map((i) => ({ id: i.taskId, who }));
}

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { clock });
  for (const p of ['race-a', 'race-b'] as const) {
    await t.createProject(p);
    for (let i = 0; i < MODELS_PER_PROJECT; i++) {
      expect((await t.putModel(p, `m/model-${i}`, model(i))).status).toBe(201);
    }
    const key = p === 'race-a' ? 'a' : 'b';
    for (let i = 0; i < 3; i++) {
      secrets[key].push((await t.createToken(p, ['proa:read', 'proa:propose'])).secret);
    }
  }
  await t.createProject('poll');
  server = await listen(t.app.fetch);
});

afterAll(async () => {
  await server.close();
  await database.drop();
});

function credentials(): Credential[] {
  return [
    ...secrets.a.map((bearer) => ({ bearer })),
    ...secrets.b.map((bearer) => ({ bearer })),
    { cookie: t.ownerCookie },
    { cookie: t.ownerCookie },
  ];
}

async function race(): Promise<{ id: string; who: string }[]> {
  // Every client claims twice in parallel, three tasks at a time: 16 claims for 24 tasks.
  const claims = credentials().flatMap((c) => [claimOver(c, 3), claimOver(c, 3)]);
  return (await Promise.all(claims)).flat();
}

describe('concurrent claims', () => {
  it('claim every task exactly once', async () => {
    const claimed = await race();
    const ids = claimed.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2 * MODELS_PER_PROJECT);
    const r = await database.db.execute<{ state: string; attempts: number; n: string }>(
      sql`SELECT state, attempts, count(*) AS n FROM analysis_task GROUP BY state, attempts`,
    );
    expect(r.rows.map((x) => [x.state, x.attempts, Number(x.n)])).toEqual([
      ['claimed', 1, 2 * MODELS_PER_PROJECT],
    ]);
    const events = await database.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM event WHERE type = 'analysis.claimed'`,
    );
    expect(Number(events.rows[0]?.n)).toBe(2 * MODELS_PER_PROJECT);
    // Agent tokens only ever got tasks of their own project.
    const own = await database.db.execute<{ bad: string }>(
      sql`SELECT count(*) AS bad FROM analysis_task t
          JOIN agent_token a ON a.principal_id = t.claimed_by
          WHERE a.project_id <> t.project_id`,
    );
    expect(Number(own.rows[0]?.bad)).toBe(0);
  });

  it('claim every expired lease exactly once more', async () => {
    clock.advance(16 * MINUTE);
    const claimed = await race();
    const ids = claimed.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(2 * MODELS_PER_PROJECT);
    const r = await database.db.execute<{ attempts: number; n: string }>(
      sql`SELECT attempts, count(*) AS n FROM analysis_task WHERE state = 'claimed' GROUP BY attempts`,
    );
    expect(r.rows.map((x) => [x.attempts, Number(x.n)])).toEqual([[2, 2 * MODELS_PER_PROJECT]]);
  });
});

describe('FOR UPDATE SKIP LOCKED', () => {
  it('skips a task another transaction holds instead of waiting for it', async () => {
    await t.createProject('skip');
    for (let i = 0; i < 3; i++) await t.putModel('skip', `s/m-${i}`, model(i));
    const secret = (await t.createToken('skip', ['proa:propose'])).secret;
    const locker = new pg.Client({ connectionString: database.url });
    await locker.connect();
    try {
      await locker.query('BEGIN');
      const held = await locker.query<{ id: string }>(
        `SELECT t.id FROM analysis_task t JOIN project p ON p.id = t.project_id
         WHERE p.key = 'skip' ORDER BY t.created_at, t.seq LIMIT 1 FOR UPDATE OF t`,
      );
      const heldId = held.rows[0]?.id;
      const started = Date.now();
      const claimed = await claimOver({ bearer: secret }, 5);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(claimed).toHaveLength(2);
      expect(claimed.map((c) => c.id)).not.toContain(heldId);
      await locker.query('COMMIT');
      const rest = await claimOver({ bearer: secret }, 5);
      expect(rest.map((c) => c.id)).toEqual([heldId]);
    } finally {
      await locker.end();
    }
  });
});

describe('pending long-poll', () => {
  const token = () => secrets.a[0] ?? '';
  let pollToken = '';

  beforeAll(async () => {
    pollToken = (await t.createToken('poll', ['proa:propose'])).secret;
  });

  async function pending(query: string, secret = pollToken, signal?: AbortSignal) {
    const res = await fetch(`${server.url}/api/v1/analyses/pending?${query}`, {
      headers: { authorization: `Bearer ${secret}` },
      ...(signal ? { signal } : {}),
    });
    return { status: res.status, body: (await res.json()) as PendingAnalyses };
  }

  async function listeners(): Promise<number> {
    const r = await database.db.execute<{ n: string }>(
      sql`SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = ${database.name} AND application_name = 'proa-listen'`,
    );
    return Number(r.rows[0]?.n);
  }

  it('answers at once without wait, and at once when work is there', async () => {
    expect((await pending('', token())).body.total).toBe(0);
    clock.advance(16 * MINUTE);
    const started = Date.now();
    expect((await pending('wait=30', token())).body.total).toBe(MODELS_PER_PROJECT);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('is bounded: returns after the wait with nothing to do', async () => {
    const started = Date.now();
    const { status, body } = await pending('wait=1');
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 0, items: [{ projectKey: 'poll', pending: 0 }] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(database.notifier.subscribers()).toBe(0);
  });

  it('wakes on NOTIFY when a task is queued, sharing one LISTEN connection', async () => {
    const started = Date.now();
    const waits = [pending('wait=20'), pending('wait=20'), pending('wait=20')];
    await expect.poll(() => database.notifier.subscribers(), { timeout: 5000 }).toBe(3);
    expect(await listeners()).toBe(1);
    expect((await t.putModel('poll', 'p/neu', model(99))).status).toBe(201);
    for (const w of await Promise.all(waits)) expect(w.body.total).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(database.notifier.subscribers()).toBe(0);
    expect(await listeners()).toBe(1);
  });

  it('lets go of an aborted request', async () => {
    // Claim the task so nothing is pending, then wait and abort.
    const {
      items: [c],
    } = (await (
      await fetch(`${server.url}/api/v1/analyses/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${pollToken}` },
        body: '{}',
      })
    ).json()) as ClaimResult;
    expect(c).toBeDefined();
    const controller = new AbortController();
    const wait = pending('wait=30', pollToken, controller.signal).catch((err: unknown) => err);
    await expect.poll(() => database.notifier.subscribers(), { timeout: 5000 }).toBe(1);
    controller.abort();
    await wait;
    await expect.poll(() => database.notifier.subscribers(), { timeout: 5000 }).toBe(0);
  });

  it('does not wake for another project', async () => {
    const started = Date.now();
    const wait = pending('wait=2');
    await expect.poll(() => database.notifier.subscribers(), { timeout: 5000 }).toBe(1);
    expect((await t.putModel('race-b', 'm/another', model(77))).status).toBe(201);
    expect((await wait).body.total).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });

  it('bounds the waits of one caller, so one token cannot take every slot', async () => {
    const greedy = (await t.createToken('poll', ['proa:propose'])).secret;
    const greedyWaits = Array.from({ length: 8 }, () => pending('wait=20', greedy));
    await expect.poll(() => database.notifier.subscribers(), { timeout: 5000 }).toBe(8);
    // The ninth poll of the same token answers at once …
    const started = Date.now();
    expect((await pending('wait=20', greedy)).body.total).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    // … while another caller still gets a slot, waits and wakes on NOTIFY.
    const other = pending('wait=20');
    await expect.poll(() => database.notifier.subscribers(), { timeout: 5000 }).toBe(9);
    expect((await t.putModel('poll', 'p/zwei', model(98))).status).toBe(201);
    expect((await other).body.total).toBe(1);
    for (const w of await Promise.all(greedyWaits)) expect(w.body.total).toBe(1);
    expect(database.notifier.subscribers()).toBe(0);
  });
});
