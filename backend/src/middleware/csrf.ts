import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { safeEqual } from "../lib/crypto";
import { AppError } from "../lib/errors";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Double-submit CSRF protection.
 *
 * The session cookie is SameSite=Strict, which already blocks the classic
 * cross-site POST. This is the second layer, for the cases SameSite does not
 * cover: a same-site subdomain takeover, or a deployment forced onto
 * SameSite=none because the API and the SPA are on different hosts.
 *
 * The check compares the X-CSRF-Token header against the token bound to the
 * session row, not merely against the cookie. A subdomain that can set cookies
 * therefore still cannot forge a request, which is the flaw in comparing
 * cookie-to-header alone.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Unauthenticated POSTs (sign in, OTP request) have no session to forge
  // against; the rate limiter is their protection.
  if (!req.user || !req.csrfToken) return next();

  const header = req.get("x-csrf-token");
  if (!header) {
    return next(
      new AppError(
        403,
        "CSRF_MISSING",
        "This request needs an X-CSRF-Token header. Take it from the csrfToken field of " +
          "GET /api/auth/me, not from the cookie: when the site and the API are on different " +
          "domains, script on the site cannot read a cookie set by the API."
      )
    );
  }

  if (!safeEqual(header, req.csrfToken)) {
    return next(new AppError(403, "CSRF_INVALID", "The CSRF token does not match this session."));
  }

  const cookieToken = req.cookies?.[env.CSRF_COOKIE_NAME];
  if (typeof cookieToken === "string" && !safeEqual(cookieToken, req.csrfToken)) {
    return next(new AppError(403, "CSRF_STALE", "Your CSRF cookie is stale. Reload and retry."));
  }

  return next();
}
