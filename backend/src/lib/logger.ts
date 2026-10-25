import { env } from "../config/env";

/**
 * Minimal structured logger. No dependency, and every message passes through
 * redact(), because the one thing this system must never print is an Aadhaar
 * number, an OTP, a session token or a private key.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
// LOG_LEVEL overrides the default; the test suite sets it to "error" so a run
// prints results rather than every refused request.
const configured = process.env.LOG_LEVEL as Level | undefined;
const threshold =
  configured && configured in LEVELS
    ? LEVELS[configured]
    : env.NODE_ENV === "production"
      ? LEVELS.info
      : LEVELS.debug;

const SECRET_KEYS = new Set([
  "password",
  "passwordhash",
  "password_hash",
  "otp",
  "otpcode",
  "otp_hash",
  "aadhaar",
  "aadhaarnumber",
  "aadhaar_number",
  "token",
  "sessiontoken",
  "session_token",
  "token_hash",
  "csrf",
  "csrftoken",
  "csrf_token",
  "privatekey",
  "private_key",
  "authorization",
  "cookie",
  "servicerolekey",
  "encryptionkey",
]);

// 12 consecutive digits, optionally spaced in groups of four.
const AADHAAR_PATTERN = /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g;

function redactString(value: string): string {
  return value.replace(AADHAAR_PATTERN, "[aadhaar-redacted]");
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Buffer.isBuffer(value)) return `[buffer ${value.length}B]`;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, ""))
        ? "[redacted]"
        : redact(inner, depth + 1);
    }
    return out;
  }
  return "[unserialisable]";
}

function emit(level: Level, message: string, context?: unknown) {
  if (LEVELS[level] < threshold) return;

  const entry: Record<string, unknown> = {
    at: new Date().toISOString(),
    level,
    msg: redactString(message),
  };
  if (context !== undefined) entry.ctx = redact(context);

  const line = env.NODE_ENV === "production"
    ? JSON.stringify(entry)
    : `${entry.at} ${level.toUpperCase().padEnd(5)} ${entry.msg}${
        context !== undefined ? ` ${JSON.stringify(entry.ctx)}` : ""
      }`;

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, context?: unknown) => emit("debug", message, context),
  info: (message: string, context?: unknown) => emit("info", message, context),
  warn: (message: string, context?: unknown) => emit("warn", message, context),
  error: (message: string, context?: unknown) => emit("error", message, context),
};
