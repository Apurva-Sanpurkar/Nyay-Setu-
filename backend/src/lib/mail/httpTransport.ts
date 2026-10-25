import { env } from "../../config/env";
import { logger } from "../logger";

/**
 * Sending email over HTTPS instead of SMTP.
 *
 * WHY THIS EXISTS
 *   Render, Fly, Vercel and most other container hosts block outbound SMTP —
 *   ports 25, 465 and 587 — because a container that can speak SMTP is a spam
 *   relay waiting to be found. The block is silent: the connection is accepted and
 *   then nothing happens, so it surfaces as ETIMEDOUT and reads exactly like a
 *   wrong password. No SMTP setting fixes it, because the problem is not SMTP
 *   configuration; it is that SMTP is not permitted at all.
 *
 *   Port 443 is permitted everywhere. So the same messages go out through a
 *   provider's HTTPS API, and the SMTP path stays for local development and for
 *   hosts that do allow it.
 *
 * WHY TWO PROVIDERS AND NOT ONE
 *   They differ in what they need before they will send anything, and that
 *   difference decides which one somebody can actually use today:
 *
 *     Resend  — the cleanest API, but until a domain is verified it will only
 *               deliver to the address that owns the account. Fine for a single
 *               administrator; useless for emailing a judge.
 *     Brevo   — verifies a single sender address rather than a domain, so a Gmail
 *               address can send to anyone after one confirmation click.
 *
 *   Brevo is therefore the one to reach for without a domain, and Resend the one
 *   to prefer once there is one. Whichever key is present is used.
 */

export interface HttpMailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** "NyaySetu <no-reply@example.in>" or a bare address. */
  from: string;
  attachments: { filename: string; content: Buffer; contentType?: string; cid?: string }[];
}

export interface HttpMailResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export type HttpProviderName = "resend" | "brevo";

/** Which HTTP provider is configured, if any. */
export function httpProvider(): HttpProviderName | null {
  if (env.EMAIL_TRANSPORT === "smtp") return null;
  if (env.EMAIL_TRANSPORT === "resend") return env.RESEND_API_KEY ? "resend" : null;
  if (env.EMAIL_TRANSPORT === "brevo") return env.BREVO_API_KEY ? "brevo" : null;

  // auto: whichever key exists. Brevo first, because it is the one that works
  // without a verified domain and is therefore the more likely deliberate choice.
  if (env.BREVO_API_KEY) return "brevo";
  if (env.RESEND_API_KEY) return "resend";
  return null;
}

