import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { OWNER_KEY_PATTERN } from '@proa/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  OwnerKeyError,
  generateOwnerKey,
  isOwnerKey,
  loadOrCreateOwnerKey,
  ownerKeyVerifier,
} from '../../src/auth/owner-key.ts';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'proa-owner-key-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const posix = process.platform !== 'win32';

describe('owner key', () => {
  it('generates distinct 256-bit keys with the proa_ok_ prefix', () => {
    const a = generateOwnerKey();
    const b = generateOwnerKey();
    expect(a).toMatch(OWNER_KEY_PATTERN);
    expect(isOwnerKey(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(isOwnerKey(`proa_at_${a.slice(8)}`)).toBe(false);
  });

  it('creates the file (0600) in a new directory (0700) and reuses it afterwards', async () => {
    const file = path.join(dir, 'state', 'proa', 'owner-key');
    const first = await loadOrCreateOwnerKey(file);
    expect(first.created).toBe(true);
    expect(first.key).toMatch(OWNER_KEY_PATTERN);
    expect((await readFile(file, 'utf8')).trim()).toBe(first.key);
    if (posix) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    }

    const second = await loadOrCreateOwnerKey(file);
    expect(second).toEqual({ key: first.key, created: false });
  });

  it.skipIf(!posix)('refuses a key file that group or others can read', async () => {
    const file = path.join(dir, 'open', 'owner-key');
    await loadOrCreateOwnerKey(file);
    await chmod(file, 0o644);
    await expect(loadOrCreateOwnerKey(file)).rejects.toThrow(/chmod 600/);
    await expect(loadOrCreateOwnerKey(file)).rejects.toBeInstanceOf(OwnerKeyError);
  });

  it('refuses malformed content and non-files', async () => {
    const file = path.join(dir, 'bad', 'owner-key');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'proa_ok_short\n', { mode: 0o600 });
    await expect(loadOrCreateOwnerKey(file)).rejects.toThrow(/does not hold an owner key/);

    const folder = path.join(dir, 'folder', 'owner-key');
    await mkdir(folder, { recursive: true });
    await expect(loadOrCreateOwnerKey(folder)).rejects.toThrow(/not a regular file/);
  });

  it('verifies presented keys in constant time', () => {
    const key = generateOwnerKey();
    const verify = ownerKeyVerifier(key);
    expect(verify(key)).toBe(true);
    expect(verify(generateOwnerKey())).toBe(false);
    expect(verify('')).toBe(false);
    expect(() => ownerKeyVerifier('secret')).toThrow(OwnerKeyError);
  });
});
