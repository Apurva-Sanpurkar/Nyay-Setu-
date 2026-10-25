import * as crypto from "crypto";
import { Request, Response } from "express";
import { env } from "../config/env";
import { safeEqual } from "../lib/crypto";
import { unauthorised } from "../lib/errors";

/**
 * Carries a half-finished sign-in between the password step and the code step.
 *
 * WHY A COOKIE AND NOT JUST THE CHALLENGE ID
 * ------------------------------------------
 * The obvious design is to hand the client a challenge id and accept it back
 * with the code. That works, but it means a challenge id plus a code is
 * sufficient to mint a session from anywhere. Since the code arrives by email,
 * anyone who can read the mailbox and guess or observe the id is in.
 *
 * Binding the pending sign-in to a short-lived HttpOnly cookie closes that:
 * the verify step needs the cookie too, so it must come from the same browser
 * that supplied the correct password. The cookie is signed with HMAC and
 * carries its own expiry, so it cannot be edited to name a different user or
 * replayed after the window closes.
 *
 * It is not a session. It grants nothing on its own, and it is cleared the
 * moment verification succeeds or fails terminally.
 */

const COOKIE = "nyaysetu_pending_login";

interface Payload {
  userId: string;
  challengeId: string;
  expiresAt: number;
}

function sign(value: string): string {
  return crypto.createHmac("sha256", env.loginChallengeSecret).update(value).digest("base64url");
}

export function issueLoginChallengeCookie(
  res: Response,
  payload: { userId: string; challengeId: string; ttlSeconds: number }
): void {
  const body: Payload = {
    userId: payload.userId,
    challengeId: payload.challengeId,
    expiresAt: Date.now() + payload.ttlSeconds * 1000,
  };

  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const token = `${encoded}.${sign(encoded)}`;

  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: "/",
    // A little longer than the code itself, so an expired code produces "that
    // code expired" rather than the more confusing "start again".
    maxAge: (payload.ttlSeconds + 120) * 1000,
  });
}

export function clearLoginChallengeCookie(res: Response): void {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: "/",
  });
}

/**
 * Reads and validates the pending sign-in. Throws rather than returning null,
 * because every caller treats absence as a failure to authenticate.
 */
export function readLoginChallengeCookie(req: Request): Payload {
  const raw = req.cookies?.[COOKIE];
  if (!raw || typeof raw !== "string") {
    throw unauthorised("Your sign-in attempt has expired. Enter your password again.");
  }

  const [encoded, signature] = raw.split(".");
  if (!encoded || !signature) {
    throw unauthorised("Your sign-in attempt is not valid. Enter your password again.");
  }

  // Constant-time, so the check does not leak the expected signature by timing.
  if (!safeEqual(signature, sign(encoded))) {
    throw unauthorised("Your sign-in attempt is not valid. Enter your password again.");
  }

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Payload;
  } catch {
    throw unauthorised("Your sign-in attempt is not valid. Enter your password again.");
  }

  if (!payload.userId || !payload.challengeId || typeof payload.expiresAt !== "number") {
    throw unauthorised("Your sign-in attempt is not valid. Enter your password again.");
  }
  if (payload.expiresAt < Date.now()) {
    throw unauthorised("Your sign-in attempt has expired. Enter your password again.");
  }

  return payload;
}
