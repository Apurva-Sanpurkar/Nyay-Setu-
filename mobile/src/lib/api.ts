/**
 * The mobile API client.
 *
 * Two differences from the web client, both forced by the platform:
 *
 *   1. React Native has no document.cookie, so the CSRF token cannot be read
 *      from a cookie. The login response returns it, and it is held in memory
 *      for the life of the session. The session cookie itself is still handled
 *      by the native networking stack, so it stays HttpOnly and out of reach of
 *      JavaScript exactly as it is in a browser.
 *
 *   2. Uploads use the { uri, name, type } form React Native understands, so the
 *      file is streamed from disk rather than read into memory first.
 */

const BASE = (process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://10.0.2.2:4000").replace(/\/$/, "");

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
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

export function apiBaseUrl() {
  return BASE;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function request<T>(
  path: string,
  options: { method?: Method; body?: unknown; form?: FormData; headers?: Record<string, string> } = {}
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(options.headers ?? {}) };

  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  if (options.body !== undefined && !options.form) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: "include",
      body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
  } catch (error) {
    throw new ApiError(
      0,
      "NETWORK",
      `Cannot reach the NyaySetu API at ${BASE}. On an Android emulator use 10.0.2.2; ` +
        "on a physical phone use your laptop's LAN address and add it to CORS_ORIGINS."
    );
  }

  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
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

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  upload: <T>(path: string, form: FormData, headers?: Record<string, string>) => request<T>(path, { method: "POST", form, headers }),
};

/* ------------------------------------------------------------------ types */

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: string;
  designation: string | null;
  hasAadhaarToken?: boolean;
  /**
   * True while the account still holds the temporary password from its
   * invitation. The API refuses every route except changing it, and this app has
   * no screen for that, so sign-in stops here and points at the web portal.
   */
  mustChangePassword?: boolean;
}

export interface CaseRow {
  id: string;
  case_reference: string;
  title: string;
  offence_type: string;
  access?: "read" | "write";
}

export interface BailOrder {
  id: string;
  case_id: string;
  conditions: string[];
  centre_lat: number | null;
  centre_lng: number | null;
  radius_metres: number;
  checkin_interval_seconds: number;
  expiry_at: string;
  compliance_score: number | null;
  cases?: { case_reference: string; title?: string };
  live?: {
    score: number;
    overdue: boolean;
    secondsUntilNextCheckIn: number;
  } | null;
}

export interface OtpDispatch {
  challengeId: string;
  expiresAt: string;
  maskedDestination: string;
  otp?: string;
}

/**
 * Sign-in is deliberately NOT wrapped in a helper here.
 *
 * It is a two-step exchange when the deployment requires an emailed code, and a
 * helper that returned a User would have to either hide that or lie about it.
 * LoginScreen drives both steps directly, so the branch is visible where it
 * matters. See POST /api/auth/login and /api/auth/login/verify.
 */

export async function whoAmI(): Promise<User | null> {
  try {
    const result = await api.get<{ user: User; csrfToken: string }>("/api/auth/me");
    setCsrfToken(result.csrfToken);
    return result.user;
  } catch {
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await api.post("/api/auth/logout");
  } finally {
    setCsrfToken(null);
  }
}
