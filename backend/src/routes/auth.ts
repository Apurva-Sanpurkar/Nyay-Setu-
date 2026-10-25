import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { env, capabilities } from "../config/env";
import { db, unwrapMaybe } from "../lib/supabase";
import { badRequest, unauthorised } from "../lib/errors";
import { logger } from "../lib/logger";
import { asyncRoute } from "../middleware/error";
import { validate, otpCode } from "../middleware/validate";
import { authLimiter, otpLimiter } from "../middleware/rateLimit";
import { createSession, destroySession, requireAuth } from "../middleware/auth";
import {
  clearLoginChallengeCookie,
  issueLoginChallengeCookie,
  readLoginChallengeCookie,
} from "../middleware/loginChallenge";
import { loginOtpProvider, loginSubjectToken } from "../otp";
import { invitationsReady } from "../lib/schema";
import { recordAction } from "../services/audit";

const router = Router();

const USER_BASE_SELECT =
  "id, email, password_hash, full_name, role, designation, station_or_court, theme, is_active, " +
  "failed_login_attempts, locked_until, mfa_email_enabled, email_verified_at";

/**
 * The projection, widened only if 006 has been applied.
 *
 * Asking for a column the database does not have fails the entire query, and
 * this query is the sign-in path, so a premature reference here would lock
 * everybody out until somebody thought to read the migration folder.
 */
async function userSelect(): Promise<string> {
  return (await invitationsReady())
    ? USER_BASE_SELECT + ", must_change_password, first_login_at"
    : USER_BASE_SELECT;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string;
  role: string;
  designation: string | null;
  station_or_court: string | null;
  theme: "dark" | "light";
  is_active: boolean;
  failed_login_attempts: number | null;
  locked_until: string | null;
  mfa_email_enabled: boolean | null;
  email_verified_at: string | null;
  // Present only once 006 has been applied; treated as false until then.
  must_change_password?: boolean | null;
  first_login_at?: string | null;
}

function publicUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    designation: user.designation,
    stationOrCourt: user.station_or_court,
    theme: user.theme,
    // The SPA needs this in the sign-in response, not on a later request: the
    // forced password screen has to be the first thing the user sees.
    mustChangePassword: Boolean(user.must_change_password),
  };
}

/* ======================================================= sign in, step 1 === */

const loginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
});

/**
 * Password step.
 *
 * Failure is deliberately uniform: a wrong password and an unknown address
 * return the same message, so the endpoint is not an account enumerator. A dummy
 * bcrypt comparison runs for unknown addresses so the response time does not
 * give the answer away either.
 *
 * On success, one of two things happens:
 *
 *   - email codes are active  -> no session yet. A code is emailed, a signed
 *                                pending-login cookie is set, and the client is
 *                                told to collect the second factor.
 *   - email codes are not     -> a session is created immediately, exactly as
 *                                before. A deployment with no mail server still
 *                                works; it just has one factor.
 */
