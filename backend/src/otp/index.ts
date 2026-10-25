import * as crypto from "crypto";
import { env, capabilities } from "../config/env";
import { logger } from "../lib/logger";
import { OtpProvider } from "./OtpProvider";
import { SandboxAadhaarProvider } from "./SandboxAadhaarProvider";
import { UidaiOtpProvider } from "./UidaiOtpProvider";
import { EmailOtpProvider } from "./EmailOtpProvider";

/**
 * Two providers, chosen once at boot, for two different jobs.
 *
 *   otpProvider       citizen actions: acknowledging a summons, filing a bail
 *                     check-in. The assurance needed is "this specific Aadhaar
 *                     holder did this", so the channel is Aadhaar OTP.
 *
 *   loginOtpProvider  the sign-in second factor. The assurance needed is "this
 *                     is really the person who holds this account", so the
 *                     channel is email to the registered address.
 *
 * Keeping them separate is not tidiness. Aadhaar OTP is simulated here because
 * UIDAI access is government-gated; email OTP is genuinely real. Collapsing
 * them into one provider would let a simulated channel stand in for a real one,
 * and /api/health could no longer tell you which assurance you actually have.
 *
 * Nothing above these exports knows which implementation is active.
 */
function buildAadhaarProvider(): OtpProvider {
  if (env.OTP_PROVIDER === "uidai") return new UidaiOtpProvider();
  return new SandboxAadhaarProvider();
}

export const otpProvider: OtpProvider = buildAadhaarProvider();

/** Null when SMTP is not configured, in which case sign-in is password-only. */
export const loginOtpProvider: OtpProvider | null = capabilities.loginOtp
  ? new EmailOtpProvider()
  : null;

/**
 * The subject token for a sign-in challenge.
 *
 * Derived from the user id rather than the email address, because an address
 * can be corrected and a live challenge should survive that. HMAC rather than a
 * plain hash so the token cannot be recomputed by anyone holding only the
 * database, which keeps it in the same class as the Aadhaar tokens it shares a
 * column with.
 */
export function loginSubjectToken(userId: string): string {
  return (
    "0x" +
    crypto.createHmac("sha256", env.AADHAAR_TOKEN_PEPPER).update(`login|${userId}`).digest("hex")
  );
}

if (!otpProvider.isAuthorisedForProduction && env.isProduction) {
  logger.warn(
    "Running in production with the sandbox Aadhaar provider. Citizen identity assertions are NOT Aadhaar-verified."
  );
}

if (!loginOtpProvider) {
  logger.warn(
    env.LOGIN_OTP_ENABLED
      ? "Email sign-in codes are switched on but SMTP is not configured, so sign-in is password-only. Set SMTP_HOST, SMTP_USER and SMTP_PASSWORD."
      : "Email sign-in codes are switched off (LOGIN_OTP_ENABLED=false). Sign-in is password-only."
  );
} else {
  logger.info("Email sign-in codes active", { channel: loginOtpProvider.channel });
}

export * from "./OtpProvider";
