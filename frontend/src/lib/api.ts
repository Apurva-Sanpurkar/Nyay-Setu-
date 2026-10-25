/**
 * The only place the app talks to the network.
 *
 * Three things it guarantees, so no component has to remember them:
 *   1. credentials: "include", because auth is an HttpOnly cookie
 *   2. the X-CSRF-Token header on every mutating request, read from the
 *      double-submit cookie
 *   3. a typed ApiError with the server's code and message, so a UI can say
 *      "the hash did not match" instead of "request failed"
 */

const BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const CSRF_COOKIE = "nyaysetu_csrf";

/**
 * Where requests are actually going, for the diagnostics below.
 *
 * Blank BASE is correct in development, where Vite proxies /api to the API, and
 * is almost always a mistake in a deployed build: the request then goes to the
 * static host, which answers a rewrite rule with index.html, and the app gets
 * HTML where it expected JSON.
 */
export const apiOrigin = BASE || window.location.origin;
export const apiBaseConfigured = BASE !== "";

/**
 * Whether this page is being served from somewhere other than a developer's
 * machine.
 *
 * Read from the hostname at runtime, not from import.meta.env.PROD. That flag is
 * decided by the build's mode, and a hosting dashboard with NODE_ENV=development
 * set on it produces a deployed bundle that believes it is running locally — which
 * is exactly how this came to be written, after a live site told somebody to check
 * that the backend was running on port 4000.
 *
 * The hostname cannot be misconfigured into lying about this.
 */
export const isDeployedBuild = !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(
  window.location.hostname
);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get isAuth() {
    return this.status === 401;
  }
  get isForbidden() {
    return this.status === 403;
  }
  /** True when the blockchain, IPFS or the model service is not configured. */
  get isUnavailable() {
    return this.status === 503;
  }

  /**
   * True when the API was not reachable at all, as opposed to reaching it and
   * being refused. These are the two cases that look identical to a user and
   * have completely different causes, so they are separated here rather than in
   * every component.
   */
  get isUnreachable() {
    return (
      this.status === 0 ||
      this.code === "NETWORK" ||
      this.code === "TIMEOUT" ||
      this.code === "BAD_RESPONSE"
    );
  }

  /** True when the API accepted the connection and then said nothing. */
  get isTimeout() {
    return this.code === "TIMEOUT";
  }
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * The CSRF token, held in memory.
 *
 * It used to be read from the nyaysetu_csrf cookie on every request, which works
 * only while the site and the API share an origin. Deployed, they do not: the
 * cookie is set by the API's domain, and script on the site's domain cannot read a
 * cookie belonging to another one. document.cookie returned nothing, no header was
 * sent, and every mutating request was refused with CSRF_MISSING — sign-in worked,
 * because it is unauthenticated, and then nothing else did.
 *
 * The API returns the token in the body of /api/auth/me and of both sign-in steps,
 * and compares the header against the token bound to the session row rather than
 * against the cookie. So holding it here is not a workaround: it is the only source
 * that works in both deployments, and the server's comparison is unaffected.
 *
 * In memory rather than in storage, deliberately. It dies with the tab, as a
 * session token should, and there is no copy for a script to steal.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null | undefined): void {
  if (token) csrfToken = token;
}

export function clearCsrfToken(): void {
  csrfToken = null;
}

