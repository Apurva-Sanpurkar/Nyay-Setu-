import { env, capabilities } from "./env";
import { logger } from "../lib/logger";

/**
 * What is not production-grade about this instance, named out loud at boot.
 *
 * Every one of these is a deliberate, documented fallback that keeps a partly
 * configured clone runnable — a blank Pinata key writes blobs to disk, a blank
 * chain URL makes anchored actions answer 503, the sandbox provider simulates
 * Aadhaar OTP. That is the right behaviour for a demo and the wrong behaviour to
 * discover in production, so the difference between the two is stated rather than
 * left for somebody to notice.
 *
 * It warns; it does not refuse to start. A deployment that is 80% configured
 * should come up and tell you which 20% is missing, because refusing to boot
 * gives you a health check that never answers and no explanation at all.
 */

export interface PostureFinding {
  key: string;
  what: string;
  why: string;
}

export function productionFindings(): PostureFinding[] {
  const findings: PostureFinding[] = [];

  if (!capabilities.chain) {
    findings.push({
      key: "chain",
      what: "No chain is configured.",
      why: "Every anchored action answers 503 instead of being recorded. Nothing is silently accepted, but nothing is anchored either.",
    });
  } else if (env.CHAIN_NETWORK === "localhost") {
    findings.push({
      key: "chain.network",
      what: "CHAIN_NETWORK is localhost.",
      why: "A local chain has no independent observers, so an anchor on it proves nothing to anyone else. Deploy to Sepolia or a permissioned chain.",
    });
  }

  if (!capabilities.ipfs) {
    findings.push({
      key: "storage",
      what: `Encrypted blobs are being written to ${env.LOCAL_BLOB_DIR}.`,
      why: "A container filesystem is not durable. Losing it loses the files, while their on-chain digests remain — which is the worst of both.",
    });
  }

  if (!capabilities.ai) {
    findings.push({
      key: "ai",
      what: "The model service is not configured.",
      why: "Screening and risk scoring report themselves unavailable. That is honest, but nothing is being screened.",
    });
  }

  if (!capabilities.emailTransport) {
    findings.push({
      key: "email",
      what: "No way to send email is configured.",
      why: "Sign-in falls back to one factor, invitations cannot be delivered, and a summons recipient is never notified.",
    });
  } else {
    if (capabilities.emailTransport === "smtp" && env.isProduction) {
      findings.push({
        key: "email.smtp",
        what: "Sending over SMTP on a hosted instance.",
        why:
          "Most container hosts block outbound port 587 silently, which surfaces as a connection " +
          "timeout and reads like a wrong password. If mail is not arriving, set BREVO_API_KEY or " +
          "RESEND_API_KEY and it will go over HTTPS instead.",
      });
    }
    if (!capabilities.loginOtp) {
      findings.push({
        key: "mfa",
        what: "LOGIN_OTP_ENABLED is false while email works.",
        why: "Sign-in is a password alone. The second factor exists and has been switched off.",
      });
    }
  }

  if (capabilities.otpProvider === "sandbox") {
    findings.push({
      key: "identity",
      what: "Aadhaar OTP is simulated by the sandbox provider.",
      why: "A summons acknowledgement is not proof of identity on this instance. The real integration needs a UIDAI AUA licence; see src/otp/UidaiOtpProvider.ts.",
    });
  }

  if (env.COOKIE_SAMESITE === "none" && !env.cookieSecure) {
    findings.push({
      key: "cookies",
      what: "COOKIE_SAMESITE=none without Secure.",
      why: "Browsers reject that combination outright, so no session cookie will be stored at all.",
    });
  }

  if (env.corsOrigins.some((origin) => origin.startsWith("http://"))) {
    findings.push({
      key: "cors",
      what: "CORS_ORIGINS contains a plain-HTTP origin.",
      why: "A session cookie sent over HTTP is readable in transit. Every origin should be HTTPS in production.",
    });
  }

  if (!env.LOGIN_CHALLENGE_SECRET) {
    findings.push({
      key: "secrets",
      what: "LOGIN_CHALLENGE_SECRET is unset, so the Aadhaar pepper signs pending sign-ins too.",
      why: "One secret doing two jobs means rotating either forces rotating both, and the pepper can never be rotated.",
    });
  }

  return findings;
}

/** Logs the findings once, at boot. Loud in production, informational otherwise. */
export function reportPosture(): void {
  const findings = productionFindings();
  if (findings.length === 0) {
    logger.info("Production posture: fully configured");
    return;
  }

  if (!env.isProduction) {
    logger.info("Development fallbacks in use", { count: findings.length, keys: findings.map((f) => f.key) });
    return;
  }

  logger.warn(
    `NODE_ENV=production with ${findings.length} fallback(s) still in use. ` +
      "Each is safe by design but none is production-grade; see docs/production.md.",
    { keys: findings.map((f) => f.key) }
  );
  for (const finding of findings) {
    logger.warn(`  ${finding.key}: ${finding.what}`, { why: finding.why });
  }
}
