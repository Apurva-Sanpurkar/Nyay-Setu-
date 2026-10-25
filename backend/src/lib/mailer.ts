import * as fs from "fs";
import * as path from "path";
import nodemailer, { type Transporter } from "nodemailer";
import { env, capabilities } from "../config/env";
import { httpProvider, sendOverHttp, verifyHttpProvider } from "./mail/httpTransport";
import { logger } from "./logger";
import { db } from "./supabase";
import {
  BRAND,
  LOGO_CID,
  button,
  callout,
  codePanel,
  credentialRow,
  escapeHtml,
  paragraph,
  shell,
  steps,
  strong,
} from "./emailTemplates";

/**
 * Outbound email over SMTP.
 *
 * Three things this module is careful about:
 *
 * 1. **It never logs an address or a code.** `email_log` records a masked
 *    recipient and a status, so "I never received the code" is answerable
 *    without the log becoming a directory of who is on bail.
 *
 * 2. **It degrades rather than failing.** If SMTP is not configured, sending
 *    returns `skipped` and the caller decides what that means. Login MFA treats
 *    it as "MFA unavailable, fall through to password-only"; a summons
 *    notification treats it as "nothing to do". Neither crashes.
 *
 * 3. **It verifies the connection once, lazily.** A wrong app password is the
 *    most common misconfiguration here, and finding out on the first real OTP is
 *    worse than finding out at boot.
 */

export interface SendResult {
  status: "sent" | "failed" | "skipped";
  messageId?: string;
  error?: string;
}

let transporter: Transporter | null = null;
let verified: boolean | null = null;

/**
 * The last verification result, and when it was taken.
 *
 * This cache is not an optimisation. /api/health reports the mailer, and a
 * platform health check calls /api/health every few seconds, so an uncached
 * verify meant a fresh SMTP handshake against Gmail roughly six times a minute,
 * for as long as the service was up. Repeated failed authentications at that rate
 * are how an account gets locked, so the failure is remembered too, not just the
 * success.
 *
 * A failure is held for a minute rather than forever, because the usual cause is
 * a wrong environment variable and somebody is probably fixing it right now.
 */
let verifyCache: { ok: boolean; error?: string; at: number } | null = null;
const VERIFY_TTL_OK_MS = 10 * 60_000;
const VERIFY_TTL_FAIL_MS = 60_000;

/**
 * The logo, attached inline rather than hotlinked.
 *
 * Most clients block remote images by default, and the project has no public
 * host to serve one from anyway. An inline attachment referenced by Content-ID
 * renders on first open, offline, with no "show images" prompt.
 *
 * Read once at module load: it is 8 KB and never changes.
 */
const LOGO_PATH = path.resolve(__dirname, "..", "assets", "email-logo.png");

let logoBuffer: Buffer | null = null;
try {
  logoBuffer = fs.readFileSync(LOGO_PATH);
} catch {
  // Not fatal. The message still sends; the header simply shows no mark.
  logger.warn("Email logo not found; messages will send without it", { path: LOGO_PATH });
}

function attachments() {
  if (!logoBuffer) return undefined;
  return [
    {
      filename: "nyaysetu.png",
      content: logoBuffer,
      cid: LOGO_CID,
      contentDisposition: "inline" as const,
    },
  ];
}

/**
 * The port SMTP is currently using.
 *
 * Starts at SMTP_PORT and may move to the fallback if the first one turns out to
 * be blocked. Kept here rather than read from env each time so that once a working
 * port is found, every later send uses it.
 */
let activePort: number = env.SMTP_PORT;

/**
 * The ports worth trying, in the order worth trying them.
 *
 * 2525 is the interesting one. It is not a registered SMTP port, which is exactly
 * why it is useful: hosts that block SMTP block the three ports a spammer would
 * reach for — 25, 465 and 587 — and a good number of them leave 2525 open. Brevo,
 * Mailgun and SendGrid all listen on it for that reason. So a relay that is
 * unreachable on 587 is often reachable on 2525 from the same container, and that
 * is the difference between sending mail and not.
 *
 * 465 is last because implicit TLS is the most likely of the three to be filtered
 * by something doing protocol inspection.
 */
const PORT_CANDIDATES = [587, 2525, 465] as const;

