import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  agentToken,
  anyCredential,
  describeCredential,
  ownerCredential,
  ownerKeyFile,
  readOwnerKey,
} from '../../src/credentials.ts';
import {
  AGENT_TOKEN,
  OWNER_KEY,
  ownerKeyFile as writeKey,
  tempDir,
  testIo,
} from '../support/io.ts';

let dir: string;

beforeAll(async () => {
  dir = await tempDir();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const posix = process.platform !== 'win32';

describe('owner key file location', () => {
  it('uses --owner-key-file, then PROA_OWNER_KEY_FILE, then the XDG default', () => {
    const t = testIo({ PROA_OWNER_KEY_FILE: 'keys/k' }, undefined, { cwd: '/work', home: '/h' });
    expect(ownerKeyFile(t.io, { ownerKeyFile: '/abs/k' })).toBe('/abs/k');
    expect(ownerKeyFile(t.io, {})).toBe('/work/keys/k');
    expect(ownerKeyFile(testIo({}, undefined, { home: '/h' }).io, {})).toBe(
      '/h/.local/state/proa/owner-key',
    );
    expect(ownerKeyFile(testIo({ XDG_STATE_HOME: '/s' }).io, {})).toBe('/s/proa/owner-key');
  });
});

describe('readOwnerKey', () => {
  it('reads a private key file', async () => {
    const file = await writeKey(path.join(dir, 'ok'));
    expect(await readOwnerKey(file)).toBe(OWNER_KEY);
    const t = testIo({ XDG_STATE_HOME: path.join(dir, 'ok') });
    const credential = await ownerCredential(t.io, {});
    expect(credential).toEqual({ kind: 'owner-key', secret: OWNER_KEY, file });
    expect(describeCredential(credential)).toBe(`owner key ${file}`);
    expect(describeCredential(credential)).not.toContain(OWNER_KEY);
  });

  it('explains how to get a missing key, including Docker', async () => {
    await expect(readOwnerKey(path.join(dir, 'none', 'owner-key'))).rejects.toThrow(
      /first start[\s\S]*docker compose -p proa2/,
    );
  });

  it.skipIf(!posix)('refuses a file that group or others can read', async () => {
    const file = await writeKey(path.join(dir, 'open'), OWNER_KEY, 0o644);
    await expect(readOwnerKey(file)).rejects.toThrow(/chmod 600/);
  });

  it('refuses malformed content and directories', async () => {
    const file = await writeKey(path.join(dir, 'bad'), 'proa_ok_nope');
    await expect(readOwnerKey(file)).rejects.toThrow(/does not hold a ProA owner key/);
    await mkdir(path.join(dir, 'folder', 'owner-key'), { recursive: true });
    await expect(readOwnerKey(path.join(dir, 'folder', 'owner-key'))).rejects.toThrow(
      /not a regular file/,
    );
  });
});

describe('agent token', () => {
  it('comes from --token or PROA_TOKEN', () => {
    expect(agentToken(testIo({ PROA_TOKEN: AGENT_TOKEN }).io, {})).toBe(AGENT_TOKEN);
    expect(agentToken(testIo().io, { token: AGENT_TOKEN })).toBe(AGENT_TOKEN);
    expect(agentToken(testIo({ PROA_TOKEN: '' }).io, {})).toBeUndefined();
  });

  it('never accepts the owner key or other strings as a token', () => {
    expect(() => agentToken(testIo().io, { token: OWNER_KEY })).toThrow(/owner key/);
    expect(() => agentToken(testIo().io, { token: 'secret' })).toThrow(/proa_at_/);
  });

  it('wins over the owner key where both work', async () => {
    const file = await writeKey(path.join(dir, 'both'));
    const t = testIo({ PROA_TOKEN: AGENT_TOKEN, PROA_OWNER_KEY_FILE: file });
    expect(await anyCredential(t.io, {})).toEqual({ kind: 'agent-token', secret: AGENT_TOKEN });
    expect((await anyCredential(testIo({ PROA_OWNER_KEY_FILE: file }).io, {})).kind).toBe(
      'owner-key',
    );
  });
});