router.post(
  "/login",
  authLimiter,
  validate(loginSchema),
  asyncRoute(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;

    const user = unwrapMaybe(
      await db.from("users").select(await userSelect()).ilike("email", email).maybeSingle()
    ) as UserRow | null;

    if (!user) {
      // Constant-ish work for an unknown address.
      await bcrypt.compare(password, "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin");
      throw unauthorised("That email address and password do not match.");
    }

    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      const minutes = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
      throw unauthorised(
        `This account is locked for another ${minutes} minute(s) after repeated failures.`
      );
    }

    if (!user.is_active) {
      throw unauthorised("This account has been deactivated. Contact the court administrator.");
    }

    if (!(await bcrypt.compare(password, user.password_hash))) {
      const attempts = (user.failed_login_attempts ?? 0) + 1;
      const shouldLock = attempts >= env.LOGIN_LOCKOUT_ATTEMPTS;

      await db
        .from("users")
        .update({
          failed_login_attempts: attempts,
          locked_until: shouldLock
            ? new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000).toISOString()
            : null,
        })
        .eq("id", user.id);

      logger.warn("Failed sign-in", { userId: user.id, attempts, locked: shouldLock });

      throw unauthorised(
        shouldLock
          ? `Too many failed attempts. This account is locked for ${env.LOGIN_LOCKOUT_MINUTES} minutes.`
          : "That email address and password do not match."
      );
    }

    // The password was right, so the attempt counter resets whichever path follows.
    await db
      .from("users")
      .update({ failed_login_attempts: 0, locked_until: null })
      .eq("id", user.id);

    const needsSecondFactor = Boolean(loginOtpProvider) && user.mfa_email_enabled !== false;

    if (!needsSecondFactor) {
      const { csrfToken } = await createSession(res, user.id, {
        userAgent: req.get("user-agent") ?? undefined,
        ip: req.ip,
      });
      await db.from("users").update({ last_login_at: new Date().toISOString() }).eq("id", user.id);

      req.user = { ...publicUser(user), role: user.role as any, aadhaarToken: null };
      await recordAction(req, {
        action: "auth.login",
        detail: { secondFactor: false, reason: loginOtpProvider ? "user_opted_out" : "smtp_not_configured" },
      });

      return res.json({
        mfaRequired: false,
        user: publicUser(user),
        csrfToken,
        expiresInHours: env.SESSION_TTL_HOURS,
      });
    }

    // Second factor: email a code and hand back only a pending-login cookie.
    const dispatch = await loginOtpProvider!.sendOtp({
      subjectToken: loginSubjectToken(user.id),
      purpose: "login_mfa",
      referenceId: user.id,
      email: user.email,
      userId: user.id,
      fullName: user.full_name,
      requestIp: req.ip ?? null,
    });

    issueLoginChallengeCookie(res, {
      userId: user.id,
      challengeId: dispatch.challengeId,
      ttlSeconds: env.LOGIN_OTP_TTL_SECONDS,
    });

    req.user = { ...publicUser(user), role: user.role as any, aadhaarToken: null };
    await recordAction(req, {
      action: "auth.login_otp_sent",
      detail: { challengeId: dispatch.challengeId, delivered: !dispatch.deliveryFailed },
    });

    if (dispatch.deliveryFailed) {
      logger.error("Sign-in code could not be emailed", {
        userId: user.id,
        error: dispatch.deliveryError,
      });
    }

    return res.json({
      mfaRequired: true,
      challengeId: dispatch.challengeId,
      maskedDestination: dispatch.maskedDestination,
      expiresAt: dispatch.expiresAt,
      // True when the mail server refused the message. The UI must say so
      // rather than leaving the user waiting for a code that is not coming.
      deliveryFailed: Boolean(dispatch.deliveryFailed),
      deliveryError: dispatch.deliveryError,
      // Present only outside production, and only when delivery failed, so a
      // misconfigured app password does not lock you out of a local install.
      ...(dispatch.otp ? { otp: dispatch.otp } : {}),
    });
  })
);

/* ======================================================= sign in, step 2 === */

/**
 * Code step. Needs the emailed code AND the pending-login cookie, so a code
 * alone is not enough and it cannot be redeemed from another browser.
 */
