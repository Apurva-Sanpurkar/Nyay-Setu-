/**
 * The Aadhaar OTP seam.
 *
 * ----------------------------------------------------------------------------
 * READ THIS BEFORE SWAPPING IN A REAL PROVIDER
 *
 * Authenticating against the live UIDAI Aadhaar OTP API requires being a
 * licensed AUA/KUA. That licence is granted by UIDAI to government departments
 * and to entities they authorise, under the Aadhaar Act 2016 and the
 * Authentication Regulations. This deployment does not hold it, and there is
 * no sandbox that issues real OTPs to real Aadhaar holders.
 *
 * NyaySetu therefore ships two implementations of one interface:
 *
 *   SandboxAadhaarProvider  generates and verifies OTPs locally, with the same
 *                           lifecycle the real API has: a 6 digit code, a
 *                           short TTL, a capped attempt count, single use.
 *                           This is what the demo runs on.
 *
 *   UidaiOtpProvider        the real integration. The request and response
 *                           shapes, the endpoints and the licence checks are
 *                           written out. It refuses to run without credentials
 *                           rather than pretending to work.
 *
 * Nothing above this interface knows which one is active. Swapping providers is
 * an environment variable, not a code change, and that is the point: the
 * dependency on government authorisation is isolated to one file.
 * ----------------------------------------------------------------------------
 */

export type OtpPurpose = "login" | "login_mfa" | "summons_ack" | "bail_checkin";

/**
 * Which route the code travelled. Recorded so a challenge issued to an email
 * address can never be verified as though it had gone to a registered mobile.
 */
export type OtpChannel = "aadhaar" | "email" | "sms";

export interface SendOtpRequest {
  /**
   * Whoever the challenge is about.
   *
   * A salted Aadhaar token for a citizen action, or an HMAC of the user id for
   * a sign-in. Deliberately not called aadhaarToken: the email channel
   * authenticates a user account, not an Aadhaar holder, and a column or a
   * parameter that lies about what it holds is how the two get confused.
   */
  subjectToken: string;
  purpose: OtpPurpose;
  /** Summons id, case id, user id: whatever the OTP is about. Binds the code to one action. */
  referenceId?: string | null;
  /** Masked phone or address, for the "code sent to a•••••a@gmail.com" line. */
  destinationHint?: string | null;
  /** Needed by the email channel. Never logged in full. */
  email?: string | null;
  userId?: string | null;
  fullName?: string | null;
  /** Shown in the email so a recipient can spot a sign-in they did not start. */
  requestIp?: string | null;
}

export interface OtpDispatch {
  challengeId: string;
  expiresAt: string;
  maskedDestination: string;
  channel?: OtpChannel;
  /**
   * Set when the channel accepted the code but could not deliver it: a wrong
   * app password, a bounced address. The caller must treat this as a failure to
   * authenticate, not as a code the user simply has not typed yet.
   */
  deliveryFailed?: boolean;
  deliveryError?: string;
  /**
   * Present only for the sandbox provider, and only when
   * OTP_ECHO_IN_RESPONSE is on and NODE_ENV is not production. It is what lets
   * the demo run without an SMS gateway.
   */
  otp?: string;
}

export interface VerifyOtpRequest {
  challengeId: string;
  otp: string;
  subjectToken: string;
  purpose: OtpPurpose;
  referenceId?: string | null;
}

export interface VerifyOtpResult {
  verified: boolean;
  /** Machine-readable failure cause, for the UI and the rate limiter. */
  reason?: "expired" | "consumed" | "attempts_exhausted" | "mismatch" | "not_found" | "scope_mismatch";
  attemptsRemaining?: number;
}

export interface OtpProvider {
  readonly name: string;
  readonly channel: OtpChannel;
  /**
   * False for the sandbox. The health endpoint surfaces this so nobody can
   * mistake a demo deployment for an authenticated one.
   */
  readonly isAuthorisedForProduction: boolean;

  sendOtp(request: SendOtpRequest): Promise<OtpDispatch>;
  verifyOtp(request: VerifyOtpRequest): Promise<VerifyOtpResult>;
}
