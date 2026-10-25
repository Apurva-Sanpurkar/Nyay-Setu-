import "./env";
import { AddressInfo } from "net";
import { Server } from "http";
import { randomUUID } from "crypto";
import { app } from "../../src/app";
import { memoryDatabase } from "../../src/lib/memoryDb";
import { hashSessionToken, randomToken, aadhaarToken, verhoeffCheckDigit } from "../../src/lib/crypto";
import type { UserRole } from "../../src/middleware/auth";

export const ROLES: UserRole[] = [
  "police",
  "forensic_lab",
  "prosecutor",
  "judge",
  "defence_lawyer",
  "accused",
  "court_admin",
];

export const mem = memoryDatabase();

let server: Server | null = null;
let base = "";

/** Starts the real Express app on an ephemeral port. */
export async function startServer(): Promise<string> {
  if (server) return base;
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return base;
}

export async function stopServer(): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
}

let aadhaarCounter = 100_000_000;

/** A valid-looking Aadhaar number (first digit 2-9, Verhoeff check digit). */
export function fakeAadhaar(): string {
  const prefix = `2${String(aadhaarCounter++).padStart(10, "0")}`;
  return prefix + verhoeffCheckDigit(prefix);
}

export interface Actor {
  id: string;
  role: UserRole;
  name: string;
  token: string;
  csrf: string;
  aadhaarToken: string;
}

/** Creates a user and a live session for them, directly in the memory database. */
export function makeActor(role: UserRole, overrides: { name?: string; active?: boolean } = {}): Actor {
  const id = randomUUID();
  const name = overrides.name ?? `${role} ${id.slice(0, 4)}`;
  mem.table("users").push({
    id,
    email: `${role}.${id.slice(0, 8)}@example.invalid`,
    password_hash: "x",
    full_name: name,
    role,
    designation: null,
    station_or_court: role === "police" ? "Shivajinagar PS" : "District Court, Pune",
    theme: "light",
    is_active: overrides.active ?? true,
    must_change_password: false,
    created_at: new Date().toISOString(),
  });

  const token = randomToken(32);
  const csrf = randomToken(24);
  mem.table("sessions").push({
    id: randomUUID(),
    user_id: id,
    token_hash: hashSessionToken(token),
    csrf_token: csrf,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    revoked_at: null,
    created_at: new Date().toISOString(),
  });

  const tokenValue = aadhaarToken(fakeAadhaar());
  mem.table("user_pii").push({ user_id: id, aadhaar_token: tokenValue, aadhaar_last4: "1234" });

  return { id, role, name, token, csrf, aadhaarToken: tokenValue };
}

export function assign(actor: Actor, caseId: string, access: "read" | "write" = "write"): void {
  mem.table("case_assignments").push({
    id: randomUUID(),
    case_id: caseId,
    user_id: actor.id,
    access,
    assigned_by: actor.id,
    created_at: new Date().toISOString(),
  });
}

export interface CallOptions {
  body?: unknown;
  form?: FormData;
  /** Omit the CSRF header, to test that mutations refuse without it. */
  noCsrf?: boolean;
  headers?: Record<string, string>;
}

export interface CallResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
  raw: ArrayBuffer;
}

/** One HTTP call as `actor` (or anonymously when actor is null). */
export async function call<T = any>(
  actor: Actor | null,
  method: string,
  path: string,
  options: CallOptions = {}
): Promise<CallResult<T>> {
  const root = await startServer();
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (actor) headers.cookie = `nyaysetu_session=${actor.token}`;
  if (actor && method !== "GET" && !options.noCsrf) headers["x-csrf-token"] = actor.csrf;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${root}${path}`, {
    method,
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
  const raw = await response.arrayBuffer();
  const text = Buffer.from(raw).toString("utf8");
  let body: any = text;
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    body = text ? JSON.parse(text) : null;
  }
  return { status: response.status, body, headers: response.headers, raw };
}

/** Clears every table between tests. Users created before reset are gone too. */
export function resetDatabase(): void {
  mem.reset();
}
