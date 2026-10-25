import { randomBytes } from "crypto";

/**
 * Public evidence references: "NSE-" and 26 Crockford base32 characters, which is
 * 128 random bits. Unguessable, so the public Passport cannot be walked by
 * counting, and free of I, L, O and U so it survives being read aloud or typed
 * from a printout.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newPublicRef(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return `NSE-${out}`;
}

export const PUBLIC_REF_PATTERN = /^NSE-[0-9A-Z]{26,32}$/;
