import { env } from "../config/env";
import { AppError, unavailable } from "../lib/errors";
import { logger } from "../lib/logger";
import {
  OtpChannel,
  OtpDispatch,
  OtpProvider,
  SendOtpRequest,
  VerifyOtpRequest,
  VerifyOtpResult,
} from "./OtpProvider";

/**
 * ===========================================================================
 * THE REAL UIDAI INTEGRATION SEAM
 * ===========================================================================
 *
 * This class is where an authorised deployment plugs in. It is complete as far
 * as a deployment without a UIDAI licence can legally take it, and it deliberately refuses to
 * fake the part it cannot do.
 *
 * WHAT IS MISSING AND WHY
 * -----------------------
 * The Aadhaar OTP API is not open. Reaching it requires:
 *
 *   1. AUA (Authentication User Agency) or Sub-AUA registration with UIDAI,
 *      granted under the Aadhaar (Authentication) Regulations 2016.
 *   2. An ASA (Authentication Service Agency) to carry the request, because an
 *      AUA never connects to CIDR directly.
 *   3. A UIDAI-issued licence key and an AUA code.
 *   4. A digital signature certificate: every Auth XML must be signed, and the
 *      PID block must be encrypted with the UIDAI public certificate.
 *   5. An audited deployment. UIDAI mandates the ASA link, log retention rules
 *      and a security audit before production traffic is allowed.
 *
 * None of that is held by this deployment, and UIDAI does not issue
 * a public sandbox that returns real OTPs. Inventing credentials here would be
 * a security theatre: it would look integrated and authenticate nobody.
 *
 * WHAT THIS CLASS DOES
 * --------------------
 * It encodes the real protocol shape so an authorised operator can finish it:
 *   - POST {UIDAI_BASE_URL}/otp/2.5/{ac}/{uid0}/{uid1}/{licence}
 *       body: signed Otp XML, txn correlator, channel = 00 (SMS + email)
 *   - POST {UIDAI_BASE_URL}/auth/2.5/{ac}/{uid0}/{uid1}/{licence}
 *       body: signed Auth XML wrapping an encrypted PID block with the OTP
 *
 * It refuses to start without credentials rather than degrading to a stub,
 * because an OTP provider that silently succeeds is worse than one that is
 * plainly absent.
 *
 * TO ACTIVATE (authorised deployments only)
 * -----------------------------------------
 *   1. Set OTP_PROVIDER=uidai plus UIDAI_BASE_URL, UIDAI_CLIENT_ID,
 *      UIDAI_CLIENT_SECRET and UIDAI_AUA_CODE.
 *   2. Mount the signing certificate and the UIDAI public certificate, and fill
 *      in buildSignedOtpXml / buildSignedAuthXml below.
 *   3. Keep NyaySetu's own rule: the Aadhaar number is used to build the
 *      request and then discarded. Only the token is persisted. The
 *      aadhaarNumber field on these requests exists because UIDAI needs it in
 *      the URL path; it must never be written to a database or a log.
 */
export class UidaiOtpProvider implements OtpProvider {
  readonly name = "uidai";
  readonly channel: OtpChannel = "aadhaar";
  readonly isAuthorisedForProduction = true;

  constructor() {
    const missing = [
      ["UIDAI_BASE_URL", env.UIDAI_BASE_URL],
      ["UIDAI_CLIENT_ID", env.UIDAI_CLIENT_ID],
      ["UIDAI_CLIENT_SECRET", env.UIDAI_CLIENT_SECRET],
      ["UIDAI_AUA_CODE", env.UIDAI_AUA_CODE],
    ]
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new AppError(
        500,
        "OTP_PROVIDER_MISCONFIGURED",
        `OTP_PROVIDER=uidai was selected but these are unset: ${missing.join(", ")}. ` +
          "Set OTP_PROVIDER=sandbox for a demo deployment."
      );
    }

    logger.warn(
      "UIDAI OTP provider selected. This requires a valid AUA licence; requests will fail without one."
    );
  }

  async sendOtp(_request: SendOtpRequest): Promise<OtpDispatch> {
    // The Aadhaar number is not available at this layer by design: only its
    // token is. A real AUA integration receives the number from the citizen at
    // request time, signs the Auth XML with it, and discards it. Wiring that
    // needs the HSM-held signing key, so the call is left unimplemented rather
    // than stubbed.
    throw unavailable(
      "Live UIDAI OTP dispatch is not implemented: it needs an AUA licence key, an ASA route " +
        "and the signing certificate described in UidaiOtpProvider. See docs/design-decisions.md."
    );

    /* Reference implementation, for an authorised operator:
     *
     * const txn = `NYAYSETU-${randomToken(8)}`;
     * const xml = buildSignedOtpXml({
     *   uid: aadhaarNumber,          // from the request, never persisted
     *   ac: env.UIDAI_AUA_CODE!,
     *   sa: env.UIDAI_AUA_CODE!,
     *   lk: env.UIDAI_CLIENT_SECRET!,
     *   txn,
     *   ch: "00",                    // 00 = SMS and email
     * });
     *
     * const uid = aadhaarNumber;
     * const url = `${env.UIDAI_BASE_URL}/otp/2.5/${env.UIDAI_AUA_CODE}/${uid[0]}/${uid[1]}/${env.UIDAI_CLIENT_SECRET}`;
     * const response = await fetch(url, {
     *   method: "POST",
     *   headers: { "content-type": "application/xml" },
     *   body: xml,
     * });
     * const parsed = parseUidaiOtpResponse(await response.text());
     * if (parsed.ret !== "y") throw badRequest(uidaiErrorMessage(parsed.err));
     *
     * // txn must be stored against the challenge: the Auth call has to echo it.
     * return { challengeId: txn, expiresAt, maskedDestination: parsed.maskedMobile };
     */
  }

  async verifyOtp(_request: VerifyOtpRequest): Promise<VerifyOtpResult> {
    throw unavailable(
      "Live UIDAI OTP verification is not implemented: it needs the encrypted PID block and the " +
        "digital signature described in UidaiOtpProvider. See docs/design-decisions.md."
    );

    /* Reference implementation:
     *
     * const pid = buildPidBlock({ otp: request.otp, ts: new Date().toISOString() });
     * const encrypted = encryptPidWithUidaiCertificate(pid);   // AES-256 session key, RSA-wrapped
     * const xml = buildSignedAuthXml({ uid, ac, sa, lk, txn: request.challengeId, data: encrypted });
     * const response = await fetch(`${env.UIDAI_BASE_URL}/auth/2.5/...`, { method: "POST", body: xml });
     * const parsed = parseUidaiAuthResponse(await response.text());
     * return { verified: parsed.ret === "y", reason: parsed.ret === "y" ? undefined : "mismatch" };
     */
  }
}