/** The value for an X-CSRF-Token header, for the few requests made without request(). */
export function csrfHeaderValue(): string | null {
  return csrfToken ?? readCookie(CSRF_COOKIE);
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface Options {
  method?: Method;
  body?: unknown;
  /** FormData bypasses JSON encoding so the browser sets the multipart boundary. */
  form?: FormData;
  signal?: AbortSignal;
  /** Set for endpoints that stream a file rather than JSON. */
  raw?: boolean;
  /** Overrides the default deadline. Uploads and PDFs need longer. */
  timeoutMs?: number;
  /** Extra headers, e.g. Idempotency-Key on a chain-writing request. */
  headers?: Record<string, string>;
}

/**
 * How long to wait before deciding the API is not going to answer.
 *
 * fetch has no timeout of its own: a request to a host that accepts the
 * connection and then says nothing waits until the browser gives up, which can be
 * minutes. That is how "Restoring your session…" became a screen somebody sat in
 * front of indefinitely — a free-tier API asleep behind a cold start accepts the
 * connection and takes half a minute to wake, and the SPA had nothing to show but
 * the spinner it started with.
 *
 * Twenty seconds is chosen against that cold start: long enough that a waking
 * instance usually answers inside it, short enough that a genuinely dead API is
 * reported rather than waited on. A file upload gets longer, because the deadline
 * is for a silent server and not for a slow one.
 */
const DEFAULT_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 120_000;

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(options.headers ?? {}) };

  if (method !== "GET") {
    // Memory first. The cookie is a fallback for a same-origin deployment, where
    // it is readable and may be fresher than a token from an earlier page load.
    const csrf = csrfToken ?? readCookie(CSRF_COOKIE);
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  if (options.body !== undefined && !options.form) {
    headers["content-type"] = "application/json";
  }

  // The caller's own signal still aborts, and so does the deadline. Whichever
  // fires first wins, and the deadline is always cleared so a slow-but-successful
  // response does not leave a timer running.
  const controller = new AbortController();
  const deadline = options.timeoutMs ?? (options.form ? UPLOAD_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const timer = window.setTimeout(() => controller.abort(new DOMException("timeout", "TimeoutError")), deadline);

  const onCallerAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: "include",
      signal: controller.signal,
      body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  } catch (caught) {
    // A deadline that fired is not the same as a caller who navigated away. The
    // first is worth reporting; the second must stay an AbortError so the
    // component that cancelled it can ignore it.
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new ApiError(0, "TIMEOUT", timeoutMessage(deadline));
    }
    // fetch rejects for a blocked CORS response, a DNS failure, a refused
    // connection and an offline browser, and gives the same opaque TypeError for
    // all of them by design. So the message says what to check rather than
    // pretending to know which one it was.
    if (caught instanceof DOMException && caught.name === "AbortError") throw caught;
    throw new ApiError(0, "NETWORK", networkFailureMessage());
  } finally {
    window.clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }

  if (options.raw) {
    if (!response.ok) throw await toError(response);
    return response as unknown as T;
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // HTML where JSON was expected has one overwhelmingly likely cause: the
    // request went to the static host instead of the API, and a catch-all rewrite
    // answered it with index.html. Saying so is worth more than the first 200
    // characters of a document.
    const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
    payload = {
      error: {
        code: "BAD_RESPONSE",
        message: looksLikeHtml ? htmlInsteadOfJsonMessage() : text.slice(0, 200),
      },
    };
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? "UNKNOWN",
      error.message ?? `Request failed with ${response.status}.`,
      error.details
    );
  }

  return payload as T;
}

/**
 * Why nothing came back within the deadline.
 *
 * Distinguished from a refused connection on purpose: a silent server is nearly
 * always a cold start or a stalled instance, and telling somebody to check their
 * CORS settings when the API is merely asleep wastes their time.
 */
function timeoutMessage(deadline: number): string {
  const seconds = Math.round(deadline / 1000);
  if (isDeployedBuild) {
    return (
      `${apiOrigin} accepted the connection but sent nothing back within ${seconds} seconds. ` +
      "On a free hosting tier the API sleeps when idle and can take up to a minute to wake, so " +
      "this often clears on a second attempt. If it does not, the instance is stalled."
    );
  }
  return (
    `The API did not respond within ${seconds} seconds. It is running but not answering — check ` +
    "its log for a request that never finished."
  );
}

/** Why a request never reached the API, in the order worth checking. */
function networkFailureMessage(): string {
  if (isDeployedBuild && !apiBaseConfigured) {
    return (
      "This build has no API address, so requests are going to the site itself. " +
      "Set VITE_API_BASE to the API's URL in the hosting dashboard and redeploy."
    );
  }
  if (isDeployedBuild) {
    return (
      `Could not reach the NyaySetu API at ${apiOrigin}. Either it is asleep or down, ` +
      "or its CORS_ORIGINS does not list this site's address — a cross-origin " +
      "request is blocked before it reaches a route, which looks identical to the " +
      "API being offline."
    );
  }
  return "Could not reach the NyaySetu API. Check that the backend is running on port 4000.";
}

function htmlInsteadOfJsonMessage(): string {
  return apiBaseConfigured
    ? `${apiOrigin} answered with a web page instead of data. That address is serving a site, not the NyaySetu API.`
    : "The API address is not set, so requests are hitting this site and getting its HTML back. Set VITE_API_BASE to the API's URL and redeploy.";
}

async function toError(response: Response): Promise<ApiError> {
  const text = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    return new ApiError(
      response.status,
      parsed?.error?.code ?? "UNKNOWN",
      parsed?.error?.message ?? "Request failed.",
      parsed?.error?.details
    );
  } catch {
    return new ApiError(response.status, "UNKNOWN", text.slice(0, 200) || "Request failed.");
  }
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData, headers?: Record<string, string>) =>
    request<T>(path, { method: "POST", form, headers }),
  download: (path: string) => request<Response>(path, { raw: true }),
};

