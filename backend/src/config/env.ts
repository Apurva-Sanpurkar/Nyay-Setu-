import * as dotenv from "dotenv";
import * as path from "path";
import { z } from "zod";

dotenv.config();

// On Vercel, NODE_ENV is deliberately not set as a project variable (it would
// make the build skip devDependencies). A Vercel production deployment is still
// production: secure cookies on, the sandbox code never echoed.
if (!process.env.NODE_ENV && process.env.VERCEL_ENV === "production") process.env.NODE_ENV = "production";

/**
 * Environment contract for the API.
 *
 * Three tiers:
 *   - required: the process refuses to start without them
 *   - optional-with-degradation: the feature reports itself unavailable
 *     (chain, IPFS, AI) instead of crashing, so a partially configured clone
 *     still boots and tells you what is missing
 *   - defaulted: sensible values so a local run needs almost no setup
 */

const hex32 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be 64 hex characters (32 bytes)");

/**
 * An optional setting that is ABSENT when the variable is present but blank.
 *
 * This matters more than it looks. A committed .env.example lists every
 * optional key with an empty value, so a copied .env hands this schema
 * EVIDENCE_CHAIN_ADDRESS="" rather than undefined. Plain `.optional()` accepts
 * that, and "" then survives a `?? fallback` because it is neither null nor
 * undefined -- which is how an empty string ends up being passed to ethers as a
 * contract address. Normalising blanks to undefined here fixes the whole class
 * of that bug in one place.
 */
