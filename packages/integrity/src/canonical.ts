/**
 * Canonical JSON: one byte sequence for one logical value, on every platform.
 *
 * Rules, all enforced rather than hoped for:
 *
 *   1. Object keys are sorted by UTF-16 code unit order (what `<` does on
 *      strings in every JavaScript engine), at every depth.
 *   2. No whitespace.
 *   3. Numbers must be safe integers. A float has more than one decimal spelling
 *      ("0.1" vs "0.10000000000000001") and engines are not required to agree on
 *      the shortest one for every value, so floats are refused outright. Coordinates
 *      are integer micro-degrees, accuracy is integer centimetres, times are
 *      integer milliseconds — the same integer encoding GeoMath.sol uses on chain.
 *   4. Object members whose value is `undefined` are omitted, as JSON.stringify
 *      does. `undefined` inside an array is refused, because JSON.stringify would
 *      silently turn it into `null` and that is a change of meaning.
 *   5. Strings are escaped exactly as JSON.stringify escapes them.
 *
 * Anything else — a Date, a Map, a class instance, a bigint, NaN — is refused
 * with the path to the offending value, so a bug surfaces at capture time on the
 * officer's device rather than as a hash mismatch in court.
 */

export class CanonicalError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || "<root>"}`);
    this.name = "CanonicalError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalError(
          `Only safe integers are allowed (got ${String(value)}); encode fractions as scaled integers`,
          path
        );
      }
      // -0 and 0 must not differ.
      return value === 0 ? "0" : String(value);
    case "object":
      break;
    default:
      throw new CanonicalError(`Unsupported type ${typeof value}`, path);
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (value[i] === undefined) throw new CanonicalError("undefined inside an array", `${path}[${i}]`);
      parts.push(encode(value[i], `${path}[${i}]`));
    }
    return `[${parts.join(",")}]`;
  }

  if (!isPlainObject(value)) {
    throw new CanonicalError("Only plain objects, arrays and primitives are allowed", path);
  }

  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const parts = keys.map((key) => `${JSON.stringify(key)}:${encode(value[key], path ? `${path}.${key}` : key)}`);
  return `{${parts.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return encode(value, "");
}

/**
 * Degrees to integer micro-degrees, the unit GeoMath.sol and the backend use.
 * Math.round, not truncation, so 18.5308005 and 18.5307995 both land on 18530800
 * rather than one of them drifting by a micro-degree depending on the platform.
 */
export function toMicroDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) throw new Error("Coordinate must be a finite number.");
  return Math.round(degrees * 1_000_000);
}

export function fromMicroDegrees(micro: number): number {
  return micro / 1_000_000;
}

/** Metres (possibly fractional) to integer centimetres. */
export function toCentimetres(metres: number): number {
  if (!Number.isFinite(metres)) throw new Error("Distance must be a finite number.");
  return Math.round(metres * 100);
}
