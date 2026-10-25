import * as crypto from "crypto";
import { keccak256, toUtf8Bytes } from "ethers";
import { env } from "../config/env";
import { badRequest } from "./errors";

/**
 * Every cryptographic primitive the system uses, in one file, so the rules
 * about what is hashed, what is encrypted and what is never stored are
 * auditable in one read.
 *
 * Conventions:
 *   - every digest crosses a boundary as "0x" + 64 lowercase hex, which is both
 *     what bytes32 expects and what the hash32 database domain enforces
 *   - Aadhaar numbers are HMAC'd with a server-side pepper and discarded. There
 *     is no function here that stores or returns one
 */

const AES_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96 bit nonce, the GCM standard
const encryptionKey = Buffer.from(env.EVIDENCE_ENCRYPTION_KEY, "hex");

export const HASH32_PATTERN = /^0x[0-9a-f]{64}$/;

export function isHash32(value: unknown): value is string {
  return typeof value === "string" && HASH32_PATTERN.test(value);
}

export function assertHash32(value: unknown, label: string): string {
  if (!isHash32(value)) {
    throw badRequest(`${label} must be a 0x-prefixed lowercase SHA-256 digest.`);
  }
  return value;
}

/** SHA-256 of raw bytes. The canonical evidence digest. */
export function sha256Hex(data: Buffer | Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  return "0x" + crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * keccak256 of a UTF-8 string. Used for identifiers that must match a
 * contract constant or a caseId derived from an FIR number.
 */
export function keccakOfString(value: string): string {
  return keccak256(toUtf8Bytes(value));
}

/**
 * The 1.0 bytes32 caseId: keccak256 of the FIR number. Kept for cases created
 * before 2.0, whose anchors are already on chain under it. FIR numbers are
 * guessable, so this key effectively publishes the FIR; new cases use
 * saltedCaseIdHash instead (docs/DECISIONS.md D-02).
 */
export function caseIdHash(firNumber: string): string {
  return keccakOfString(firNumber.trim().toUpperCase());
}

/**
 * The 2.0 bytes32 caseId: keccak256 of the case reference and 32 random bytes.
 * Nothing about the case can be recovered from it without the salt, which never
 * leaves the database.
 */
export function saltedCaseIdHash(caseReference: string, saltHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(saltHex)) throw new Error("Case salt must be 32 bytes of lower-case hex.");
  return keccakOfString(`nyaysetu:case:v2:${caseReference}:${saltHex}`);
}

/**
 * The officer identity written into registerEvidence for 2.0 registrations, in
 * place of an Aadhaar-derived token (D-05). Keyed with the server pepper so it
 * cannot be linked to a user id by anyone who lacks it, and stable per officer so
 * the chain can still show that two items were registered by the same person.
 */
export function officerPseudonym(userId: string): string {
  return "0x" + crypto.createHmac("sha256", env.AADHAAR_TOKEN_PEPPER).update(`nyaysetu:officer:${userId}`).digest("hex");
}

/**
 * Turns an Aadhaar number into the opaque token the rest of the system uses.
 *
 * HMAC rather than a plain hash: a bare SHA-256 of a 12 digit number is
 * brute-forceable in seconds, so the pepper is what makes the token
 * non-reversible for anyone who steals only the database.
 *
 * The plaintext number is never returned, stored or logged by anything here.
 */
export function aadhaarToken(aadhaarNumber: string): string {
  const digits = aadhaarNumber.replace(/[^0-9]/g, "");

  // Separate messages, because the three failures have three different causes and
  // "invalid Aadhaar number" tells somebody holding a card nothing about which
  // digit they mistyped.
  if (digits.length !== 12) {
    throw badRequest("An Aadhaar number is exactly 12 digits.");
  }
  if (/^[01]/.test(digits)) {
    throw badRequest("An Aadhaar number never begins with 0 or 1.");
  }
  if (!isPlausibleAadhaar(digits)) {
    throw badRequest(
      "That number fails its check digit, so it is not a valid Aadhaar number. Check it against " +
        "the card — a single transposed pair is the usual cause."
    );
  }
  const mac = crypto.createHmac("sha256", env.AADHAAR_TOKEN_PEPPER).update(digits).digest("hex");
  return "0x" + mac;
}

/** Last four digits, for display only. Never the full number. */
export function aadhaarLast4(aadhaarNumber: string): string {
  const digits = aadhaarNumber.replace(/[^0-9]/g, "");
  return digits.slice(-4);
}

// Verhoeff tables: dihedral group D5 multiplication, the permutation, and the
// inverse used to derive a check digit.
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function verhoeffChecksum(digits: string): number {
  let c = 0;
  const reversed = digits.split("").reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i]]];
  }
  return c;
}

