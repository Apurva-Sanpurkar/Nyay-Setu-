import rateLimit from "express-rate-limit";
import { Request } from "express";
import { env } from "../config/env";
import { logger } from "../lib/logger";

/**
 * Three tiers. The tight ones sit on the endpoints an attacker would grind:
 * sign in (password guessing) and OTP (code guessing, and SMS cost in a real
 * deployment).
 *
 * Keyed by session id when there is one, so a shared police-station NAT does
 * not lock out a whole thana because one officer typo'd their password.
 */

/**
 * Collapses an IPv6 address to its /64 prefix before it is used as a key.
 *
 * Without this a single host with a routed /64 has 2^64 distinct keys and can
 * walk past any per-IP limit one address at a time. IPv4 is used whole.
 */
function normaliseIp(ip: string | undefined): string {
  if (!ip) return "unknown";
  const address = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (!address.includes(":")) return address;

  const groups = address.split("%")[0].split(":");
  const gapIndex = groups.indexOf("");
  if (gapIndex !== -1) {
    // Expand the "::" shorthand so the first four groups are unambiguous.
    const filled = groups.filter((g) => g !== "");
    const missing = 8 - filled.length;
    groups.splice(
      gapIndex,
      groups.length - gapIndex,
      ...Array(Math.max(0, missing)).fill("0"),
      ...filled.slice(gapIndex)
    );
  }
  return groups.slice(0, 4).join(":") + "::/64";
}

function keyFor(req: Request): string {
  if (req.sessionId) return `s:${req.sessionId}`;
  return `i:${normaliseIp(req.ip)}`;
}

function onLimit(req: Request, label: string) {
  logger.warn("Rate limit tripped", { label, path: req.path, key: keyFor(req) });
}

export const generalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: keyFor,
  handler: (req, res) => {
    onLimit(req, "general");
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many requests. Slow down and retry." },
    });
  },
});

export const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Always by IP: the point is to stop credential stuffing before a session exists.
  keyGenerator: (req) => `a:${normaliseIp(req.ip)}`,
  skipSuccessfulRequests: true,
  handler: (req, res) => {
    onLimit(req, "auth");
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many sign-in attempts from this address. Try again in a minute.",
      },
    });
  },
});

export const otpLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.OTP_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: keyFor,
  handler: (req, res) => {
    onLimit(req, "otp");
    res.status(429).json({
      error: {
        code: "RATE_LIMITED",
        message: "Too many OTP requests. Wait a minute before asking for another code.",
      },
    });
  },
});

/**
 * Mutations that write records or spend gas. Tighter than the general limiter,
 * keyed by session, so one compromised session cannot flood the chain queue.
 */
export const writeLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.WRITE_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `w:${keyFor(req)}`,
  handler: (req, res) => {
    onLimit(req, "write");
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many changes in a short time. Wait a minute and retry." },
    });
  },
});

/**
 * The public verification pages. No session exists, so the key is always the
 * address, and the ceiling is the lowest in the API: these routes read the chain
 * for anyone on the internet, and a scraper must not be able to walk every
 * reference or run the keeper's RPC quota dry.
 */
export const publicLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.PUBLIC_RATE_LIMIT_MAX,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => `p:${normaliseIp(req.ip)}`,
  handler: (req, res) => {
    onLimit(req, "public");
    res.status(429).json({
      error: { code: "RATE_LIMITED", message: "Too many verification requests from this address. Try again in a minute." },
    });
  },
});