/** The configured port first, then the rest, without repeating it. */
function portsToTry(): number[] {
  return [env.SMTP_PORT, ...PORT_CANDIDATES.filter((p) => p !== env.SMTP_PORT)];
}

function build(port: number = activePort): Transporter | null {
  if (!capabilities.smtp) return null;
  if (transporter && port === activePort) return transporter;

  const options = {
    host: env.SMTP_HOST,
    port,
    // Port 465 is implicit TLS. 587 starts plaintext and upgrades with
    // STARTTLS, which nodemailer does automatically when secure is false.
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },

    /**
     * IPv4, deliberately.
     *
     * Node 17 changed DNS resolution to return addresses in the order the resolver
     * gave them rather than IPv4 first, and smtp.gmail.com answers with an AAAA
     * record. Most container platforms — Render, Fly, a good deal of Kubernetes —
     * give a container no IPv6 route at all, so the connection fails with
     * ENETUNREACH against an address like 2607:f8b0:400e:c17::6d before Gmail is
     * ever reached. It reads exactly like a blocked SMTP port or a wrong App
     * Password, and is neither.
     *
     * Pinned rather than probed, because SMTP over IPv4 works everywhere this
     * runs. SMTP_IP_FAMILY=6 exists for a network that is genuinely IPv6-only.
     *
     * Cast because nodemailer's published types omit `family` while its SMTP
     * transport passes it straight to net.connect, which does honour it. The cast
     * is narrow and the reason is here rather than in a commit message.
     */
    family: env.SMTP_IP_FAMILY,

    // A hung SMTP handshake must not hold an HTTP request open indefinitely.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  } as unknown as Parameters<typeof nodemailer.createTransport>[0];

  activePort = port;
  transporter = nodemailer.createTransport(options);

  return transporter;
}

/**
 * True when the failure was the connection rather than the credentials.
 *
 * A refused password is a conversation that happened. A timeout is a conversation
 * that never started, which is either a blocked port or an unroutable address —
 * and those are the only cases where trying the other port is worth anything.
 */