const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional()
);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  // Comma-separated list. Credentials are sent with requests, so this can
  // never be "*".
  CORS_ORIGINS: z.string().default("http://localhost:5173,http://localhost:4173"),

  // ---------------------------------------------------------------- database
  SUPABASE_URL: z.string().url("set SUPABASE_URL to your project URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "set SUPABASE_SERVICE_ROLE_KEY"),

  // ---------------------------------------------------------------- sessions
  SESSION_COOKIE_NAME: z.string().default("nyaysetu_session"),
  CSRF_COOKIE_NAME: z.string().default("nyaysetu_csrf"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(8),
  // "none" is required when the API and the SPA sit on different sites; it
  // demands Secure, so it only works over HTTPS.
  COOKIE_SAMESITE: z.enum(["strict", "lax", "none"]).default("strict"),
  COOKIE_DOMAIN: optionalString,

  // ------------------------------------------------------------------ crypto
  // HMAC pepper for Aadhaar tokenisation. Changing it invalidates every stored
  // token, so it belongs in a secrets manager, not in a migration.
  AADHAAR_TOKEN_PEPPER: z.string().min(32, "AADHAAR_TOKEN_PEPPER must be >= 32 chars"),
  // AES-256-GCM key for evidence files. 64 hex characters.
  EVIDENCE_ENCRYPTION_KEY: hex32,
  EVIDENCE_ENCRYPTION_KEY_ID: z.string().default("v1"),

  // ------------------------------------------------------------------- chain
  CHAIN_RPC_URL: optionalString,
  // The keeper wallet that relays citizen actions. Testnet key only.
  CHAIN_PRIVATE_KEY: optionalString,
  CHAIN_NETWORK: z.string().default("localhost"),
  // Path to the file contracts/scripts/deploy.ts wrote. Carries addresses + ABIs.
  DEPLOYED_ARTIFACT: optionalString,
  EVIDENCE_CHAIN_ADDRESS: optionalString,
  SUMMONS_CHAIN_ADDRESS: optionalString,
  BAIL_CHAIN_ADDRESS: optionalString,
  CHAIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(1),
  // How long a request waits for its transaction to be mined before answering
  // "submitted, being tracked" instead of blocking.
  SUBMIT_WAIT_SECONDS: z.coerce.number().int().min(5).max(600).default(90),

  // ------------------------------------------------- verification (2.0 · F2)
  // Blocks that must sit on top of a registration before it is CONFIRMED.
  // Unset: 3 on a public network, 1 on a local Hardhat node (which only mines
  // when it receives a transaction, so it would never reach 3 on its own).
  CONFIRMATION_DEPTH: z.coerce.number().int().min(1).max(64).optional(),
  // A submitted transaction with no receipt after this long goes to review.
  PENDING_TIMEOUT_MINUTES: z.coerce.number().int().min(1).default(30),
  // A transaction the node no longer knows about, after this long, is dropped.
  DROPPED_AFTER_MINUTES: z.coerce.number().int().min(1).default(10),
  // How long after confirmation the tracker keeps checking for a reorg.
  REORG_WATCH_MINUTES: z.coerce.number().int().min(1).default(60),
  // Reminders (F18): sandbox records them without sending; email sends them.
  NOTIFY_PROVIDER: z.enum(["sandbox", "email"]).default("sandbox"),
  REMINDER_LEAD_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  // Discrepancy detection (F4). Thresholds for raising an alert, never for acting on it.
  DELAYED_TX_MINUTES: z.coerce.number().int().min(1).default(10),
  CUSTODY_GAP_HOURS: z.coerce.number().int().min(1).default(72),
  INDEXER_LAG_BLOCKS: z.coerce.number().int().min(1).default(500),
  // Write raw micro-degree coordinates into registerEvidence. Off by default:
  // the fix is committed inside the capture manifest instead. See DECISIONS D-03.
  // Live capture (F10). The device enforces these before capture; the server
  // re-checks them.
  CAPTURE_MAX_ACCURACY_M: z.coerce.number().positive().default(50),
  CAPTURE_REQUIRE_GPS: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  // Device clock against server clock. Beyond this, the item is flagged.
  CLOCK_SKEW_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
  ANCHOR_RAW_COORDS_ON_CHAIN: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // -------------------------------------------------------------------- IPFS
  PINATA_JWT: optionalString,
  PINATA_API_KEY: optionalString,
  PINATA_API_SECRET: optionalString,
  PINATA_GATEWAY: z.string().default("https://gateway.pinata.cloud"),
  // Where encrypted blobs go when Pinata is not configured. Keeps the demo
  // runnable offline; never use in production.
  LOCAL_BLOB_DIR: z.string().default("storage/blobs"),

  // ---------------------------------------------------------------------- AI
  AI_SERVICE_URL: optionalString,
  AI_SERVICE_KEY: optionalString,
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

  // --------------------------------------------------------------------- OTP
  OTP_PROVIDER: z.enum(["sandbox", "uidai"]).default("sandbox"),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  // Sandbox only: echo the OTP in the API response so a demo needs no SMS.
  // Refuses to take effect when NODE_ENV=production.
  OTP_ECHO_IN_RESPONSE: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  UIDAI_BASE_URL: optionalString,
  UIDAI_CLIENT_ID: optionalString,
  UIDAI_CLIENT_SECRET: optionalString,
  UIDAI_AUA_CODE: optionalString,

  // ---------------------------------------------------------------- SMTP
  // Outbound email: the login second factor, and summons notices.
  SMTP_HOST: optionalString,
  // 587 (STARTTLS) or 465 (implicit TLS). If the configured one cannot be
  // reached, the other is tried once automatically; see lib/mailer.ts.
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  // For Gmail this is a 16-character App Password, not the account password.
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,
  // 4 unless the host is genuinely IPv6-only. See the note in lib/mailer.ts:
  // smtp.gmail.com has an AAAA record and most containers have no IPv6 route,
  // which fails as ENETUNREACH and looks like a credentials problem.
  SMTP_IP_FAMILY: z.coerce.number().int().refine((v) => v === 4 || v === 6).default(4),

  // ------------------------------------------------------- email over HTTPS
  // Most container hosts block outbound SMTP silently, so the same messages can
  // go out through a provider's HTTPS API instead. See lib/mail/httpTransport.ts.
  //   auto   - use an HTTP provider if a key is present, otherwise SMTP
  //   smtp   - force SMTP, even if an HTTP key exists
  //   resend - force Resend
  //   brevo  - force Brevo
  EMAIL_TRANSPORT: z.enum(["auto", "smtp", "resend", "brevo"]).default("auto"),
  RESEND_API_KEY: optionalString,
  BREVO_API_KEY: optionalString,

  // Two-factor sign-in by email. Off unless SMTP is configured, because
  // switching it on without a working mailbox would lock everybody out.
  LOGIN_OTP_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  LOGIN_OTP_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  // Signs the short-lived cookie that carries a half-finished sign-in between
  // the password step and the code step. Falls back to the Aadhaar pepper.
  LOGIN_CHALLENGE_SECRET: optionalString,

  // Emails a recipient that a summons exists. Never includes its contents.
  EMAIL_NOTIFICATIONS_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),

  // Where the links in an email point. Must be the SPA, not the API.
  PUBLIC_APP_URL: z.string().default("http://localhost:5173"),

  // Shared secret for POST /api/health/sweep, so a hosted cron can drive the
  // 72 hour summons window and the bail check-in sweep on a platform where the
  // process does not stay alive between requests. Unset means the endpoint is
  // not mounted at all, rather than mounted and unprotected.
  CRON_SECRET: optionalString,

  // How many proxies sit in front of the API. 1 on Render alone; 2 when the web
  // host (Vercel or Netlify) forwards /api to it. Decides which address in
  // X-Forwarded-For is the visitor's, which is what rate limits key on.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  // ------------------------------------------------------------------- jobs
  // 72 hours, per the specification.
  SUMMONS_WINDOW_HOURS: z.coerce.number().int().positive().default(72),
  SWEEP_INTERVAL_MS: z.coerce.number().int().min(10_000).default(120_000),

  /**
   * How many blocks one eth_getLogs call may span.
   *
   * Ten, because that is what Alchemy's free tier permits, and asking for more
   * gets the whole call rejected rather than truncated. A paid endpoint or a
   * self-hosted node will take thousands, and raising this is the single biggest
   * thing that speeds up a first index. The indexer halves it on a range refusal,
   * so an over-optimistic value costs one wasted request rather than a stall.
   */
  INDEXER_MAX_RANGE: z.coerce.number().int().min(1).max(100_000).default(10),

  /**
   * How many of those windows to walk per poll.
   *
   * With the default range of ten this is 400 blocks a pass, against the roughly
   * ten blocks Sepolia produces in two minutes — so a fresh index catches up
   * rather than falling further behind, which it would at one window per pass.
   */
  INDEXER_CHUNKS_PER_PASS: z.coerce.number().int().min(1).max(500).default(40),
  INDEXER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
  SCHEDULER_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v === "true"),

  // ------------------------------------------------------------ rate limits
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  OTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  // Record-writing and chain-writing routes, per session per window.
  WRITE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(40),
  // The public verification page and its API, per IP per window.
  PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  LOGIN_LOCKOUT_ATTEMPTS: z.coerce.number().int().positive().default(5),
  LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),

  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  // A recording sent in resumable pieces (F12). Reassembled in memory once at
  // registration, so keep this within what the API host can hold.
  MAX_CHUNKED_UPLOAD_BYTES: z.coerce.number().int().positive().default(300 * 1024 * 1024),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
  console.error(
    [
      "",
      "NyaySetu API cannot start: the environment is incomplete.",
      "",
      ...lines,
      "",
      "Copy backend/.env.example to backend/.env and fill in the values.",
      "Generate the two secrets with:",
      "  node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
      "",
    ].join("\n")
  );
  process.exit(1);
}

