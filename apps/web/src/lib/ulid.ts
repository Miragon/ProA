/**
 * ULIDs for the value chain modeler's new element ids (M4 §4 "Collision-free
 * ids"): 48 bits of time in milliseconds and 80 random bits from
 * `crypto.getRandomValues`, 26 characters of Crockford base32. A step added in
 * a later editing session therefore never gets the id of a deleted step, as
 * the modeler's own per-instance counter (`shape_1`, `shape_2`, …) would.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/** Crockford base32, the 26-character ULID form: `01J…`. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A new ULID; `now` and `random` are injectable for tests. */
export function ulid(
  now: number = Date.now(),
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (bytes) => {
    crypto.getRandomValues(bytes);
  },
): string {
  let time = '';
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < TIME_CHARS; i += 1) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  // 80 random bits = 16 characters of 5 bits each, taken from 10 random bytes.
  const bytes = new Uint8Array(10);
  random(bytes);
  let bits = 0;
  let buffer = 0;
  let rest = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rest += ALPHABET.charAt((buffer >> bits) & 31);
    }
    buffer &= (1 << bits) - 1;
  }
  return time + rest.slice(0, RANDOM_CHARS);
}