router.post(
  "/login/verify",
  otpLimiter,
  validate(z.object({ otp: otpCode })),
  asyncRoute(async (req, res) => {
    if (!loginOtpProvider) {
      throw badRequest("Email sign-in codes are not enabled on this deployment.");
    }

    const pending = readLoginChallengeCookie(req);

    const verification = await loginOtpProvider.verifyOtp({
      challengeId: pending.challengeId,
      otp: req.body.otp,
      subjectToken: loginSubjectToken(pending.userId),
      purpose: "login_mfa",
      referenceId: pending.userId,
    });

    if (!verification.verified) {
      // Exhausted attempts kill the pending sign-in outright: leaving the cookie
      // alive would invite grinding a fresh code against the same session.
      if (verification.reason === "attempts_exhausted" || verification.reason === "expired") {
        clearLoginChallengeCookie(res);
      }
      throw badRequest(otpFailureMessage(verification.reason), {
        reason: verification.reason,
        attemptsRemaining: verification.attemptsRemaining,
        restart: verification.reason === "attempts_exhausted" || verification.reason === "expired",
      });
    }

    const user = unwrapMaybe(
      await db.from("users").select(await userSelect()).eq("id", pending.userId).maybeSingle()
    ) as UserRow | null;

    // Re-checked after the code, not only before it: an account suspended in the
    // ninety seconds it took to read an email must not get a session.
    if (!user || !user.is_active) {
      clearLoginChallengeCookie(res);
      throw unauthorised("This account is no longer active. Contact the court administrator.");
    }

    clearLoginChallengeCookie(res);

    const { csrfToken } = await createSession(res, user.id, {
      userAgent: req.get("user-agent") ?? undefined,
      ip: req.ip,
    });

    await db
      .from("users")
      .update({
        last_login_at: new Date().toISOString(),
        // A verified code proves control of the mailbox, which is the only
        // moment this can honestly be recorded.
        email_verified_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    req.user = { ...publicUser(user), role: user.role as any, aadhaarToken: null };
    await recordAction(req, { action: "auth.login", detail: { secondFactor: true, channel: "email" } });

    res.json({
      mfaRequired: false,
      user: publicUser(user),
      csrfToken,
      expiresInHours: env.SESSION_TTL_HOURS,
    });
  })
);

/** Resend, bound to the same pending sign-in. */
router.post(
  "/login/resend",
  otpLimiter,
  asyncRoute(async (req, res) => {
    if (!loginOtpProvider) {
      throw badRequest("Email sign-in codes are not enabled on this deployment.");
    }

    const pending = readLoginChallengeCookie(req);

    const user = unwrapMaybe(
      await db.from("users").select(await userSelect()).eq("id", pending.userId).maybeSingle()
    ) as UserRow | null;
    if (!user || !user.is_active) {
      clearLoginChallengeCookie(res);
      throw unauthorised("This account is no longer active.");
    }

    const dispatch = await loginOtpProvider.sendOtp({
      subjectToken: loginSubjectToken(user.id),
      purpose: "login_mfa",
      referenceId: user.id,
      email: user.email,
      userId: user.id,
      fullName: user.full_name,
      requestIp: req.ip ?? null,
    });

    // The old challenge was consumed when the new one was issued, so the cookie
    // has to point at the new id or verification would fail on scope.
    issueLoginChallengeCookie(res, {
      userId: user.id,
      challengeId: dispatch.challengeId,
      ttlSeconds: env.LOGIN_OTP_TTL_SECONDS,
    });

    res.json({
      challengeId: dispatch.challengeId,
      maskedDestination: dispatch.maskedDestination,
      expiresAt: dispatch.expiresAt,
      deliveryFailed: Boolean(dispatch.deliveryFailed),
      deliveryError: dispatch.deliveryError,
      ...(dispatch.otp ? { otp: dispatch.otp } : {}),
    });
  })
);

/** Abandon a half-finished sign-in, so the UI can offer a clean "start again". */
router.post("/login/cancel", (req, res) => {
  clearLoginChallengeCookie(res);
  res.json({ ok: true });
});

/* ============================================================== session === */

router.post(
  "/logout",
  asyncRoute(async (req, res) => {
    if (req.user) await recordAction(req, { action: "auth.logout" });
    clearLoginChallengeCookie(res);
    await destroySession(res, req.sessionId);
    res.json({ ok: true });
  })
);

/** Who am I. The SPA calls this on boot to restore a session. */
router.get(
  "/me",
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = req.user!;
    res.json({
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        designation: user.designation,
        stationOrCourt: user.stationOrCourt,
        theme: user.theme,
        hasAadhaarToken: Boolean(user.aadhaarToken),
        mustChangePassword: user.mustChangePassword,
      },
      csrfToken: req.csrfToken,
    });
  })
);