/** Splits "NyaySetu <a@b.c>" into its parts. Bare addresses pass through. */
function parseAddress(value: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/.exec(value);
  if (!match) return { email: value.trim() };
  return { name: match[1] || undefined, email: match[2].trim() };
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; json: any; text: string }> {
  // A provider that hangs must not hold an HTTP request open. Ten seconds is the
  // same budget the SMTP path allowed for a handshake.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** The provider's own words, trimmed. Better than "request failed with 422". */
function describe(status: number, json: any, text: string): string {
  const message =
    json?.message ??
    json?.error?.message ??
    json?.error ??
    (Array.isArray(json?.errors) ? json.errors.map((e: any) => e.message ?? e).join("; ") : null) ??
    text.slice(0, 200);
  return `${status}: ${typeof message === "string" ? message : JSON.stringify(message)}`;
}

async function sendResend(message: HttpMailMessage): Promise<HttpMailResult> {
  const { status, json, text } = await post(
    "https://api.resend.com/emails",
    { authorization: `Bearer ${env.RESEND_API_KEY}` },
    {
      from: message.from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: message.attachments.map((file) => ({
        filename: file.filename,
        content: file.content.toString("base64"),
        // Resend calls the Content-ID field content_id; without it an inline
        // image is delivered as an ordinary attachment and the logo disappears
        // from the header.
        ...(file.cid ? { content_id: file.cid } : {}),
      })),
    }
  );

  if (status >= 200 && status < 300) return { ok: true, messageId: json?.id };
  return { ok: false, error: describe(status, json, text) };
}

async function sendBrevo(message: HttpMailMessage): Promise<HttpMailResult> {
  const sender = parseAddress(message.from);

  const { status, json, text } = await post(
    "https://api.brevo.com/v3/smtp/email",
    { "api-key": env.BREVO_API_KEY! },
    {
      sender: { email: sender.email, ...(sender.name ? { name: sender.name } : {}) },
      to: [{ email: message.to }],
      subject: message.subject,
      textContent: message.text,
      htmlContent: message.html,
      attachment: message.attachments.map((file) => ({
        name: file.filename,
        content: file.content.toString("base64"),
      })),
    }
  );

  if (status >= 200 && status < 300) return { ok: true, messageId: json?.messageId };
  return { ok: false, error: describe(status, json, text) };
}

/**
 * Sends one message through whichever HTTP provider is configured.
 *
 * Brevo's API has no field for an inline attachment's Content-ID, so a message
 * sent through it shows the logo as an attachment rather than in the header. The
 * message is still correct and still readable, which is the right trade against
 * not sending it at all — and it is noted here so nobody spends an afternoon
 * wondering why the header looks bare.
 */
export async function sendOverHttp(message: HttpMailMessage): Promise<HttpMailResult> {
  const provider = httpProvider();
  if (!provider) return { ok: false, error: "No HTTP email provider is configured." };

  try {
    const result = provider === "resend" ? await sendResend(message) : await sendBrevo(message);
    if (!result.ok) {
      logger.error("HTTP email provider refused the message", {
        provider,
        error: result.error,
        hint: httpHint(provider, result.error ?? ""),
      });
    }
    return result;
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? "The provider did not respond within ten seconds."
        : error instanceof Error
          ? error.message
          : "unknown error";
    logger.error("HTTP email provider could not be reached", { provider, error: reason });
    return { ok: false, error: reason };
  }
}

/** The refusals that actually happen, and what to do about each. */
function httpHint(provider: HttpProviderName, error: string): string | undefined {
  /**
   * Brevo's IP allow-list, which is on by default for new accounts.
   *
   * It rejects a perfectly valid key from an address it has not seen, and the
   * message it returns says "unauthorized" — so it reads as a bad key and sends
   * you to regenerate one that was never the problem. It matters more than it
   * looks on a container host: Railway, Render and Fly all have egress addresses
   * that change, so allow-listing one is not a fix, and the restriction has to
   * come off.
   */
  const unrecognisedIp = /unrecognised IP address\s+([0-9a-f.:]+)/i.exec(error);
  if (unrecognisedIp) {
    return (
      `Brevo refused the key because it has not seen the address ${unrecognisedIp[1]} before. ` +
      "The key is valid. Turn the IP restriction off at app.brevo.com/security/authorised_ips — " +
      "allow-listing is not workable on a container host, whose egress address changes between " +
      "deploys."
    );
  }
  if (/unauthor|invalid api|401|403/i.test(error)) {
    return provider === "resend"
      ? "RESEND_API_KEY was rejected. Keys begin with re_ and are shown once when created."
      : "BREVO_API_KEY was rejected. Use a v3 API key from Brevo → SMTP & API → API keys, not an SMTP password.";
  }
  if (/domain|not verified|sender/i.test(error)) {
    return provider === "resend"
      ? "Resend will only deliver to the account owner's own address until a sending domain is verified. " +
          "Verify a domain, or use Brevo, which verifies a single sender address instead."
      : "Brevo requires the sender address to be verified. Add it under Senders & IPs and click the " +
          "confirmation email, then set SMTP_FROM to exactly that address.";
  }
  return undefined;
}

/**
 * Confirms the key works without sending anything.
 *
 * Both providers expose an account endpoint, which is the closest thing to SMTP's
 * verify: it proves the credential is accepted. It cannot prove the sender address
 * is verified — only a real send does that — so a green check here still leaves one
 * way to fail, and the hints above cover it.
 */
export async function verifyHttpProvider(): Promise<{ ok: boolean; error?: string }> {
  const provider = httpProvider();
  if (!provider) return { ok: false, error: "No HTTP email provider is configured." };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const response =
      provider === "resend"
        ? await fetch("https://api.resend.com/domains", {
            headers: { authorization: `Bearer ${env.RESEND_API_KEY}` },
            signal: controller.signal,
          })
        : await fetch("https://api.brevo.com/v3/account", {
            headers: { "api-key": env.BREVO_API_KEY! },
            signal: controller.signal,
          });

    if (response.ok) return { ok: true };

    // The body is read even on failure: Brevo's IP allow-list refusal is a 401
    // whose only distinguishing feature is the message, and reporting the status
    // alone would lose the one piece of information that identifies it.
    const body = await response.text().catch(() => "");
    const detail = (() => {
      try {
        const parsed = JSON.parse(body);
        return parsed?.message ?? parsed?.error?.message ?? "";
      } catch {
        return body.slice(0, 200);
      }
    })();

    const error = `${provider} rejected the API key (${response.status})${detail ? `: ${detail}` : ""}`;
    logger.error("Email provider rejected the API key", {
      provider,
      status: response.status,
      detail,
      hint: httpHint(provider, detail || error),
    });
    return { ok: false, error };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.name === "AbortError"
          ? `${provider} did not respond within eight seconds.`
          : error instanceof Error
            ? error.message
            : "unknown error",
    };
  } finally {
    clearTimeout(timer);
  }
}