/* ------------------------------------------------------------------ types */

export type Role =
  | "police"
  | "forensic_lab"
  | "prosecutor"
  | "judge"
  | "defence_lawyer"
  | "accused"
  | "court_admin";

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  designation: string | null;
  stationOrCourt: string | null;
  theme: "dark" | "light";
  hasAadhaarToken?: boolean;
  /**
   * True while the account still holds the temporary password from its
   * invitation. The API refuses every route except changing it, so the router
   * sends these users to /first-run and nowhere else.
   */
  mustChangePassword?: boolean;
}

/**
 * One citation on an FIR, as the API reads it against the criminal code.
 *
 * `recognised` false is not an error: a real charge sheet cites the Sanhita and
 * special legislation together, and the NDPS or POCSO sections are kept exactly as
 * written rather than refused.
 */
export interface ParsedSection {
  raw: string;
  canonical: string;
  act: string | null;
  section: number | null;
  subsection: string | null;
  title: string | null;
  chapter: string | null;
  severity: number | null;
  maxPunishment: string | null;
  recognised: boolean;
}

export interface StatuteSummary {
  references: ParsedSection[];
  recognised: number;
  unrecognised: string[];
  /** Gravest punishment any cited section states, 1-10. Null means unknown, not mild. */
  severity: number | null;
  severityFrom: string | null;
  caveat: string | null;
}

export type Stage = "SCENE" | "FORENSIC_LAB" | "PROSECUTOR" | "COURT";
export type SummonsStatus = "PENDING" | "DELIVERED" | "FAILED";

export interface CaseRow {
  id: string;
  case_reference: string;
  /** 2.0: role-gated; the number is present only for police, prosecution, court and registry. */
  fir: FirView;
  origin?: "fir" | "complaint" | "court" | "other";
  case_key_scheme?: "fir_v1" | "salted_v2";
  case_id_hash: string;
  title: string;
  offence_type: string;
  sections: string[];
  police_station: string;
  court_name: string | null;
  status: string;
  registered_at: string;
  summary?: string | null;
  access?: "read" | "write";
}

export interface EvidenceRow {
  id: string;
  case_id: string;
  chain_evidence_id: number | null;
  file_hash: string;
  anchored_digest?: string;
  anchor_mode?: "file" | "manifest";
  source?: "upload" | "capture";
  public_ref?: string;
  capture_purpose?: string;
  gps_status?: string | null;
  gps_accuracy_m?: number | null;
  signature_status?: string;
  clock_skew_flagged?: boolean;
  device_time?: string | null;
  duration_ms?: number | null;
  verification?: Verification;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  kind: string;
  current_stage: Stage;
  collected_at: string;
  gps_lat: number | null;
  gps_lng: number | null;
  anomaly_flagged: boolean;
  anomaly_score: number | null;
  anomaly_reasons: string[];
  anomaly_flag_hash: string | null;
  forensic_report_hash: string | null;
  mismatch_count: number;
  registration_tx_hash: string | null;
  notes?: string | null;
  cases?: { case_reference: string; title: string };
}

export interface CustodyEventRow {
  id: string;
  from_stage: Stage | null;
  to_stage: Stage;
  confirmed_hash: string;
  actor_role: Role | null;
  occurred_at: string;
  tx_hash: string | null;
  block_number: number | null;
}

export interface SummonsRow {
  id: string;
  case_id: string;
  chain_summons_id: number | null;
  recipient_name: string;
  status: SummonsStatus;
  issued_at: string;
  expiry_at: string;
  delivered_at: string | null;
  hearing_at: string | null;
  document_hash: string;
  document_body?: string;
  issue_tx_hash?: string | null;
  ack_tx_hash?: string | null;
  non_delivery_alerted_at?: string | null;
  effectiveStatus?: SummonsStatus;
  hoursRemaining?: number;
  cases?: { case_reference: string; title: string; court_name?: string | null };
}

export interface ComplianceLive {
  score: number;
  flags: boolean[];
  overdue: boolean;
  secondsUntilNextCheckIn: number;
}

export interface BailRow {
  id: string;
  case_id: string;
  accused_name: string;
  conditions: string[];
  condition_tags: string[];
  centre_lat: number | null;
  centre_lng: number | null;
  radius_metres: number;
  checkin_interval_seconds: number;
  expiry_at: string;
  active: boolean;
  compliance_score: number | null;
  risk_band: "LOW" | "MEDIUM" | "HIGH" | null;
  risk_score: number | null;
  order_text?: string | null;
  surety_name?: string | null;
  live?: ComplianceLive | null;
  openViolations?: number;
  state?: "compliant" | "breach" | "unknown";
  cases?: { case_reference: string; title?: string; case_id_hash?: string };
}

