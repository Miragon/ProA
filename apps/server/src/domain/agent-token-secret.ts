/**
 * Agent token secrets (CONCEPT §6): `proa_at_<32 random bytes, base62><checksum>`,
 * recognizable by secret scanners, stored only as sha256 plus an 8-character
 * prefix.
 *
 * Layout: `proa_at_` + 43 base62 characters (256 random bits, zero-padded) +
 * 6 base62 characters of the CRC-32 of those 43 characters. The checksum lets
 * scanners and the server reject typos and random strings without a lookup.
 */
import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

import { AGENT_TOKEN_PREFIX } from '@proa/contracts';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BODY_LENGTH = 43;
const CHECKSUM_LENGTH = 6;
const TOKEN_RE = new RegExp(
  `^${AGENT_TOKEN_PREFIX}([0-9A-Za-z]{${BODY_LENGTH}})([0-9A-Za-z]{${CHECKSUM_LENGTH}})$`,
);

function toBase62(value: bigint, width: number): string {
  let out = '';
  let v = value;
  while (v > 0n) {
    out = BASE62.charAt(Number(v % 62n)) + out;
    v /= 62n;
  }
  return out.padStart(width, '0');
}

function checksum(body: string): string {
  return toBase62(BigInt(crc32(body)), CHECKSUM_LENGTH);
}

/** sha256 (hex) of a secret, the only form the database stores. */
export function hashAgentTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export interface NewAgentTokenSecret {
  /** Shown to the owner once. */
  secret: string;
  /** First 8 characters after `proa_at_`. */
  prefix: string;
  hash: string;
}

/** Generates a fresh secret from 256 random bits. */
export function generateAgentTokenSecret(): NewAgentTokenSecret {
  const body = toBase62(BigInt(`0x${randomBytes(32).toString('hex')}`), BODY_LENGTH);
  const secret = `${AGENT_TOKEN_PREFIX}${body}${checksum(body)}`;
  return { secret, prefix: body.slice(0, 8), hash: hashAgentTokenSecret(secret) };
}

/** True if `value` has the agent token shape and a valid checksum. */
export function isWellFormedAgentToken(value: string): boolean {
  const m = TOKEN_RE.exec(value);
  return m?.[1] !== undefined && m[2] === checksum(m[1]);
}
