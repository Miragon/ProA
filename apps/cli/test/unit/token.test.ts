import { rm } from 'node:fs/promises';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseExpiry, parseScopes } from '../../src/commands/token.ts';
import { CLI_MAIN } from '../../src/mcp-config.ts';
import { runCli } from '../../src/program.ts';
import { OWNER_KEY, fakeApi, json, ownerKeyFile, problem, tempDir, testIo } from '../support/io.ts';

let dir: string;
let keyFile: string;

beforeAll(async () => {
  dir = await tempDir();
  keyFile = await ownerKeyFile(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SECRET = `proa_at_${'s'.repeat(49)}`;

function created(scopes: string[]) {
  return {
    id: 'agt_01J9Z3N4X5Q6R7S8T9V0W1X2Y3',
    name: 'claude',
    prefix: 'ssssssss',
    scopes,
    expiresAt: '2027-01-05T00:00:00.000Z',
    revokedAt: null,
    lastUsedAt: null,
    createdAt: '2026-10-07T00:00:00.000Z',
    secret: SECRET,
  };
}

describe('parseScopes / parseExpiry', () => {
  it('accepts full and short scope names, lists and duplicates', () => {
    expect(parseScopes(['proa:read'])).toEqual(['proa:read']);
    expect(parseScopes(['read,propose', 'proa:read'])).toEqual(['proa:read', 'proa:propose']);
    expect(parseScopes(['write', 'read'])).toEqual(['proa:read', 'proa:write']);
    expect(() => parseScopes(['proa:review'])).toThrow(/unknown scope/);
    expect(() => parseScopes([','])).toThrow(/at least one/);
  });

  it('reads days and weeks within 1–365 days', () => {
    expect(parseExpiry('90d')).toBe(90);
    expect(parseExpiry('90')).toBe(90);
    expect(parseExpiry('12w')).toBe(84);
    expect(parseExpiry('365D')).toBe(365);
    for (const bad of ['0d', '366d', '53w', '1y', 'soon', '']) {
      expect(() => parseExpiry(bad), bad).toThrow(/invalid expiry/);
    }
  });
});

describe('proa token create', () => {
  it('creates a token as the owner and prints the secret with client configurations', async () => {
    const api = fakeApi({
      'POST /api/v1/projects/nordwind-handel/agent-tokens': async (req) => {
        const body = (await req.json()) as { scopes: string[] };
        return json(created(body.scopes), 201);
      },
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    const code = await runCli(
      [
        'token',
        'create',
        '--project',
        'nordwind-handel',
        '--name',
        'claude',
        '--scopes',
        'proa:read',
        'propose',
        '--expires',
        '30d',
      ],
      t.io,
    );
    expect(t.err()).toBe('');
    expect(code).toBe(0);
    expect(api.seen).toHaveLength(1);
    expect(api.seen[0]?.authorization).toBe(`Bearer ${OWNER_KEY}`);
    expect(await api.seen[0]?.body.json()).toEqual({
      name: 'claude',
      scopes: ['proa:read', 'proa:propose'],
      expiresInDays: 30,
    });

    const out = t.out();
    expect(out).toContain(`\n${SECRET}\n`);
    expect(out).toContain('shown only now');
    expect(out).toContain(
      `claude mcp add --transport http proa http://127.0.0.1:7400/mcp --header "Authorization: Bearer ${SECRET}"`,
    );
    // Claude Desktop: absolute node and CLI paths (no shell PATH), env carries URL and token.
    const desktop = JSON.parse(out.slice(out.indexOf('{'))) as {
      mcpServers: { proa: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(desktop.mcpServers.proa).toEqual({
      command: process.execPath,
      args: [CLI_MAIN, 'mcp'],
      env: { PROA_URL: 'http://127.0.0.1:7400', PROA_TOKEN: SECRET },
    });
    expect(out).not.toContain(OWNER_KEY);
  });

  it('prints a docker exec bridge for Claude Desktop inside the container', async () => {
    const api = fakeApi({
      'POST /api/v1/projects/p/agent-tokens': () => json(created(['proa:read']), 201),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile, PROA_CONTAINER: 'proa2-proa-1' }, api.fetch);
    expect(await runCli(['token', 'create', '-p', 'p'], t.io)).toBe(0);
    const out = t.out();
    const desktop = JSON.parse(out.slice(out.indexOf('{'))) as {
      mcpServers: { proa: unknown };
    };
    expect(out).toContain('replace "docker" with its');
    expect(desktop.mcpServers.proa).toEqual({
      command: 'docker',
      args: ['exec', '-i', '-e', 'PROA_TOKEN', 'proa2-proa-1', 'proa', 'mcp'],
      env: { PROA_TOKEN: SECRET },
    });
    // Defaults: read + propose for 90 days.
    expect(await api.seen[0]?.body.json()).toEqual({
      name: 'agent',
      scopes: ['proa:read', 'proa:propose'],
      expiresInDays: 90,
    });
  });

  it('--json prints only the token', async () => {
    const api = fakeApi({
      'POST /api/v1/projects/p/agent-tokens': () => json(created(['proa:read']), 201),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['token', 'create', '-p', 'p', '--json'], t.io)).toBe(0);
    expect(JSON.parse(t.out())).toMatchObject({ secret: SECRET, scopes: ['proa:read'] });
  });

  it('rejects invalid input before calling the server', async () => {
    const api = fakeApi({});
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['token', 'create', '-p', 'p', '--scopes', 'proa:review'], t.io)).toBe(1);
    expect(t.err()).toContain('unknown scope');
    expect(await runCli(['token', 'create', '-p', 'p', '--expires', '2y'], t.io)).toBe(1);
    expect(t.err()).toContain('invalid expiry');
    expect(api.seen).toEqual([]);
  });

  it('needs the owner key and reports server problems', async () => {
    const none = testIo({ PROA_OWNER_KEY_FILE: `${dir}/missing` });
    expect(await runCli(['token', 'create', '-p', 'p'], none.io)).toBe(1);
    expect(none.err()).toContain('no owner key');

    const api = fakeApi({
      'POST /api/v1/projects/p/agent-tokens': () =>
        problem(404, 'not-found', 'project p not found'),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['token', 'create', '-p', 'p'], t.io)).toBe(1);
    expect(t.err()).toContain(
      'create an agent token in p failed (404 not-found): project p not found',
    );
  });
});

describe('proa token list / revoke', () => {
  it('lists tokens without secrets and revokes by id', async () => {
    const { secret: _secret, ...token } = created(['proa:read']);
    const api = fakeApi({
      'GET /api/v1/projects/p/agent-tokens': () => json({ items: [token] }),
      'DELETE /api/v1/projects/p/agent-tokens/agt_01J9Z3N4X5Q6R7S8T9V0W1X2Y3': () =>
        new Response(null, { status: 204 }),
    });
    const t = testIo({ PROA_OWNER_KEY_FILE: keyFile }, api.fetch);
    expect(await runCli(['token', 'list', '-p', 'p'], t.io)).toBe(0);
    expect(t.out()).toContain('agt_01J9Z3N4X5Q6R7S8T9V0W1X2Y3  proa_at_ssssssss…  claude');
    expect(t.out()).toContain('never used');
    expect(
      await runCli(['token', 'revoke', 'agt_01J9Z3N4X5Q6R7S8T9V0W1X2Y3', '-p', 'p'], t.io),
    ).toBe(0);
    expect(t.out()).toContain('revoked agt_01J9Z3N4X5Q6R7S8T9V0W1X2Y3');
    expect(api.seen.map((s) => s.method)).toEqual(['GET', 'DELETE']);
  });
});
