/**
 * The local owner key (`proa_ok_…`, auth/owner-key.ts): the CLI's bootstrap
 * credential acts as the owner on `proa-cli` over REST, never over MCP.
 */
import type { CreatedAgentToken, Me, Project } from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateOwnerKey } from '../../src/auth/owner-key.ts';
import { startTestApp, type TestApp } from '../support/app.ts';
import { createTestDatabase, type TestDatabase } from '../support/db.ts';

let database: TestDatabase;
let t: TestApp;
let without: TestApp;
const ownerKey = generateOwnerKey();

beforeAll(async () => {
  database = await createTestDatabase();
  t = startTestApp(database, { ownerKey });
  without = startTestApp(database);
});

afterAll(async () => {
  await database.drop();
});

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe('owner key', () => {
  it('acts as the owner on the proa-cli client', async () => {
    const res = await t.request('/api/v1/me', { headers: bearer(ownerKey) });
    expect(res.status).toBe(200);
    expect((await res.json()) as Me).toMatchObject({
      kind: 'user',
      handle: 'owner',
      authMode: 'local',
      clientId: 'proa-cli',
    });
  });

  it('may create projects and agent tokens (owner on an interactive client)', async () => {
    const created = await t.request('/api/v1/projects', {
      method: 'POST',
      headers: { ...bearer(ownerKey), 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'cli', name: 'From the CLI' }),
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as Project).role).toBe('owner');

    const token = await t.request('/api/v1/projects/cli/agent-tokens', {
      method: 'POST',
      headers: { ...bearer(ownerKey), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cli test' }),
    });
    expect(token.status).toBe(201);
    expect(((await token.json()) as CreatedAgentToken).secret).toMatch(/^proa_at_/);

    // The same owner as the web session: the project is visible there too.
    const viaSession = await t.asOwner('/api/v1/projects/cli');
    expect(viaSession.status).toBe(200);
  });

  it('rejects a wrong key with 401 invalid_token', async () => {
    const res = await t.request('/api/v1/projects', { headers: bearer(generateOwnerKey()) });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
    expect(await res.json()).toMatchObject({ code: 'unauthorized', detail: 'invalid owner key' });
  });

  it('is rejected by a server without an owner key', async () => {
    const res = await without.request('/api/v1/projects', { headers: bearer(ownerKey) });
    expect(res.status).toBe(401);
  });

  it('is never accepted on MCP (agents use agent tokens)', async () => {
    const res = await t.request('/mcp', {
      method: 'POST',
      headers: {
        ...bearer(ownerKey),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'x', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      detail: expect.stringMatching(/agent token/) as unknown,
    });
  });
});
