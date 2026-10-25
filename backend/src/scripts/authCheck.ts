/**
 * Proves the invite-only sign-in works, end to end, over real HTTP.
 *
 *   npm run auth:check -- <admin-email> <admin-password> <throwaway-address>
 *
 * Twenty-one assertions covering the whole shape of the thing: two-step sign-in,
 * an invitation that is single-use, a gate that refuses every other route until
 * the password is replaced, a rotation that kills whatever was in the previous
 * email, and a database that will not let the last administrator be removed.
 *
 * HOW IT READS THE CODE WITHOUT A MAILBOX
 *   It scans the million possible six digit codes against the stored hash. That
 *   works only because this process holds AADHAAR_TOKEN_PEPPER, which is the key
 *   the hash is keyed with; without it the space is not searchable. So this is an
 *   operator capability, not a weakness in the OTP, and it is the reason the
 *   pepper is the one secret that must never leave the server.
 *
 * NOT A DEMO SEEDER. It creates one account at the address you pass, exercises
 * it, and deletes it. Two real emails are sent, both to addresses you supply, so
 * use a plus-addressed alias of your own mailbox.
 */
import { db } from "../lib/supabase";
import { hashOtp } from "../lib/crypto";
import { scopeFor } from "../otp/SandboxAadhaarProvider";
import { loginSubjectToken } from "../otp";

const BASE = "http://127.0.0.1:4000";

interface Jar {
  cookies: Map<string, string>;
}

function newJar(): Jar {
  return { cookies: new Map() };
}

