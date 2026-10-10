import { describe, expect, it } from 'vitest';

import {
  generateAgentTokenSecret,
  hashAgentTokenSecret,
  isWellFormedAgentToken,
} from '../../src/domain/agent-token-secret.ts';
import { decodeCursor, encodeCursor, toPage } from '../../src/domain/cursor.ts';
import { DomainError } from '../../src/domain/errors.ts';
import { modelKeyFromPath } from '../../src/domain/paths.ts';
import { createSessionCodec } from '../../src/auth/session.ts';

describe('agent token secrets', () => {
  it('have the proa_at_ shape with a checksum, 8-char prefix and sha256', () => {
    const t = generateAgentTokenSecret();
    expect(t.secret).toMatch(/^proa_at_[0-9A-Za-z]{43}[0-9A-Za-z]{6}$/);
    expect(t.prefix).toBe(t.secret.slice(8, 16));
    expect(t.hash).toBe(hashAgentTokenSecret(t.secret));
    expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isWellFormedAgentToken(t.secret)).toBe(true);
  });

  it('are unique and reject typos via the checksum', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateAgentTokenSecret().secret));
    expect(secrets.size).toBe(50);
    const t = generateAgentTokenSecret().secret;
    const typo = `${t.slice(0, 20)}${t[20] === 'a' ? 'b' : 'a'}${t.slice(21)}`;
    expect(isWellFormedAgentToken(typo)).toBe(false);
    expect(isWellFormedAgentToken('proa_at_')).toBe(false);
    expect(isWellFormedAgentToken(`x${t}`)).toBe(false);
  });
});

describe('modelKeyFromPath (CONCEPT §4: the key is the slugified path)', () => {
  it.each([
    ['finanzen/rechnungsstellung.bpmn', 'finanzen/rechnungsstellung'],
    ['Vertrieb/Auftragsabwicklung.BPMN', 'vertrieb/auftragsabwicklung'],
    ['Prüfung & Freigabe/Bestellung prüfen.bpmn', 'pruefung-freigabe/bestellung-pruefen'],
    ['./a//b/../c.bpmn20.xml', 'a/b/c'],
    ['windows\\path\\Model.xml', 'windows/path/model'],
    ['Café crème.bpmn', 'cafe-creme'],
    ['---.bpmn', null],
    ['', null],
  ])('%s → %s', (path, key) => {
    expect(modelKeyFromPath(path)).toBe(key);
  });
});

describe('cursors', () => {
  it('round-trip and page', () => {
    const c = encodeCursor(['call', 'a#b', 'c#d']);
    expect(decodeCursor(c, ['string', 'string', 'string'])).toEqual(['call', 'a#b', 'c#d']);
    expect(toPage([1, 2, 3], 2, (n) => [n])).toEqual({
      items: [1, 2],
      nextCursor: encodeCursor([2]),
    });
    expect(toPage([1, 2], 2, (n) => [n]).nextCursor).toBeNull();
  });

  it.each(['nope', encodeCursor([1]), encodeCursor(['a', 'b'])])('rejects %s', (cursor) => {
    expect(() => decodeCursor(cursor, ['string'])).toThrow(DomainError);
  });

  it('takes an int only as a whole number within the integer column', () => {
    expect(decodeCursor(encodeCursor(['s', 0, 'p']), ['string', 'int', 'string'])).toEqual([
      's',
      0,
      'p',
    ]);
    expect(decodeCursor(encodeCursor([2_147_483_647]), ['int'])).toEqual([2_147_483_647]);
    for (const bad of [2_147_483_648, -1, 1.5, 1e300, '3']) {
      expect(() => decodeCursor(encodeCursor([bad]), ['int']), String(bad)).toThrow(DomainError);
    }
    // A plain number stays any number (e.g. a bigint seq).
    expect(decodeCursor(encodeCursor([2 ** 40]), ['number'])).toEqual([2 ** 40]);
  });
});

describe('session cookies', () => {
  const codec = createSessionCodec('k'.repeat(32), 3600);
  const now = new Date('2026-10-06T12:00:00Z');

  it('verifies what it issued, within its lifetime', () => {
    const value = codec.issue('proa-cli', now);
    expect(codec.verify(value, now)).toEqual({
      client: 'proa-cli',
      issuedAt: now.getTime() / 1000,
    });
    expect(codec.verify(value, new Date(now.getTime() + 3599_000))).not.toBeNull();
    expect(codec.verify(value, new Date(now.getTime() + 3600_000))).toBeNull();
  });

  it('rejects tampering, other keys and garbage', () => {
    const value = codec.issue('proa-web', now);
    expect(codec.verify(value.replace('proa-web', 'proa-cli'), now)).toBeNull();
    expect(createSessionCodec('x'.repeat(32)).verify(value, now)).toBeNull();
    expect(codec.verify('v1.proa-web.1.x.y', now)).toBeNull();
    expect(codec.verify('', now)).toBeNull();
  });
});
