/**
 * Local-mode owner key: the bootstrap credential of the `proa` CLI.
 *
 * Local mode has one human, the owner. The web UI acts as the owner through
 * the session cookie (`POST /api/v1/session`); the CLI on the same machine
 * acts as the owner through this key, which the server creates on its first
 * start in a file that only the server's OS user can read:
 *
 * - directory created with mode 0700, file created exclusively (`O_EXCL`)
 *   with mode 0600, content `proa_ok_<43 base64url characters>` (256 bits);
 * - an existing file is used only if it is a regular file owned by this OS
 *   user and not readable or writable by group or others (like ssh keys);
 * - the key itself is never logged and never stored in the database; the
 *   server keeps its sha256 in memory and compares in constant time.
 *
 * Deleting the file and restarting the server rotates the key.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { OWNER_KEY_PATTERN, OWNER_KEY_PREFIX } from '@proa/contracts';

/** The owner key file is missing, unsafe or malformed. */
export class OwnerKeyError extends Error {
  override readonly name = 'OwnerKeyError';
}

export function generateOwnerKey(): string {
  return `${OWNER_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** True if `value` has the owner key shape (prefix plus 43 base64url characters). */
export function isOwnerKey(value: string): boolean {
  return OWNER_KEY_PATTERN.test(value);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : undefined;
}

/**
 * Checks that `file` is a regular file of this OS user without group or
 * other permissions (skipped on Windows, where mode bits mean nothing).
 *
 * @throws {OwnerKeyError} with the command that fixes it
 */
export async function assertPrivateFile(file: string): Promise<void> {
  const info = await stat(file);
  if (!info.isFile()) throw new OwnerKeyError(`${file} is not a regular file`);
  if (process.platform === 'win32') return;
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) {
    throw new OwnerKeyError(`${file} belongs to another OS user (uid ${info.uid}, not ${uid})`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new OwnerKeyError(
      `${file} is accessible by group or others (mode ${(info.mode & 0o777).toString(8)}); run: chmod 600 ${file}`,
    );
  }
}

async function readKey(file: string): Promise<string> {
  await assertPrivateFile(file);
  const key = (await readFile(file, 'utf8')).trim();
  if (!isOwnerKey(key)) {
    throw new OwnerKeyError(`${file} does not hold an owner key; delete it to create a new one`);
  }
  return key;
}

/**
 * Reads the owner key from `file`, creating directory (0700) and file (0600)
 * with a fresh key if the file does not exist yet.
 *
 * @throws {OwnerKeyError} if the file exists but is unsafe or malformed
 */
export async function loadOrCreateOwnerKey(
  file: string,
): Promise<{ key: string; created: boolean }> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = generateOwnerKey();
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (err) {
    if (errorCode(err) === 'EEXIST') return { key: await readKey(file), created: false };
    throw err;
  }
  try {
    await handle.writeFile(`${key}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return { key, created: true };
}

/** Constant-time check of presented owner keys against the one key. */
export type OwnerKeyVerifier = (candidate: string) => boolean;

export function ownerKeyVerifier(key: string): OwnerKeyVerifier {
  if (!isOwnerKey(key)) throw new OwnerKeyError('not an owner key');
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  const expected = digest(key);
  return (candidate) => timingSafeEqual(digest(candidate), expected);
}