function cookieHeader(jar: Jar): string {
  return [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorb(jar: Jar, response: Response): void {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (value === "" || value === "null") jar.cookies.delete(name);
    else jar.cookies.set(name, value);
  }
}

async function call(
  jar: Jar,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { cookie: cookieHeader(jar) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const csrf = jar.cookies.get("nyaysetu_csrf");
  if (csrf && method !== "GET") headers["x-csrf-token"] = csrf;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(jar, response);
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: response.status, json };
}

/** Scans the 10^6 code space against the stored hash. Under two seconds. */
async function recoverOtp(challengeId: string, userId: string, purpose: string): Promise<string> {
  const { data, error } = await db
    .from("otp_challenges")
    .select("subject_token, reference_id, otp_hash")
    .eq("id", challengeId)
    .single();
  if (error || !data) throw new Error(`Challenge not found: ${error?.message}`);

  const row = data as any;
  const scope = scopeFor(row.subject_token, purpose, row.reference_id);
  void userId;

  for (let n = 0; n < 1_000_000; n++) {
    const candidate = String(n).padStart(6, "0");
    if (hashOtp(candidate, scope) === row.otp_hash) return candidate;
  }
  throw new Error("Could not recover the code.");
}

let failures = 0;
function check(label: string, ok: boolean, note = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${note ? "  — " + note : ""}`);
  if (!ok) failures++;
}

async function signIn(jar: Jar, email: string, password: string) {
  const step1 = await call(jar, "POST", "/api/auth/login", { email, password });
  if (step1.status !== 200) throw new Error(`step 1 failed: ${JSON.stringify(step1.json)}`);
  if (!step1.json.mfaRequired) return step1.json;

  const user = (await db.from("users").select("id").ilike("email", email).single()).data as any;
  const otp = await recoverOtp(step1.json.challengeId, user.id, "login_mfa");
  void loginSubjectToken;

  const step2 = await call(jar, "POST", "/api/auth/login/verify", { otp });
  if (step2.status !== 200) throw new Error(`step 2 failed: ${JSON.stringify(step2.json)}`);
  return step2.json;
}

async function main(): Promise<void> {
  const [adminEmail, adminPassword, inviteEmail] = process.argv.slice(2);

  // No defaults on purpose: this writes to the real database and sends real mail,
  // so it must not be possible to run it by accident.
  if (!adminEmail || !adminPassword || !inviteEmail) {
    console.error(
      [
        "",
        "  Usage:",
        "    npm run auth:check -- <admin-email> <admin-password> <throwaway-address>",
        "",
        "  The third address receives two invitation emails and is deleted at the",
        "  end. A plus-addressed alias of your own mailbox is the right thing:",
        "    npm run auth:check -- you@vit.edu \"PASS-WORD\" you+check@vit.edu",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  console.log("\n  Invite-only sign-in, end to end\n");

  // ------------------------------------------------ 1. the bootstrap admin
  const admin = newJar();
  const session = await signIn(admin, adminEmail, adminPassword);
  check("admin signs in with password + emailed code", session.user?.role === "court_admin");
  check("admin is not forced to change its password", session.user?.mustChangePassword === false);

  const me = await call(admin, "GET", "/api/auth/me");
  check("/me works for the admin", me.status === 200 && me.json.user.role === "court_admin");

  const stats = await call(admin, "GET", "/api/admin/stats");
  check("admin portal data loads", stats.status === 200, `users: ${stats.json?.stats?.activeUsers}`);

  // --------------------------------------------------- 2. invite somebody
  await db.from("users").delete().ilike("email", inviteEmail);

  const created = await call(admin, "POST", "/api/admin/users", {
    email: inviteEmail,
    fullName: "Test Invitee",
    role: "judge",
    designation: "Additional Sessions Judge",
    stationOrCourt: "Court No. 4, Pune",
  });
  check("invitation created", created.status === 201, `delivery: ${created.json?.invitation?.status}`);
  const temporary = created.json?.temporaryPassword as string;
  check("a temporary password was generated", /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(temporary ?? ""), temporary);
  check("it is marked single-use", created.json?.invitation?.forcedChange === true);

  // ------------------------------- 3. the invitee is gated until it changes
  const invitee = newJar();
  const first = await signIn(invitee, inviteEmail, temporary);
  check("invitee signs in with the emailed password", Boolean(first.user));
  check("invitee is told to change it", first.user?.mustChangePassword === true);

  const blocked = await call(invitee, "GET", "/api/cases");
  check(
    "every other route is refused until then",
    blocked.status === 403 && blocked.json?.error?.code === "PASSWORD_CHANGE_REQUIRED",
    `${blocked.status} ${blocked.json?.error?.code}`
  );

  const sameAgain = await call(invitee, "POST", "/api/auth/change-password", {
    currentPassword: temporary,
    newPassword: temporary,
  });
  check("the temporary password cannot be re-set as the permanent one", sameAgain.status === 400);

  const changed = await call(invitee, "POST", "/api/auth/change-password", {
    currentPassword: temporary,
    newPassword: "Reg1stryPass2026",
  });
  check("the password can be changed", changed.status === 200);

  const allowed = await call(invitee, "GET", "/api/cases");
  check("routes open up afterwards", allowed.status === 200, `${allowed.status}`);

  const meNow = await call(invitee, "GET", "/api/auth/me");
  check("the flag is cleared", meNow.json?.user?.mustChangePassword === false);

  // ------------------------------------- 4. the old password is dead
  const stale = newJar();
  const staleAttempt = await call(stale, "POST", "/api/auth/login", {
    email: inviteEmail,
    password: temporary,
  });
  check("the emailed password no longer works", staleAttempt.status === 401);

  // ------------------------------------- 5. re-invite rotates the credential
  const target = (await db.from("users").select("id").ilike("email", inviteEmail).single()).data as any;
  const reinvite = await call(admin, "POST", `/api/admin/users/${target.id}/invite`);
  check("re-invite issues a new password", reinvite.status === 200, reinvite.json?.temporaryPassword);
  const rotated = reinvite.json?.temporaryPassword as string;
  check("it differs from the first one", rotated !== temporary);

  const afterRotation = await call(newJar(), "POST", "/api/auth/login", {
    email: inviteEmail,
    password: "Reg1stryPass2026",
  });
  check("the password it replaced stops working", afterRotation.status === 401);

  // ---------------------------------------------- 6. the OTP limiter holds
  //
  // /login/resend with no pending sign-in is the right endpoint to prove this on:
  // it refuses every call anyway, so nothing is consumed, no account is locked and
  // no challenge is invalidated. Only the limiter's counter moves.
  const limiterJar = newJar();
  const codes: number[] = [];
  for (let attempt = 0; attempt < 7; attempt++) {
    const result = await call(limiterJar, "POST", "/api/auth/login/resend");
    codes.push(result.status);
  }
  check(
    "the OTP limiter refuses a burst",
    codes.includes(429),
    `statuses: ${codes.join(", ")}`
  );

  // ------------------------------------- 7. no demo credentials anywhere
  const config = await call(newJar(), "GET", "/api/auth/config");
  check("the sign-in screen is offered no demo accounts", !("showDemoAccounts" in config.json));

  // ----------------------------------------- 8. the last admin is protected
  const adminRow = (await db.from("users").select("id").ilike("email", adminEmail).single()).data as any;
  const selfOff = await call(admin, "PATCH", `/api/admin/users/${adminRow.id}`, { isActive: false });
  check("an admin cannot deactivate itself", selfOff.status === 409, selfOff.json?.error?.message);

  const demote = await db.from("users").update({ role: "judge" }).eq("id", adminRow.id);
  check(
    "the database refuses to demote the last administrator",
    Boolean(demote.error),
    demote.error?.message?.slice(0, 70)
  );

  // cleanup
  await db.from("users").delete().ilike("email", inviteEmail);

  console.log(`\n  ${failures === 0 ? "All checks passed." : failures + " check(s) failed."}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((error) => {
  console.error("\n  Run failed:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});