function isConnectionFailure(code: string | undefined, message: string): boolean {
  if (code && ["ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
    return true;
  }
  return /timeout|timed out|ENETUNREACH|ECONNREFUSED|EHOSTUNREACH/i.test(message);
}

/**
 * Confirms the credentials work, at most once per TTL.
 *
 * Pass force to bypass the cache, which only the startup check should do.
 */
export async function verifyTransport(force = false): Promise<{ ok: boolean; error?: string }> {
  if (!force && verifyCache) {
    const ttl = verifyCache.ok ? VERIFY_TTL_OK_MS : VERIFY_TTL_FAIL_MS;
    if (Date.now() - verifyCache.at < ttl) {
      return { ok: verifyCache.ok, error: verifyCache.error };
    }
  }

  // An HTTP provider is checked against its own account endpoint. There is no
  // handshake to verify, only a key to have accepted.
  if (httpProvider()) {
    const outcome = await verifyHttpProvider();
    verifyCache = { ok: outcome.ok, error: outcome.error, at: Date.now() };
    verified = outcome.ok;
    if (outcome.ok) {
      logger.info("Email provider verified", { transport: httpProvider() });
    } else {
      logger.error("Email provider verification failed", {
        transport: httpProvider(),
        error: outcome.error,
      });
    }
    return outcome;
  }

  if (!build()) return { ok: false, error: "No email transport is configured." };

  /**
   * Walk the candidate ports until one connects.
   *
   * Only a CONNECTION failure moves on to the next port. A refused password is a
   * conversation that happened, and retrying it on another port would just refuse
   * it again more slowly — worse, on Gmail it would count as several failed
   * authentications rather than one.
   */
  const candidates = portsToTry();
  const attempts: { port: number; error?: string }[] = [];

  for (const [index, port] of candidates.entries()) {
    if (index > 0) {
      logger.warn(`SMTP on port ${candidates[index - 1]} did not connect; trying ${port}`, {
        previousError: attempts[attempts.length - 1]?.error,
      });
      transporter = null;
    }

    if (!build(port)) break;
    const attempt = await attemptVerify(port);

    if (attempt.ok) {
      verified = true;
      verifyCache = { ok: true, at: Date.now() };
      if (port !== env.SMTP_PORT) {
        logger.warn(
          `SMTP works on port ${port} but not ${env.SMTP_PORT}. Set SMTP_PORT=${port} so this ` +
            "probe does not run on every restart.",
          { triedFirst: candidates.slice(0, index) }
        );
      }
      return { ok: true };
    }

    attempts.push({ port, error: attempt.error });

    // A credential refusal is final. Stop, and report it as itself.
    if (!isConnectionFailure(attempt.code, attempt.error ?? "")) {
      verified = false;
      verifyCache = { ok: false, error: attempt.error, at: Date.now() };
      return { ok: false, error: attempt.error };
    }
  }

  // Every port timed out. That is the signature of a host that does not permit
  // outbound SMTP at all, and saying so is worth more than repeating the last
  // socket error — which sends an operator back to a password that was never wrong.
  transporter = null;
  activePort = env.SMTP_PORT;

  const conclusion =
    `None of ports ${candidates.join(", ")} could be reached at ${env.SMTP_HOST}. This host does ` +
    "not permit outbound SMTP, and the credentials are not the problem. Run the API somewhere " +
    "that allows SMTP, or set BREVO_API_KEY to an API key (xkeysib-…) and send over HTTPS.";

  verified = false;
  verifyCache = { ok: false, error: conclusion, at: Date.now() };
  logger.error("Outbound SMTP appears to be blocked on this host", {
    host: env.SMTP_HOST,
    attempts,
  });
  return { ok: false, error: conclusion };
}

/** One verify against one port, with its diagnosis logged. */
async function attemptVerify(
  port: number
): Promise<{ ok: boolean; error?: string; code?: string }> {
  const transport = build(port);
  if (!transport) return { ok: false, error: "SMTP is not configured." };

  try {
    await transport.verify();
    logger.info("SMTP transport verified", { host: env.SMTP_HOST, port });
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown SMTP error";
    const code = (error as { code?: string })?.code;

    logger.error("SMTP verification failed", {
      host: env.SMTP_HOST,
      port,
      // The message itself, which used to be dropped. Without it a hosted log said
      // only that something had failed, which is the least useful thing a log can say.
      error: message,
      code,
      hint: smtpHint(message, code),
    });
    return { ok: false, error: message, code };
  }
}

/**
 * What to check, for the failures that actually happen.
 *
 * Ordered by how often each one is the answer rather than by severity, because
 * whoever is reading this is trying to get unblocked.
 */
function smtpHint(message: string, code?: string): string | undefined {
  // Brevo issues two credentials that are easy to mix up, and one of them cannot
  // be used here. Named explicitly because the failure is otherwise just "535".
  if (/535|authentication failed/i.test(message) && /brevo|sendinblue/i.test(env.SMTP_HOST ?? "")) {
    return (
      "Brevo refused the login. SMTP_USER must be the Brevo account's login email, not the sender " +
      "address, and SMTP_PASSWORD must be the SMTP key beginning xsmtpsib- from SMTP & API → SMTP. " +
      "An API key beginning xkeysib- will not authenticate over SMTP; that one belongs in " +
      "BREVO_API_KEY instead."
    );
  }
  if (/username and password not accepted|invalid login|535|534/i.test(message)) {
    return (
      "Authentication was refused. For Gmail, SMTP_PASSWORD must be the 16-character App Password " +
      "with the spaces removed — a hosted environment variable pasted straight from Google keeps " +
      "them, and Gmail rejects it. 2-Step Verification must also be on."
    );
  }
  if (code === "ENETUNREACH" || /ENETUNREACH/i.test(message)) {
    const ipv6 = /[0-9a-f]{0,4}:[0-9a-f]{0,4}:[0-9a-f:]+/i.test(message);
    return (
      "The network had no route to the mail server" +
      (ipv6 ? " at an IPv6 address" : "") +
      ". This is almost always a host with no IPv6 route resolving smtp.gmail.com to its AAAA " +
      "record. SMTP_IP_FAMILY defaults to 4 to prevent it; if you have overridden it to 6, set it " +
      "back."
    );
  }
  if (code === "ETIMEDOUT" || code === "ESOCKET" || /timeout|timed out/i.test(message)) {
    return (
      "The connection never completed, which means outbound SMTP is blocked rather than that the " +
      "credentials are wrong. The other port is tried automatically; if that also times out, this " +
      "host does not permit SMTP at all. Run the API somewhere that does, or set BREVO_API_KEY."
    );
  }
  if (code === "EDNS" || /getaddrinfo|ENOTFOUND/i.test(message)) {
    return "SMTP_HOST did not resolve. Check it for a typo.";
  }
  if (/certificate|self signed|tls/i.test(message)) {
    return "TLS negotiation failed. Port 465 is implicit TLS; 587 upgrades with STARTTLS.";
  }
  return undefined;
}

/**
 * Masks an address for display and for the log: `apurva@gmail.com` becomes
 * `a••••a@gmail.com`. Enough for a person to recognise their own address,
 * not enough to harvest.
 */
export function maskEmail(address: string): string {
  const [local, domain] = address.split("@");
  if (!domain) return "•••";
  if (local.length <= 2) return `${local[0] ?? "•"}•••@${domain}`;
  return `${local[0]}${"•".repeat(Math.min(6, local.length - 2))}${local[local.length - 1]}@${domain}`;
}

async function record(args: {
  userId?: string | null;
  purpose: string;
  to: string;
  subject: string;
  result: SendResult;
}) {
  try {
    await db.from("email_log").insert({
      user_id: args.userId ?? null,
      purpose: args.purpose,
      masked_to: maskEmail(args.to),
      subject: args.subject,
      status: args.result.status,
      provider_id: args.result.messageId ?? null,
      error: args.result.error?.slice(0, 400) ?? null,
    });
  } catch (error) {
    // A logging failure must not break the thing being logged.
    logger.warn("Could not write email_log", {
      purpose: args.purpose,
      error: error instanceof Error ? error.message : error,
    });
  }
}

function fromAddress(): string {
  return env.SMTP_FROM ?? `NyaySetu <${env.SMTP_USER}>`;
}

async function send(args: {
  to: string;
  subject: string;
  text: string;
  html: string;
  purpose: string;
  userId?: string | null;
  /**
   * Files to attach beyond the inline logo. A court document goes out this way:
   * as an attachment the recipient can save and hash, not as HTML in a body that
   * every client renders differently.
   */
  files?: { filename: string; content: Buffer; contentType?: string }[];
}): Promise<SendResult> {
  if (!capabilities.emailTransport) {
    const result: SendResult = { status: "skipped", error: "No email transport is configured." };
    await record({ ...args, result });
    return result;
  }

  /**
   * The HTTPS path, taken whenever a provider key is present.
   *
   * Same bodies, same attachments, same logging. The only difference a caller can
   * observe is that Brevo has no field for an inline Content-ID, so the logo
   * arrives as an attachment rather than in the header — noted in httpTransport.ts
   * rather than worked around, because a message that sends with a plain header
   * beats a message that does not send.
   */
  if (httpProvider()) {
    const check = await verifyTransport();
    if (!check.ok) {
      const result: SendResult = { status: "failed", error: check.error };
      await record({ ...args, result });
      return result;
    }

    const outcome = await sendOverHttp({
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
      from: fromAddress(),
      attachments: [
        ...(attachments() ?? []).map((file) => ({
          filename: file.filename,
          content: file.content,
          cid: file.cid,
        })),
        ...(args.files ?? []).map((file) => ({
          filename: file.filename,
          content: file.content,
          contentType: file.contentType ?? "application/pdf",
        })),
      ],
    });

    const result: SendResult = outcome.ok
      ? { status: "sent", messageId: outcome.messageId }
      : { status: "failed", error: outcome.error };
    await record({ ...args, result });

    if (outcome.ok) {
      logger.info("Email sent", {
        purpose: args.purpose,
        to: maskEmail(args.to),
        transport: httpProvider(),
      });
    }
    return result;
  }

  const transport = build();

  if (!transport) {
    const result: SendResult = { status: "skipped", error: "SMTP is not configured." };
    await record({ ...args, result });
    return result;
  }

  const check = await verifyTransport();
  if (!check.ok) {
    const result: SendResult = { status: "failed", error: check.error };
    await record({ ...args, result });
    return result;
  }

  try {
    const info = await transport.sendMail({
      from: fromAddress(),
      to: args.to,
      subject: args.subject,
      text: args.text,
      html: args.html,
      attachments: [
        ...(attachments() ?? []),
        ...(args.files ?? []).map((file) => ({
          filename: file.filename,
          content: file.content,
          contentType: file.contentType ?? "application/pdf",
          contentDisposition: "attachment" as const,
        })),
      ],
      // Marks the message as automatic so replies and vacation responders do
      // not bounce back into the mailbox.
      headers: { "Auto-Submitted": "auto-generated", "X-NyaySetu-Purpose": args.purpose },
    });

    const result: SendResult = { status: "sent", messageId: info.messageId };
    await record({ ...args, result });
    logger.info("Email sent", { purpose: args.purpose, to: maskEmail(args.to) });
    return result;
  } catch (error) {
    const result: SendResult = {
      status: "failed",
      error: error instanceof Error ? error.message : "unknown SMTP error",
    };
    await record({ ...args, result });
    logger.error("Email send failed", {
      purpose: args.purpose,
      to: maskEmail(args.to),
      error: result.error,
    });
    return result;
  }
}

/* ======================================================= templates ======== */

/**
 * Every message is built from the pieces in emailTemplates.ts, and every one
 * ships a text/plain alternative alongside the HTML. A client with images and
 * HTML disabled must still show a usable code: that is the whole reason the
 * plain part is written out by hand rather than stripped from the markup.
 */

/** The login second factor. */
export async function sendLoginOtp(args: {
  to: string;
  userId: string;
  fullName: string;
  code: string;
  ttlMinutes: number;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SendResult> {
  const first = args.fullName.split(" ")[0] || "there";

  const text = [
    `Hello ${first},`,
    "",
    `Your NyaySetu sign-in code is ${args.code}`,
    "",
    `It expires in ${args.ttlMinutes} minutes and can be used once.`,
    args.ip ? `Requested from ${args.ip}.` : "",
    "",
    "If this was not you, somebody else may know your password. Change it and",
    "tell the court administrator.",
  ]
    .filter(Boolean)
    .join("\n");

  return send({
    to: args.to,
    userId: args.userId,
    purpose: "login_mfa",
    subject: `${args.code} is your NyaySetu sign-in code`,
    text,
    html: shell({
      title: "Your sign-in code",
      kicker: "Verify it is you",
      tone: "green",
      body:
        paragraph(`Hello ${escapeHtml(first)}, use this code to finish signing in.`) +
        codePanel(args.code) +
        paragraph(
          `It expires in ${strong(`${args.ttlMinutes} minutes`)} and can be used once.` +
            (args.ip
              ? ` Requested from <span style="color:${BRAND.text};">${escapeHtml(args.ip)}</span>.`
              : "")
        ) +
        callout(
          "The code is tied to the browser that entered your password, so it cannot be " +
            "redeemed anywhere else even if somebody else reads this inbox.",
          "green"
        ),
      footnote:
        "If this was not you, somebody else may know your password. Change it and tell the court administrator.",
    }),
  });
}

/**
 * The invitation a new account receives.
 *
 * This is the only moment a password travels by email, which is why the one it
 * carries is temporary and single-use. The message says so plainly rather than
 * burying it, because a recipient who does not understand that will leave it in
 * their inbox.
 */
export async function sendInvitation(args: {
  to: string;
  userId: string;
  fullName: string;
  roleLabel: string;
  temporaryPassword: string;
  invitedByName: string;
  portalUrl: string;
}): Promise<SendResult> {
  const first = args.fullName.split(" ")[0] || "there";

  const text = [
    `${first},`,
    "",
    `${args.invitedByName} has created a NyaySetu account for you as ${args.roleLabel}.`,
    "",
    `Sign in at: ${args.portalUrl}`,
    `Email:      ${args.to}`,
    `Password:   ${args.temporaryPassword}`,
    "",
    "This password works once. You will be asked to choose your own before you",
    "can go any further.",
    "",
    "Signing in takes two steps: this password, then a six digit code sent to",
    "this same address. Nobody can reach your account with the password alone.",
    "",
    "If you were not expecting this, tell the court administrator. Do not sign in.",
  ].join("\n");

  return send({
    to: args.to,
    userId: args.userId,
    purpose: "invitation",
    subject: `Your NyaySetu account: ${args.roleLabel}`,
    text,
    html: shell({
      title: "An account has been created for you",
      kicker: "Welcome",
      tone: "green",
      body:
        paragraph(
          `${escapeHtml(first)}, ${escapeHtml(args.invitedByName)} has created a NyaySetu account ` +
            `for you as ${strong(args.roleLabel)}.`
        ) +
        credentialRow("Email", args.to) +
        credentialRow("Temporary password", args.temporaryPassword) +
        callout(
          `This password works ${strong("once")}. You will be asked to choose your own before you can ` +
            "go any further, so it stops being useful the moment you have used it.",
          "orange"
        ) +
        steps([
          "Open the sign-in page and enter the address and password above.",
          "A six digit code arrives at this same address. Enter it.",
          "Choose a password of your own. That is the one you keep.",
        ]) +
        button(args.portalUrl, "Sign in", "green"),
      footnote:
        "If you were not expecting this, tell the court administrator and do not sign in.",
    }),
  });
}

/**
 * Sends a court document as an attachment, with a covering note.
 *
 * The document is attached rather than rendered into the body, for two reasons.
 * A recipient has to be able to save the exact bytes and compute their digest —
 * an HTML body reflowed by a mail client is not a document anybody can verify.
 * And the covering note deliberately says almost nothing: the file is the
 * communication, and duplicating its contents in an email body creates a second
 * version that can disagree with the first.
 */
export async function sendCaseDocument(args: {
  to: string;
  userId?: string | null;
  recipientName?: string | null;
  documentTitle: string;
  fileName: string;
  pdf: Buffer;
  caseReference: string;
  caseTitle: string;
  sentByName: string;
  digest: string;
  note?: string | null;
}): Promise<SendResult> {
  const greeting = args.recipientName?.split(" ")[0] || "Sir/Madam";

  const text = [
    `${greeting},`,
    "",
    `${args.documentTitle} in ${args.caseReference} is attached.`,
    "",
    `Case      : ${args.caseTitle}`,
    `Reference : ${args.caseReference}`,
    `Sent by   : ${args.sentByName}`,
    "",
    "SHA-256 of the attached file:",
    args.digest,
    "",
    ...(args.note ? ["Note:", args.note, ""] : []),
    "Compute the digest of the file you received and compare it with the line above.",
    "If they differ, the file has been altered in transit and should not be relied on.",
    "",
    "Sent automatically by NyaySetu. Do not reply to this address.",
  ].join("\n");

  return send({
    to: args.to,
    userId: args.userId ?? null,
    purpose: "case_document",
    subject: `${args.documentTitle} — ${args.caseReference}`,
    text,
    files: [{ filename: args.fileName, content: args.pdf, contentType: "application/pdf" }],
    html: shell({
      title: args.documentTitle,
      kicker: args.caseReference,
      tone: "green",
      body:
        paragraph(
          `${escapeHtml(greeting)}, the document named above is attached to this message as a PDF.`
        ) +
        credentialRow("Case", `${args.caseReference} — ${args.caseTitle}`) +
        credentialRow("SHA-256 of the attachment", args.digest) +
        (args.note ? callout(escapeHtml(args.note), "green") : "") +
        paragraph(
          "Compute the digest of the file you received and compare it with the value above. If the " +
            "two differ, the file was altered after it was sent and should not be relied upon. The " +
            "document itself explains how to check the evidence it schedules against the blockchain."
        ) +
        paragraph(`Sent by ${strong(args.sentByName)}.`),
      footnote:
        "The attachment is the communication. Nothing in this email restates its contents, so the " +
        "two cannot disagree.",
    }),
  });
}

/** Tells a recipient a summons exists, without putting its contents in email. */
export async function sendSummonsNotice(args: {
  to: string;
  userId?: string | null;
  recipientName: string;
  caseReference: string;
  courtName: string | null;
  expiryAt: string;
  portalUrl: string;
}): Promise<SendResult> {
  const deadline = new Date(args.expiryAt).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const text = [
    `${args.recipientName},`,
    "",
    `A summons has been issued to you in ${args.caseReference}${args.courtName ? ` by ${args.courtName}` : ""}.`,
    "",
    `You must acknowledge it by ${deadline}. If that window closes without your`,
    "acknowledgement, the court is notified that it could not be served and may",
    "proceed on that basis.",
    "",
    `Sign in to read and acknowledge it: ${args.portalUrl}`,
    "",
    "The summons itself is not attached. It is readable only after you sign in.",
  ].join("\n");

  return send({
    to: args.to,
    userId: args.userId,
    purpose: "summons_notice",
    subject: `Action needed: summons in ${args.caseReference}`,
    text,
    html: shell({
      title: "A summons has been issued to you",
      kicker: "Action needed",
      tone: "orange",
      body:
        paragraph(
          `${escapeHtml(args.recipientName)}, a summons has been issued to you in ` +
            `${strong(args.caseReference)}${args.courtName ? ` by ${escapeHtml(args.courtName)}` : ""}.`
        ) +
        callout(
          `Acknowledge it by ${strong(deadline)}. If the window closes unanswered, the court is ` +
            "told it could not be served and may proceed on that basis.",
          "orange"
        ) +
        button(args.portalUrl, "Read and acknowledge", "orange"),
      footnote: "The summons itself is not attached. It is readable only after you sign in.",
    }),
  });
}

/** Warns the court that an acknowledgement window closed unanswered. */
export async function sendNonDeliveryAlert(args: {
  to: string;
  userId?: string | null;
  recipientName: string;
  caseReference: string;
  expiryAt: string;
  portalUrl: string;
}): Promise<SendResult> {
  const closed = new Date(args.expiryAt).toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const text = [
    `The acknowledgement window for a summons in ${args.caseReference} closed at`,
    `${closed} without a response.`,
    "",
    `Recipient: ${args.recipientName}`,
    "",
    "The contract now reports this summons as FAILED, and that conclusion is",
    "recorded on chain.",
    "",
    args.portalUrl,
  ].join("\n");

  return send({
    to: args.to,
    userId: args.userId,
    purpose: "non_delivery_alert",
    subject: `Summons not served: ${args.caseReference}`,
    text,
    html: shell({
      title: "A summons went unanswered",
      kicker: "Service failed",
      tone: "orange",
      body:
        paragraph(
          `The acknowledgement window for a summons in ${strong(args.caseReference)} closed at ` +
            `${strong(closed)} without a response.`
        ) +
        callout(
          `${strong("Recipient:")} ${escapeHtml(args.recipientName)}<br>` +
            "The contract now reports this summons as FAILED, and that conclusion is on chain.",
          "red"
        ) +
        button(args.portalUrl, "Open the summons register", "green"),
    }),
  });
}

/** For the admin dashboard and /api/health. */
export async function mailerHealth(): Promise<{
  configured: boolean;
  reachable: boolean;
  transport?: string;
  host?: string;
  from?: string;
  error?: string;
  note?: string;
}> {
  if (!capabilities.emailTransport) {
    return {
      configured: false,
      reachable: false,
      note:
        "Set SMTP_HOST/SMTP_USER/SMTP_PASSWORD, or — on a host that blocks outbound SMTP — a " +
        "BREVO_API_KEY or RESEND_API_KEY together with SMTP_FROM.",
    };
  }

  const check = await verifyTransport();
  const provider = httpProvider();

  return {
    configured: true,
    reachable: check.ok,
    transport: provider ?? "smtp",
    host: provider ? `https (${provider})` : `${env.SMTP_HOST}:${activePort}`,
    from: env.SMTP_FROM ?? env.SMTP_USER,
    error: check.error,
    note: provider
      ? undefined
      : "Sending over SMTP. Most container hosts block outbound port 587; if this reports a " +
        "timeout, that is the cause and an HTTP provider is the fix.",
  };
}

/** A plain reminder (F18). Names the obligation and the deadline; never the case's content. */
export async function sendPlainNotice(args: {
  to: string;
  userId?: string | null;
  subject: string;
  body: string;
  purpose: string;
}): Promise<SendResult> {
  const portalUrl = env.PUBLIC_APP_URL.replace(/\/$/, "");
  return send({
    to: args.to,
    userId: args.userId,
    purpose: args.purpose,
    subject: args.subject,
    text: `${args.body}\n\n${portalUrl}`,
    html: shell({
      title: args.subject,
      kicker: "Reminder",
      tone: "green",
      body: paragraph(escapeHtml(args.body)) + button(portalUrl, "Open NyaySetu", "green"),
      footnote: "This reminder does not contain any detail of your case.",
    }),
  });
}
