/**
 * Sortable, collision-resistant ids (ULID-style): 48-bit millisecond timestamp
 * + 80 bits of randomness, Crockford base32. Lexicographic order ≈ time order.
 * Ordering on the bus is still defined by `seq`; ids are just stable handles.
 */
import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)
const TIME_LEN = 10; // 10 chars * 5 bits = 50 bits, covers a 48-bit ms timestamp
const RAND_LEN = 16; // 16 chars * 5 bits = 80 bits of entropy

function encodeTime(ms: number): string {
  let t = Math.max(0, Math.floor(ms));
  const out = new Array<string>(TIME_LEN);
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out[i] = ENCODING[t % 32] as string;
    t = Math.floor(t / 32);
  }
  return out.join('');
}

function encodeRandom(): string {
  // 256 % 32 === 0, so masking the low 5 bits of a random byte is uniform.
  const bytes = randomBytes(RAND_LEN);
  let s = '';
  for (let i = 0; i < RAND_LEN; i++) {
    s += ENCODING[(bytes[i] as number) & 31];
  }
  return s;
}

/** A 26-char ULID-style identifier. */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

/** A namespaced id, e.g. `msg_01J...`, `task_01J...`. */
export function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${ulid(now)}`;
}
