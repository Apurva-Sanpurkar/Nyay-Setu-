import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { db, unwrapMaybe } from "../lib/supabase";
import { hashSessionToken, randomToken } from "../lib/crypto";
import { AppError, forbidden, unauthorised } from "../lib/errors";
import { logger } from "../lib/logger";
import { getAadhaarToken } from "../lib/pii";
import { invitationsReady } from "../lib/schema";

export type UserRole =
  | "police"
  | "forensic_lab"
  | "prosecutor"
  | "judge"
  | "defence_lawyer"
  | "accused"
  | "court_admin";

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  designation: string | null;
  stationOrCourt: string | null;
  theme: "dark" | "light";
  aadhaarToken: string | null;
  /**
   * True while the account still holds the temporary password from its
   * invitation. Every route except changing it refuses to run.
   */
  mustChangePassword: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
      sessionId?: string;
      csrfToken?: string;
    }
  }
}

/**
 * Server-side sessions, not JWTs.
 *
 * The cookie holds an opaque 256 bit random string; the database holds only its
 * SHA-256. That buys two things a signed token cannot: a session can be revoked
 * the instant an officer is suspended, and a stolen database yields no usable
 * sessions. Sign-out is a DELETE, not a client-side forget.
 *
 * Cookie flags: HttpOnly so no script can read it, Secure in production,
 * SameSite=Strict so a cross-site form cannot ride along.
 */

const SESSION_BASE_COLUMNS =
  "id, user_id, csrf_token, expires_at, revoked_at, " +
  "users!inner(id, email, full_name, role, designation, station_or_court, theme, is_active";

/**
 * must_change_password only exists once 006 has been applied, and selecting a
 * column that is not there yet fails the whole session lookup, which would read
 * as "nobody can sign in" with nothing in the response to explain why. So the
 * projection is chosen from what the database actually has.
 */
function sessionSelect(invitations: boolean): string {
  return SESSION_BASE_COLUMNS + (invitations ? ", must_change_password)" : ")");
}

export async function createSession(
  res: Response,
  userId: string,
  meta: { userAgent?: string; ip?: string }
): Promise<{ sessionId: string; csrfToken: string }> {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3600_000);

  const inserted = unwrapMaybe(
    await db
      .from("sessions")
      .insert({
        user_id: userId,
        token_hash: hashSessionToken(token),
        csrf_token: csrfToken,
        user_agent: meta.userAgent?.slice(0, 400) ?? null,
        ip_address: meta.ip ?? null,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .single()
  ) as { id: string } | null;

  if (!inserted) throw unauthorised("Could not open a session.");

  res.cookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: "/",
    expires: expiresAt,
  });

  // The CSRF cookie is deliberately readable by script: the double-submit
  // pattern needs the SPA to copy it into a header. It is not a credential on
  // its own, because the session cookie is HttpOnly and SameSite=Strict.
  res.cookie(env.CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    secure: env.cookieSecure,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: "/",
    expires: expiresAt,
  });

  return { sessionId: inserted.id, csrfToken };
}

export async function destroySession(res: Response, sessionId?: string): Promise<void> {
  if (sessionId) {
    await db
      .from("sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", sessionId);
  }
  const options = {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    path: "/",
  } as const;
  res.clearCookie(env.SESSION_COOKIE_NAME, options);
  res.clearCookie(env.CSRF_COOKIE_NAME, { ...options, httpOnly: false });
}

/**
 * Populates req.user when a valid session cookie is present. Never rejects:
 * requireAuth does that, so public routes can share the same pipeline.
 */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const token = req.cookies?.[env.SESSION_COOKIE_NAME];
    if (!token || typeof token !== "string") return next();

    const invitations = await invitationsReady();

    const row = unwrapMaybe(
      await db
        .from("sessions")
        .select(sessionSelect(invitations))
        .eq("token_hash", hashSessionToken(token))
        .maybeSingle()
    ) as any;

    if (!row) return next();
    if (row.revoked_at) return next();
    if (new Date(row.expires_at).getTime() < Date.now()) return next();

    const user = row.users;
    if (!user || !user.is_active) return next();

    // Sliding activity marker. Not awaited: it must not add latency to a read.
    void db
      .from("sessions")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", row.id)
      .then(() => undefined);

    // The Aadhaar token is needed for relayed actions, so it is loaded once per
    // request rather than per action. It comes through a SECURITY DEFINER
    // function: the schema holding it is not reachable over the API at all.
    let aadhaarToken: string | null = null;
    try {
      aadhaarToken = await getAadhaarToken(user.id);
    } catch (error) {
      // A missing record is normal for staff who never act as a citizen; a
      // failure here must not lock somebody out of an otherwise valid session.
      logger.warn("Could not load the Aadhaar token for this session", {
        userId: user.id,
        error: error instanceof Error ? error.message : error,
      });
    }

    req.user = {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role as UserRole,
      designation: user.designation,
      stationOrCourt: user.station_or_court,
      theme: user.theme,
      aadhaarToken,
      mustChangePassword: Boolean(user.must_change_password),
    };
    req.sessionId = row.id;
    req.csrfToken = row.csrf_token;

    return next();
  } catch (error) {
    logger.warn("Session lookup failed", { error: error instanceof Error ? error.message : error });
    return next();
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(unauthorised());
  return next();
}

/**
 * RBAC gate. Every mutating route names the roles it accepts; there is no
 * "authenticated is good enough" route in this API.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorised());
    if (!roles.includes(req.user.role)) {
      logger.warn("Role check refused a request", {
        path: req.path,
        role: req.user.role,
        needed: roles,
      });
      return next(
        forbidden(
          `This action is limited to: ${roles.join(", ")}. You are signed in as ${req.user.role}.`
        )
      );
    }
    return next();
  };
}

/**
 * Refuses everything until an invited account has replaced its temporary
 * password.
 *
 * Mounted on the feature routers rather than inside each one, because the rule
 * is "nothing until this is settled" and a list of exceptions maintained by hand
 * is a list somebody will forget to add to. /api/auth is deliberately not behind
 * it: that is where the password gets changed.
 *
 * The response carries a code rather than only a message, so the SPA can route
 * to the change-password screen instead of showing a dead end.
 */
export function requirePasswordSettled(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.mustChangePassword) {
    return next(
      new AppError(
        403,
        "PASSWORD_CHANGE_REQUIRED",
        "Choose your own password before going any further. The one you were emailed works once."
      )
    );
  }
  return next();
}

/**
 * Case-level authorisation. Being a judge is not enough; the judge must be
 * assigned to the case. This is the API-side mirror of the RLS policies, and it
 * is what actually runs, because the service key bypasses RLS.
 */
export async function assertCaseAccess(
  req: Request,
  caseId: string,
  need: "read" | "write" = "read"
): Promise<void> {
  if (!req.user) throw unauthorised();

  // The court registry sees every case by design.
  if (req.user.role === "court_admin") return;

  const assignment = unwrapMaybe(
    await db
      .from("case_assignments")
      .select("access")
      .eq("case_id", caseId)
      .eq("user_id", req.user.id)
      .maybeSingle()
  ) as { access: string } | null;

  if (!assignment) {
    throw forbidden("You are not assigned to this case.");
  }
  if (need === "write" && assignment.access !== "write") {
    throw forbidden("You have read-only access to this case.");
  }
}
