/**
 * Creates the one account the system cannot create for itself.
 *
 *   cd backend && npm run bootstrap
 *
 * Every other account on NyaySetu is created by a court administrator from
 * /admin and invited by email. That leaves exactly one problem: the first
 * administrator has nobody to invite them. This script is the answer, and it is
 * the only place in the codebase that writes a privileged account directly.
 *
 * WHY THERE IS NO DEMO CAST
 *   An earlier version seeded eight accounts sharing one password. That is
 *   convenient and it is also a permanent back door: the password is in the
 *   repository, the addresses are predictable, and every clone of the project
 *   ships with seven ways in. A court is a closed institution, so the platform
 *   models it as one: somebody with authority decides who is a judge.
 *
 * WHY THE PASSWORD IS PRINTED, NOT EMAILED
 *   Whoever runs this owns the terminal, the database credentials and the
 *   Aadhaar pepper already. Printing it here adds no exposure, and it means the
 *   first sign-in works even before SMTP is configured. Invited accounts are the
 *   opposite case: their password travels by email, so it is single-use.
 *
 * Idempotent. Re-running against an existing address rotates its password and
 * repairs its role rather than creating a second administrator.
 */
import bcrypt from "bcryptjs";
import { db, unwrapMaybe } from "../lib/supabase";
import { generateTemporaryPassword } from "../lib/crypto";
import { invitationsReady } from "../lib/schema";
import { env } from "../config/env";

interface Existing {
  id: string;
  email: string;
  role: string;
  is_active: boolean;
}

function argOf(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function rule(): void {
  console.log("  " + "─".repeat(66));
}

async function main(): Promise<void> {
  const email = (argOf("--email") ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const fullName = (argOf("--name") ?? process.env.BOOTSTRAP_ADMIN_NAME ?? "Court Administrator").trim();
  const court = (argOf("--court") ?? process.env.BOOTSTRAP_ADMIN_COURT ?? "District & Sessions Court, Pune").trim();

  if (!email || !email.includes("@")) {
    console.error(
      [
        "",
        "  No address to create the administrator with.",
        "",
        "  Set BOOTSTRAP_ADMIN_EMAIL in backend/.env, or pass it directly:",
        "    npm run bootstrap -- --email you@example.com --name \"Your Name\"",
        "",
        "  Use a mailbox you can actually read: every sign-in sends a six digit",
        "  code to this address, so an unreachable one locks you out.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  // A password given on the command line is honoured; otherwise one is generated.
  const supplied = argOf("--password") ?? process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const password = supplied && supplied.length >= 12 ? supplied : generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(password, 12);

  const invitations = await invitationsReady();

  const existing = unwrapMaybe(
    await db.from("users").select("id, email, role, is_active").ilike("email", email).maybeSingle()
  ) as Existing | null;

  // The administrator's own password is never in transit, so it is not marked
  // single-use the way an invited one is. Rotating it is a choice, not a gate.
  const shared = {
    password_hash: passwordHash,
    full_name: fullName,
    role: "court_admin" as const,
    station_or_court: court,
    is_active: true,
    failed_login_attempts: 0,
    locked_until: null,
    mfa_email_enabled: true,
    ...(invitations ? { must_change_password: false } : {}),
  };

  let action: "created" | "repaired";

  if (existing) {
    const { error } = await db.from("users").update(shared).eq("id", existing.id);
    if (error) throw new Error(`Could not update the existing account: ${error.message}`);
    action = "repaired";
  } else {
    const { error } = await db.from("users").insert({ email, designation: "Registrar", ...shared });
    if (error) throw new Error(`Could not create the account: ${error.message}`);
    action = "created";
  }

  const { count } = await db
    .from("users")
    .select("*", { count: "exact", head: true })
    .eq("role", "court_admin")
    .eq("is_active", true);

  console.log("");
  rule();
  console.log(`  Court administrator ${action}.`);
  rule();
  console.log(`  Portal      ${env.PUBLIC_APP_URL}/admin`);
  console.log(`  Email       ${email}`);
  console.log(`  Password    ${password}`);
  rule();
  console.log("  Signing in takes two steps: this password, then a six digit code");
  console.log(`  emailed to ${email}.`);

  if (!env.emailNotificationsEnabled) {
    console.log("");
    console.log("  SMTP is not configured, so no code can be sent. Either fill in");
    console.log("  SMTP_HOST / SMTP_USER / SMTP_PASSWORD in backend/.env, or set");
    console.log("  LOGIN_OTP_ENABLED=false to sign in with the password alone.");
  }

  if (!invitations) {
    console.log("");
    console.log("  Migration 006_invitations.sql has not been applied. This account");
    console.log("  works, but accounts you create from /admin will not be forced to");
    console.log("  replace their temporary password. Run it in the Supabase SQL editor.");
  }

  console.log("");
  console.log(`  Active administrators: ${count ?? "unknown"}. Everyone else is invited from /admin.`);
  rule();
  console.log("");
}

void main().catch((error) => {
  console.error("\n  Bootstrap failed:", error instanceof Error ? error.message : error, "\n");
  process.exit(1);
});