export interface ViolationRow {
  id: string;
  kind: string;
  reason: string;
  detected_at: string;
  acknowledged_at: string | null;
  tx_hash: string | null;
}

export interface CheckInRow {
  id: string;
  gps_lat?: number;
  gps_lng?: number;
  distance_metres: number | null;
  within_fence: boolean;
  occurred_at: string;
  tx_hash: string | null;
}

export interface OtpDispatch {
  challengeId: string;
  expiresAt: string;
  maskedDestination: string;
  /** Sandbox provider only, so the demo needs no SMS gateway. */
  otp?: string;
}

export interface ChainInfo {
  txHash: string;
  blockNumber?: number;
  explorer: string | null;
}

export interface HealthResponse {
  status: string;
  environment: string;
  subsystems: {
    database: { reachable: boolean };
    blockchain: {
      configured: boolean;
      ready: boolean;
      reason: string;
      network: { name: string; chainId: number } | null;
      blockNumber: number | null;
      keeper: string | null;
      keeperBalanceWei: string | null;
      addresses: Record<string, string | undefined> | null;
    };
    storage: { backend: string; configured: boolean; note?: string };
    ai: { configured: boolean; reachable: boolean; note?: string };
    identity: { provider: string; authorisedForProduction: boolean; note?: string };
  };
}

/* ------------------------------------------------------------- 2.0 types */

export type VerificationState =
  | "LOCAL_ONLY"
  | "SUBMITTED"
  | "CONFIRMED"
  | "INTEGRITY_MISMATCH"
  | "SYNC_ERROR"
  | "REVIEW_REQUIRED";

/** The verification block every 2.0 evidence response carries. */
export interface Verification {
  anchorId?: string | null;
  state: VerificationState;
  label: string;
  /** True only for CONFIRMED. Nothing else is ever shown as verified. */
  verified: boolean;
  txHash: string | null;
  explorer: string | null;
  blockNumber: number | null;
  confirmations: number;
  requiredConfirmations: number;
  failureCode: string | null;
  failureReason: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  lastCheckedAt: string | null;
}

export interface StateHistoryRow {
  from_state: VerificationState | null;
  to_state: VerificationState;
  reason_code: string;
  reason: string | null;
  actor_role: string | null;
  occurred_at: string;
}

export interface FirView {
  linked: boolean;
  number?: string;
  year?: number;
  date?: string | null;
  policeStation?: string;
  district?: string | null;
  backfilled?: boolean;
}

export interface PublicCustodyEvent {
  type: "REGISTERED" | "CUSTODY_TRANSFER";
  from: string | null;
  to: string;
  at: string;
  source: "chain" | "record";
}

export interface PublicPassport {
  reference: string;
  source: "capture" | "upload";
  anchorMode: "file" | "manifest";
  locationCommitted: boolean;
  digest: string | null;
  digestSource: "chain" | "record";
  registeredAt: string | null;
  network: { name: string; chainId: number } | null;
  transaction: { hash: string | null; explorer: string | null; block: number | null };
  state: VerificationState;
  verified: boolean;
  explanation: { heading: string; text: string };
  agreement: "AGREES" | "DISAGREES" | "UNKNOWN";
  flags: string[];
  custody: PublicCustodyEvent[];
  limits: string;
  checkedAt: string;
}

export interface FileCheckResult {
  matched: boolean;
  comparedAgainst: "chain";
  anchorMode: "file" | "manifest";
  fileMatchesRecordedManifest: boolean | null;
  explanation: string;
}

export interface CaptureDetail {
  source: string;
  purpose: string;
  kind: string;
  mimeType: string | null;
  sizeBytes: number | null;
  fileSha256: string;
  manifestHash: string | null;
  deviceTime: string | null;
  serverReceivedAt: string | null;
  clockSkewSeconds: number | null;
  clockSkewFlagged: boolean;
  gps: { status: string | null; accuracyMetres: number | null; mocked: boolean | null; lat: number | null; lng: number | null };
  signatureStatus: string;
  durationMs: number | null;
  deviceId: string | null;
  appVersion: string | null;
  manifest: unknown;
}

export interface TimelineEntry {
  id: string;
  at: string;
  action: string;
  label: string;
  actorRole: string | null;
  outcome: "ok" | "refused" | "failed";
  subject: string | null;
  detail: Record<string, unknown>;
}