const raw = parsed.data;

/**
 * The origins allowed to send credentialed requests.
 *
 * Normalised rather than compared raw, because an Origin header is an exact
 * string and the ways of getting it slightly wrong all look identical in a
 * dashboard: a trailing slash, a capital letter, a stray space after a comma.
 * Any of them produces "No Access-Control-Allow-Origin" in a browser and no clue
 * as to why, so they are absorbed here instead of being enforced pedantically.
 *
 * What is NOT absorbed is the scheme or the host. http://example.com and
 * https://example.com are different origins and must be listed separately; a
 * cookie sent to the wrong one is a cookie sent in the clear.
 */
function normaliseOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * On Vercel the deployment's own addresses are known at runtime
 * (VERCEL_PROJECT_PRODUCTION_URL, VERCEL_BRANCH_URL, VERCEL_URL). They are
 * always allowed, so production and preview deployments work without anyone
 * typing their address into CORS_ORIGINS first.
 */
const vercelOrigins = [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_URL]
  .filter((host): host is string => Boolean(host))
  .map((host) => normaliseOrigin(`https://${host}`));

const corsOrigins = Array.from(new Set([...raw.CORS_ORIGINS.split(",").map(normaliseOrigin).filter(Boolean), ...vercelOrigins]));

// Links in emails and on passports: an explicit PUBLIC_APP_URL wins; otherwise
// the Vercel production address; otherwise the local default.
const publicAppUrl =
  process.env.PUBLIC_APP_URL?.trim() ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : raw.PUBLIC_APP_URL);

