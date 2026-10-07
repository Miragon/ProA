import { AgentTokenList, CreatedAgentToken, Me } from '@proa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashAgentTokenSecret } from '../../src/domain/agent-token-secret.ts';
import { startTestApp, testClock, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let database: TestDatabase;
let t: TestApp;
const clock = testClock(new Date('2026-10-06T12:00:00Z'));
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { clock });
  await t.createProject('tokens');
});

afterAll(async () => {
  await database.drop();
});

async function list(): Promise<AgentTokenList> {
  return AgentTokenList.parse(
    await (await t.asOwner('/api/v1/projects/tokens/agent-tokens')).json(),
  );
}

describe('agent token lifecycle (CONCEPT §6)', () => {
  let created: CreatedAgentToken;

  it('creates a token: secret once, sha256 and prefix stored, expiry from days', async () => {
    const res = await t.asOwner('/api/v1/projects/tokens/agent-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'claude code', scopes: ['proa:propose', 'proa:read'] }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    created = CreatedAgentToken.parse(await res.json());
    expect(created.secret).toMatch(/^proa_at_[0-9A-Za-z]{49}$/);
    expect(created.prefix).toBe(created.secret.slice(8, 16));
    expect(created.scopes).toEqual(['proa:propose', 'proa:read']);
    expect(created.expiresAt).toBe(new Date(clock.now().getTime() + 90 * DAY).toISOString());

    const rows = await database.db.execute<{ secret_hash: string; prefix: string }>(
      sql`SELECT secret_hash, prefix FROM agent_token WHERE id = ${created.id}`,
    );
    expect(rows.rows[0]).toEqual({
      secret_hash: hashAgentTokenSecret(created.secret),
      prefix: created.prefix,
    });
    const leaked = await database.db.execute(
      sql`SELECT 1 FROM agent_token WHERE secret_hash = ${created.secret} OR prefix = ${created.secret}`,
    );
    expect(leaked.rows).toHaveLength(0);
  });

  it('lists tokens without secrets', async () => {
    const tokens = await list();
    expect(tokens.items.map((x) => x.id)).toEqual([created.id]);
    expect(JSON.stringify(tokens)).not.toContain(created.secret);
    expect(tokens.items[0]?.lastUsedAt).toBeNull();
  });

  it('authenticates REST calls and records last_used_at', async () => {
    const res = await t.asToken(created.secret, '/api/v1/me');
    expect(res.status).toBe(200);
    const me = Me.parse(await res.json());
    expect(me).toMatchObject({
      kind: 'service',
      clientId: created.id,
      authMode: 'local',
      handle: 'agent:claude code',
    });
    expect((await list()).items[0]?.lastUsedAt).toBe(clock.now().toISOString());
  });

  it('writes last_used_at at most once a minute', async () => {
    const first = (await list()).items[0]?.lastUsedAt;
    clock.advance(30_000);
    await t.asToken(created.secret, '/api/v1/me');
    expect((await list()).items[0]?.lastUsedAt).toBe(first);
    clock.advance(31_000);
    await t.asToken(created.secret, '/api/v1/me');
    expect((await list()).items[0]?.lastUsedAt).toBe(clock.now().toISOString());
  });

  it('rejects malformed, mistyped and unknown secrets with 401 invalid_token', async () => {
    const flipped = created.secret.slice(0, -1) + (created.secret.endsWith('A') ? 'B' : 'A');
    for (const secret of ['nope', 'proa_at_short', flipped, `${created.secret}x`]) {
      const res = await t.asToken(secret, '/api/v1/me');
      expect(res.status, secret).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('invalid_token');
    }
    const basic = await t.request('/api/v1/me', {
      headers: { authorization: 'Basic Zm9vOmJhcg==' },
    });
    expect(basic.status).toBe(401);
  });

  it('expires tokens', async () => {
    const short = await t.createToken('tokens', ['proa:read'], 1);
    expect((await t.asToken(short.secret, '/api/v1/me')).status).toBe(200);
    clock.advance(DAY);
    expect((await t.asToken(short.secret, '/api/v1/me')).status).toBe(401);
    clock.set(new Date('2026-10-06T12:10:00Z'));
  });

  it('revokes tokens immediately and idempotently', async () => {
    const res = await t.asOwner(`/api/v1/projects/tokens/agent-tokens/${created.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect((await t.asToken(created.secret, '/api/v1/me')).status).toBe(401);
    const again = await t.asOwner(`/api/v1/projects/tokens/agent-tokens/${created.id}`, {
      method: 'DELETE',
    });
    expect(again.status).toBe(204);
    const revoked = (await list()).items.find((x) => x.id === created.id);
    expect(revoked?.revokedAt).toBe(clock.now().toISOString());
    const events = await database.db.execute<{ type: string }>(
      sql`SELECT type FROM event WHERE type LIKE 'agent_token.%' ORDER BY seq`,
    );
    expect(events.rows.map((e) => e.type)).toEqual([
      'agent_token.created',
      'agent_token.created',
      'agent_token.revoked',
    ]);
  });

  it('validates the request: no review scope, at most 365 days', async () => {
    const post = (body: unknown) =>
      t.asOwner('/api/v1/projects/tokens/agent-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ name: 'x', scopes: ['proa:review'] })).status).toBe(422);
    expect((await post({ name: 'x', expiresInDays: 366 })).status).toBe(422);
    expect((await post({ name: '' })).status).toBe(422);
    const defaults = CreatedAgentToken.parse(await (await post({ name: 'defaults' })).json());
    expect(defaults.scopes).toEqual(['proa:propose', 'proa:read']);
  });
});

describe('owner session (local mode)', () => {
  it('issues an HttpOnly SameSite=Strict cookie that acts as the owner', async () => {
    const res = await t.request('/api/v1/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:7401' },
      body: JSON.stringify({ client: 'proa-cli' }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^proa_session=v1\.proa-cli\./);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    expect(Me.parse(await res.json())).toMatchObject({
      kind: 'user',
      handle: 'owner',
      clientId: 'proa-cli',
    });

    const value = cookie.split(';')[0] ?? '';
    const me = await t.request('/api/v1/me', { headers: { cookie: value } });
    expect(Me.parse(await me.json()).clientId).toBe('proa-cli');
    const tampered = value.replace('proa-cli', 'proa-web');
    expect((await t.request('/api/v1/me', { headers: { cookie: tampered } })).status).toBe(401);
  });

  it('accepts a bodyless POST (defaults to proa-web) and DELETE clears the cookie', async () => {
    const res = await t.request('/api/v1/session', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(Me.parse(await res.json()).clientId).toBe('proa-web');
    const del = await t.request('/api/v1/session', { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(del.headers.get('set-cookie')).toMatch(/proa_session=;.*Max-Age=0/);
  });

  it('refuses sessions to foreign origins and hosts (403)', async () => {
    const evil = await t.request('/api/v1/session', {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    const otherPort = await t.request('/api/v1/session', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(otherPort.status).toBe(403);
    const rebound = await t.app.request('http://attacker.example/api/v1/session', {
      method: 'POST',
    });
    expect(rebound.status).toBe(403);
  });

  it('agent tokens win over a session cookie', async () => {
    const token = await t.createToken('tokens', ['proa:read']);
    const res = await t.request('/api/v1/me', {
      headers: { cookie: t.ownerCookie, authorization: `Bearer ${token.secret}` },
    });
    expect(Me.parse(await res.json()).kind).toBe('service');
  });
});