/** Theme is a server-side preference, so it follows the user across devices. */
router.patch(
  "/me/theme",
  requireAuth,
  validate(z.object({ theme: z.enum(["dark", "light"]) })),
  asyncRoute(async (req, res) => {
    await db.from("users").update({ theme: req.body.theme }).eq("id", req.user!.id);
    res.json({ theme: req.body.theme });
  })
);

router.post(
  "/change-password",
  requireAuth,
  authLimiter,
  validate(
    z.object({
      currentPassword: z.string().min(8).max(200),
      newPassword: z
        .string()
        .min(12, "Use at least 12 characters.")
        .max(200)
        .regex(/[a-z]/, "Include a lowercase letter.")
        .regex(/[A-Z]/, "Include an uppercase letter.")
        .regex(/[0-9]/, "Include a digit."),
    })
  ),
  asyncRoute(async (req, res) => {
    const row = unwrapMaybe(
      await db.from("users").select("password_hash").eq("id", req.user!.id).maybeSingle()
    ) as { password_hash: string } | null;
    if (!row) throw unauthorised();

    if (!(await bcrypt.compare(req.body.currentPassword, row.password_hash))) {
      throw badRequest("Your current password is not correct.");
    }

    // Refusing to let the temporary password be re-set as the permanent one.
    // Without this the forced change is theatre: paste it twice and nothing has
    // actually changed, while the flag says it has.
    if (req.body.newPassword === req.body.currentPassword) {
      throw badRequest("Choose a password different from the one you have now.");
    }

    const hash = await bcrypt.hash(req.body.newPassword, 12);

    const settled: Record<string, unknown> = { password_hash: hash };
    if (await invitationsReady()) {
      // This is the moment an invitation is spent.
      settled.must_change_password = false;
      settled.first_login_at = new Date().toISOString();
    }

    await db.from("users").update(settled).eq("id", req.user!.id);

    // A password change invalidates every other session for this user.
    await db
      .from("sessions")
      .update({ revoked_at: new Date().toISOString() })
      .eq("user_id", req.user!.id)
      .neq("id", req.sessionId ?? "")
      .is("revoked_at", null);

    await recordAction(req, { action: "auth.change_password" });
    res.json({ ok: true, otherSessionsRevoked: true });
  })
);

/**
 * What the sign-in screen needs to know before it draws itself: whether a
 * second factor is coming.
 *
 * There is deliberately nothing here about demo accounts. There are none. Every
 * account is created by a court administrator from /admin, so the sign-in screen
 * has no credentials to offer and no list of addresses to leak.
 */
router.get("/config", (_req, res) => {
  res.json({
    emailOtpEnabled: Boolean(loginOtpProvider),
    // Named "smtpConfigured" for the clients already reading it; what it now means
    // is "there is some way to send email", which is the question the sign-in
    // screen is actually asking.
    smtpConfigured: Boolean(capabilities.emailTransport),
    emailTransport: capabilities.emailTransport,
    aadhaarProvider: capabilities.otpProvider,
    aadhaarSimulated: capabilities.otpProvider === "sandbox",
    environment: env.NODE_ENV,
  });
});

/** Reference data for the sign-in screen and role badges. */
router.get(
  "/roles",
  asyncRoute(async (_req, res) => {
    const { data } = await db
      .from("roles")
      .select("role, label, description, portal_path")
      .order("role");
    res.json({ roles: data ?? [] });
  })
);

function otpFailureMessage(reason?: string): string {
  switch (reason) {
    case "expired":
      return "That code has expired. Enter your password again to get a new one.";
    case "consumed":
      return "That code has already been used.";
    case "attempts_exhausted":
      return "Too many wrong codes. Enter your password again to start over.";
    case "scope_mismatch":
      return "That code was issued for a different sign-in.";
    case "not_found":
      return "That code is no longer valid. Enter your password again.";
    default:
      return "That code is not correct.";
  }
}

export default router;