// A sandbox OTP that prints itself is a demo convenience and a production hole.
const otpEcho = raw.NODE_ENV === "production" ? false : raw.OTP_ECHO_IN_RESPONSE;

const smtpConfigured = Boolean(raw.SMTP_HOST && raw.SMTP_USER && raw.SMTP_PASSWORD);

/**
 * Which way email leaves this process, decided once.
 *
 * An HTTP provider wins over SMTP when both are configured, because the only
 * reason to configure one is that SMTP does not work here — every container host
 * worth naming blocks outbound port 587.
 */
const httpMailProvider: "resend" | "brevo" | null =
  raw.EMAIL_TRANSPORT === "smtp"
    ? null
    : raw.EMAIL_TRANSPORT === "resend"
      ? (raw.RESEND_API_KEY ? "resend" : null)
      : raw.EMAIL_TRANSPORT === "brevo"
        ? (raw.BREVO_API_KEY ? "brevo" : null)
        : raw.BREVO_API_KEY
          ? "brevo"
          : raw.RESEND_API_KEY
            ? "resend"
            : null;

// A sender address is needed either way. SMTP can fall back to the account it
// authenticates as; an HTTP provider cannot, so it has to be stated.
const emailConfigured = Boolean(httpMailProvider ? raw.SMTP_FROM : smtpConfigured);

export const env = {
  ...raw,
  PUBLIC_APP_URL: publicAppUrl,
  corsOrigins,
  normaliseOrigin,
  /**
   * Whether this origin may send credentialed requests.
   *
   * Exact match after normalisation, with one opt-in exception: a configured
   * entry may name a single wildcard subdomain, as in https://*.vercel.app, which
   * is how a preview deployment gets in without relisting every generated URL.
   * It is deliberately opt-in and warned about at boot, because it widens the set
   * of sites that may make credentialed requests to everything on that domain.
   */
  isOriginAllowed(origin: string): boolean {
    const candidate = normaliseOrigin(origin);
    return corsOrigins.some((allowed) => {
      if (allowed === candidate) return true;
      if (!allowed.includes("*")) return false;
      const pattern = new RegExp(
        "^" + allowed.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^.]+") + "$"
      );
      return pattern.test(candidate);
    });
  },
  otpEcho,
  isProduction: raw.NODE_ENV === "production",
  confirmationDepth:
    raw.CONFIRMATION_DEPTH ?? (["localhost", "hardhat"].includes(raw.CHAIN_NETWORK) ? 1 : 3),
  cookieSecure: raw.NODE_ENV === "production" || raw.COOKIE_SAMESITE === "none",
  localBlobDir: path.resolve(process.cwd(), raw.LOCAL_BLOB_DIR),
  // One secret is enough for a demo; a deployment should set its own.
  loginChallengeSecret: raw.LOGIN_CHALLENGE_SECRET ?? raw.AADHAAR_TOKEN_PEPPER,
  // Convenience mirror of capabilities.emailNotifications, so services can ask
  // env one question instead of importing two modules.
  emailNotificationsEnabled: emailConfigured && raw.EMAIL_NOTIFICATIONS_ENABLED,
};

export type Env = typeof env;

/** What is wired up, for /api/health and the admin dashboard. */
export const capabilities = {
  cron: Boolean(raw.CRON_SECRET),
  chain: Boolean(raw.CHAIN_RPC_URL && raw.CHAIN_PRIVATE_KEY),
  ipfs: Boolean(raw.PINATA_JWT || (raw.PINATA_API_KEY && raw.PINATA_API_SECRET)),
  ai: Boolean(raw.AI_SERVICE_URL),
  smtp: smtpConfigured,
  /** "resend", "brevo", or "smtp" when sending over SMTP, or null when it cannot send. */
  emailTransport: emailConfigured ? (httpMailProvider ?? "smtp") : null,
  httpMailProvider,
  otpProvider: raw.OTP_PROVIDER,
  // Asking for email MFA with no way to send would lock every account out, so
  // the requirement is the AND of the two.
  loginOtp: emailConfigured && raw.LOGIN_OTP_ENABLED,
  emailNotifications: emailConfigured && raw.EMAIL_NOTIFICATIONS_ENABLED,
};