/**
 * Whether these twelve digits could be an Aadhaar number at all.
 *
 * Three rules, and all three matter:
 *
 *   1. exactly twelve digits
 *   2. the first is 2 to 9. UIDAI never issues a number beginning 0 or 1, which
 *      keeps Aadhaar numbers distinguishable from the older schemes whose
 *      identifiers did.
 *   3. the twelfth digit is the Verhoeff check digit of the first eleven
 *
 * The third is what makes this worth doing. A format check alone accepts
 * 222222222222 and every other invented string of the right shape; the checksum
 * rejects all but one in ten of them, and catches the transposition errors that
 * are the commonest way a number is mistyped from a card.
 *
 * WHAT THIS DOES NOT DO
 *   It cannot tell you the number belongs to a living person, or to the person in
 *   front of you. Only UIDAI's own authentication can, and that needs an AUA
 *   licence. So this is a plausibility test, and everything downstream treats it
 *   as one: the token it produces identifies a claim, not a verified identity.
 */
export function isPlausibleAadhaar(digits: string): boolean {
  if (!/^[2-9][0-9]{11}$/.test(digits)) return false;
  return verhoeffChecksum(digits) === 0;
}

/**
 * The Verhoeff check digit alone, without the first-digit rule.
 *
 * Kept separate from isPlausibleAadhaar because the two answer different
 * questions, and a caller that wants to know only whether the checksum resolves
 * should not have the leading-digit convention applied to it as well.
 */
export function verhoeffValid(digits: string): boolean {
  if (!/^[0-9]{12}$/.test(digits)) return false;
  return verhoeffChecksum(digits) === 0;
}

/**
 * Check digit for an 11 digit prefix. Only the seed script needs this: it
 * produces synthetic Aadhaar numbers that pass the same validation a real one
 * would, so no test path has to bypass the checksum.
 */
export function verhoeffCheckDigit(prefix11: string): string {
  if (!/^[0-9]{11}$/.test(prefix11)) {
    throw new Error("verhoeffCheckDigit expects exactly 11 digits.");
  }
  return String(VERHOEFF_INV[verhoeffChecksum(prefix11 + "0")]);
}

// ---------------------------------------------------------------- AES-256-GCM

export interface EncryptedBlob {
  ciphertext: Buffer;
  iv: string;
  tag: string;
  keyId: string;
}

/**
 * Encrypts an evidence file before it leaves the process. GCM rather than CBC
 * so the auth tag detects a modified ciphertext: an IPFS pin is public, and a
 * pinning service could in principle serve back different bytes.
 */
export function encryptBuffer(plaintext: Buffer): EncryptedBlob {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    keyId: env.EVIDENCE_ENCRYPTION_KEY_ID,
  };
}

export function decryptBuffer(ciphertext: Buffer, iv: string, tag: string): Buffer {
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, encryptionKey, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Encrypts a short string, such as a phone number, into one storable field. */
export function encryptField(value: string): string {
  const blob = encryptBuffer(Buffer.from(value, "utf8"));
  return [blob.keyId, blob.iv, blob.tag, blob.ciphertext.toString("base64")].join(":");
}

export function decryptField(packed: string): string {
  const [, iv, tag, payload] = packed.split(":");
  if (!iv || !tag || payload === undefined) {
    throw new Error("Malformed encrypted field.");
  }
  return decryptBuffer(Buffer.from(payload, "base64"), iv, tag).toString("utf8");
}

// ------------------------------------------------------------------- tokens

/** URL-safe random token for session cookies and CSRF values. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** What goes in the sessions table. The cookie value itself is never stored. */
export function hashSessionToken(token: string): string {
  return "0x" + crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * A temporary password for an invited account.
 *
 * Readable aloud and typable from an email, which matters because somebody will
 * retype it: groups of four, no characters that blur together (no O/0, l/1/I),
 * and an unambiguous separator. Entropy comes from length rather than from
 * punctuation nobody can find on a phone keyboard.
 *
 * 4 groups x 4 chars from a 28-character alphabet is about 77 bits, and it is
 * single-use: the holder must replace it at first sign-in.
 */
export function generateTemporaryPassword(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const groups: string[] = [];

  for (let group = 0; group < 4; group++) {
    let chunk = "";
    for (let i = 0; i < 4; i++) {
      chunk += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    groups.push(chunk);
  }
  return groups.join("-");
}

/** Six digit OTP from a CSPRNG, not Math.random. */
export function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** OTPs are stored as a keyed digest scoped to the challenge they belong to. */
export function hashOtp(otp: string, scope: string): string {
  return (
    "0x" +
    crypto.createHmac("sha256", env.AADHAAR_TOKEN_PEPPER).update(`${scope}|${otp}`).digest("hex")
  );
}

/** Constant-time comparison for anything secret. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Stable digest of an arbitrary object. Keys are sorted so the same logical
 * payload always hashes identically, which is what lets an AI verdict be
 * anchored on-chain and re-derived later.
 */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalise(value));
}

export function canonicalise(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalise(v)}`);
  return `{${entries.join(",")}}`;
}

/** Stable per-device identifier for a summons acknowledgement. */
export function deviceFingerprint(parts: {
  userAgent?: string;
  platform?: string;
  deviceId?: string;
}): string {
  return sha256Hex(
    canonicalise({
      userAgent: parts.userAgent ?? "",
      platform: parts.platform ?? "",
      deviceId: parts.deviceId ?? "",
    })
  );
}
