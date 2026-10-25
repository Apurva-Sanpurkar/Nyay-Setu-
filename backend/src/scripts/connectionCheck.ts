/**
 * Checks every external credential before anything else is attempted.
 *
 *   cd backend && npm run check
 *
 * Exists because the failure modes are all silent-looking: a wrong Supabase key
 * returns an HTTP error buried in a query, an App Password that is really an
 * account password fails only on the first real send, and a missing migration
 * looks identical to an empty database. Each check here reports what is wrong
 * and what to do about it, rather than leaving you to infer it from a stack
 * trace three layers down.
 */
import { env, capabilities } from "../config/env";
import { db } from "../lib/supabase";
import { verifyTransport, maskEmail } from "../lib/mailer";
import { initChain, chain } from "../lib/chain";
import { piiAccessReady } from "../lib/pii";

const PASS = "  [ok]   ";
const WARN = "  [--]   ";
const FAIL = "  [!!]   ";

let failures = 0;
let warnings = 0;

function ok(label: string, detail?: string) {
  console.log(PASS + label + (detail ? `  ${detail}` : ""));
}
function warn(label: string, detail?: string) {
  warnings += 1;
  console.log(WARN + label + (detail ? `  ${detail}` : ""));
}
function fail(label: string, detail?: string) {
  failures += 1;
  console.log(FAIL + label + (detail ? `  ${detail}` : ""));
}

/** Tables the app cannot run without, in the order the migrations create them. */
const REQUIRED_TABLES = [
  ["roles", "001_schema.sql"],
  ["users", "001_schema.sql"],
  ["sessions", "001_schema.sql"],
  ["cases", "001_schema.sql"],
  ["case_assignments", "001_schema.sql"],
  ["evidence_items", "001_schema.sql"],
  ["custody_events", "001_schema.sql"],
  ["summons", "001_schema.sql"],
  ["bail_conditions", "001_schema.sql"],
  ["checkins", "001_schema.sql"],
  ["violations", "001_schema.sql"],
  ["chain_tx", "001_schema.sql"],
  ["audit_log", "001_schema.sql"],
  ["action_log", "001_schema.sql"],
  ["otp_challenges", "004_otp_channels.sql"],
  ["email_log", "004_otp_channels.sql"],
] as const;

async function checkDatabase() {
  console.log("\nSUPABASE");
  console.log(`  url: ${env.SUPABASE_URL}`);

  const { error } = await db.from("roles").select("role").limit(1);

  if (error) {
    const message = error.message ?? String(error);

    if (/invalid api key|jwt|unauthorized|401/i.test(message)) {
      fail("credentials rejected", message);
      console.log("         Use the service_role / secret key, not the anon key.");
      console.log("         Supabase -> Settings -> API");
      return false;
    }
    if (/does not exist|relation|schema cache|PGRST205/i.test(message)) {
      fail("connected, but the schema is missing", message.slice(0, 120));
      console.log("         Run these in the Supabase SQL editor, in order:");
      console.log("           database/migrations/001_schema.sql");
      console.log("           database/migrations/002_rls.sql");
      console.log("           database/migrations/003_audit.sql");
      console.log("           database/migrations/004_otp_channels.sql");
      console.log("           database/seed/reference.sql");
      return false;
    }
    if (/fetch failed|ENOTFOUND|getaddrinfo/i.test(message)) {
      fail("host unreachable", message);
      console.log("         Check SUPABASE_URL and your network.");
      return false;
    }
    fail("query failed", message);
    return false;
  }

  ok("connected and authenticated");

  // Which tables actually exist decides whether a migration was skipped.
  const missing: string[] = [];
  for (const [table, source] of REQUIRED_TABLES) {
    const probe = await db.from(table).select("*", { head: true, count: "exact" }).limit(1);
    if (probe.error) missing.push(`${table} (${source})`);
  }

  if (missing.length > 0) {
    fail(`${missing.length} table(s) missing`);
    for (const entry of missing) console.log(`         ${entry}`);
    return false;
  }
  ok(`all ${REQUIRED_TABLES.length} required tables present`);

  // PII is reached through SECURITY DEFINER functions rather than an exposed
  // schema, so what matters is whether migration 005 ran.
  const pii = await piiAccessReady();
  if (!pii.ok) {
    fail("PII access functions are missing", pii.error?.slice(0, 120));
    console.log("         Run database/migrations/005_pii_access.sql in the SQL editor.");
    console.log("         It replaces the old requirement to expose the `restricted` schema.");
    return false;
  }
  ok("PII access functions present", "no exposed schema needed");

  const roles = await db.from("roles").select("role");
  const count = roles.data?.length ?? 0;
  if (count < 7) {
    warn(`only ${count} of 7 role rows seeded`, "run database/seed/reference.sql");
  } else {
    ok("reference data seeded", `${count} roles`);
  }

  const users = await db.from("users").select("id", { head: true, count: "exact" });
  console.log(`  ${users.count ?? 0} user account(s) exist`);
  return true;
}

async function checkEmail() {
  console.log("\nSMTP");

  if (!capabilities.emailTransport) {
    warn("not configured", "sign-in will be password-only, no notices sent");
    return true;
  }

  console.log(`  host: ${env.SMTP_HOST}:${env.SMTP_PORT}   user: ${maskEmail(env.SMTP_USER ?? "")}`);

  // force: this script exists to test the credentials, so a cached answer from a
  // minute ago is not what anyone running it wants.
  const result = await verifyTransport(true);
  if (!result.ok) {
    fail("the server rejected these credentials", result.error?.slice(0, 160));
    if (/username and password not accepted|invalid login|535|BadCredentials/i.test(result.error ?? "")) {
      console.log("         SMTP_PASSWORD must be a 16-character App Password, not the");
      console.log("         account password, and 2-Step Verification must be on.");
      console.log("         Create one at myaccount.google.com/apppasswords");
    }
    return false;
  }

  ok("authenticated", "sign-in codes and notices will send");
  console.log(`  from: ${env.SMTP_FROM ?? env.SMTP_USER}`);
  return true;
}

function checkChain() {
  console.log("\nBLOCKCHAIN");
  initChain();

  if (!chain.isReady) {
    warn("not ready", chain.reason);
    return true;
  }
  ok("ready", `${chain.network?.name} (chain ${chain.network?.chainId})`);
  console.log(`  keeper: ${chain.keeperAddress}`);
  return true;
}

async function main() {
  console.log("\nNyaySetu connection check\n" + "=".repeat(66));

  const database = await checkDatabase();
  await checkEmail();
  checkChain();

  console.log("\n" + "=".repeat(66));
  if (failures === 0) {
    console.log(
      warnings === 0
        ? "  Everything is connected.\n"
        : `  Connected, with ${warnings} optional subsystem(s) not configured.\n`
    );
    process.exit(0);
  }

  console.log(`  ${failures} problem(s) to fix before the app will work.\n`);
  // The database is the only hard requirement, so make that distinction clear.
  if (!database) console.log("  Nothing will work until Supabase is reachable and migrated.\n");
  process.exit(1);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
