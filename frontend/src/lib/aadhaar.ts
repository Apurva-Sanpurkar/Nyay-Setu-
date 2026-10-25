/**
 * Aadhaar validation, in the browser.
 *
 * The same three rules the API enforces, run as the officer types so a mistyped
 * digit is caught at the field rather than after a round trip. The API remains the
 * authority — this cannot be trusted, because anything in a browser can be
 * bypassed — but a form that only tells you on submit is a form people fight.
 *
 * WHY THE TABLES ARE DUPLICATED FROM THE BACKEND
 *   They are the published Verhoeff tables, not project logic: a dihedral group's
 *   multiplication table does not change, and nothing about this file will drift
 *   from the server as requirements move. Sharing them would mean a build step to
 *   cross a package boundary for eighty constant numbers.
 *
 * WHAT IT CANNOT DO
 *   Confirm the number belongs to anyone. Only UIDAI's authentication can, and that
 *   needs an AUA licence. A number passing this is plausible, not verified, and no
 *   part of the interface should say otherwise.
 */

// Dihedral group D5 multiplication, the permutation table, and the inverse.
const D = [
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

const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function checksum(digits: string): number {
  let c = 0;
  const reversed = digits.split("").reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = D[c][P[i % 8][reversed[i]]];
  }
  return c;
}

/** Just the digits, so spaces and hyphens from a card can be typed freely. */
export function aadhaarDigits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

/** "2665 8452 7491" — grouped as printed, for display in a field. */
export function formatAadhaar(value: string): string {
  const digits = aadhaarDigits(value).slice(0, 12);
  return digits.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
}

export type AadhaarVerdict =
  | { state: "empty" }
  | { state: "incomplete"; entered: number; problem: string }
  | { state: "invalid"; problem: string }
  | { state: "valid"; digits: string; masked: string };

/**
 * What to tell the person at the field, right now.
 *
 * "incomplete" is separated from "invalid" on purpose: a half-typed number is not
 * a mistake and should not be scolded as one. Only a number that is finished and
 * wrong gets an error.
 */
export function checkAadhaar(value: string): AadhaarVerdict {
  const digits = aadhaarDigits(value);

  if (digits.length === 0) return { state: "empty" };

  if (/^[01]/.test(digits)) {
    return { state: "invalid", problem: "An Aadhaar number never begins with 0 or 1." };
  }

  if (digits.length < 12) {
    return {
      state: "incomplete",
      entered: digits.length,
      problem: `${12 - digits.length} more digit${digits.length === 11 ? "" : "s"}`,
    };
  }

  if (digits.length > 12) {
    return { state: "invalid", problem: "An Aadhaar number is exactly 12 digits." };
  }

  if (checksum(digits) !== 0) {
    return {
      state: "invalid",
      problem: "The check digit does not match. A transposed pair is the usual cause.",
    };
  }

  return {
    state: "valid",
    digits,
    // What will be stored and shown from here on: the last four, never the rest.
    masked: `•••• •••• ${digits.slice(8)}`,
  };
}
