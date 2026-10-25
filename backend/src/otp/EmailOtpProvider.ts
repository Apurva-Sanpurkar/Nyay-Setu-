import { env } from "../config/env";
import { db, unwrap } from "../lib/supabase";
import { generateOtp, hashOtp } from "../lib/crypto";
import { logger } from "../lib/logger";
import { badRequest } from "../lib/errors";
import { maskEmail, sendLoginOtp } from "../lib/mailer";
import {
  OtpChannel,
  OtpDispatch,
  OtpProvider,
  SendOtpRequest,
  VerifyOtpRequest,
  VerifyOtpResult,
} from "./OtpProvider";
import { scopeFor, verifyChallenge } from "./SandboxAadhaarProvider";

/**
 * Email OTP, over the deployment's own SMTP server.
 *
 * Used for the sign-in second factor, not for citizen actions. The distinction
 * matters: an emailed code proves control of a mailbox, which is the right
 * assurance for "is this really Inspector Deshpande at her terminal". It is not
 * the right assurance for "did this specific Aadhaar holder acknowledge a
 * summons", which is why the two channels stay separate and a challenge issued
 * on one cannot be verified through the other.
 *
 * Unlike the Aadhaar sandbox, this provider is genuinely real. The code is
 * delivered by a working mail server to an address the operator controls, so
 * `isAuthorisedForProduction` is true: nothing about it is simulated.
 */
export class EmailOtpProvider implements OtpProvider {
  /**
   * Named after what it is, not how it travels.
   *
   * This was "smtp-email", which became a lie the moment the mailer learned to
   * send over an HTTPS API: /api/health reported "smtp-email" while the same
   * response said transport "brevo" two lines above. The channel is email; which
   * wire carries it is the mailer's business and is reported separately.
   */
  readonly name = "email";
  readonly channel: OtpChannel = "email";
  readonly isAuthorisedForProduction = true;

  async sendOtp(request: SendOtpRequest): Promise<OtpDispatch> {
    if (!request.email) {
      throw badRequest("An email address is required for the email OTP channel.");
    }

    const otp = generateOtp();
    const ttlSeconds = env.LOGIN_OTP_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const maskedDestination = maskEmail(request.email);

    // One live challenge per subject and purpose. Pressing "resend" twice must
    // not leave two codes valid at once.
    await db
      .from("otp_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("subject_token", request.subjectToken)
      .eq("purpose", request.purpose)
      .is("consumed_at", null);

    const scope = scopeFor(request.subjectToken, request.purpose, request.referenceId);

    const row = unwrap(
      await db
        .from("otp_challenges")
        .insert({
          purpose: request.purpose,
          channel: this.channel,
          subject_token: request.subjectToken,
          reference_id: request.referenceId ?? null,
          user_id: request.userId ?? null,
          masked_destination: maskedDestination,
          otp_hash: hashOtp(otp, scope),
          max_attempts: env.OTP_MAX_ATTEMPTS,
          expires_at: expiresAt,
        })
        .select("id")
        .single()
    ) as { id: string };

    // The challenge is stored before the send is attempted. If delivery fails,
    // the row still exists and is reported as failed, rather than the user being
    // told to wait for a code that was never queued.
    const delivery = await sendLoginOtp({
      to: request.email,
      userId: request.userId ?? "",
      fullName: request.fullName ?? "there",
      code: otp,
      ttlMinutes: Math.round(ttlSeconds / 60),
      ip: request.requestIp ?? null,
    });

    if (delivery.status !== "sent") {
      logger.error("Login OTP could not be delivered", {
        challengeId: row.id,
        status: delivery.status,
        error: delivery.error,
      });
    }

    return {
      challengeId: row.id,
      expiresAt,
      maskedDestination,
      channel: this.channel,
      deliveryFailed: delivery.status !== "sent",
      deliveryError: delivery.error,
      // Outside production, echo the code when the mail server could not take
      // it. Without this a misconfigured app password locks every account out
      // of a local install with no way back in.
      ...(delivery.status !== "sent" && env.otpEcho ? { otp } : {}),
    };
  }

  async verifyOtp(request: VerifyOtpRequest): Promise<VerifyOtpResult> {
    return verifyChallenge(request, this.channel);
  }
}
