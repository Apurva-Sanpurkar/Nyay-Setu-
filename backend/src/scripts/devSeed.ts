import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "crypto";
import { memoryDatabase } from "../lib/memoryDb";
import { aadhaarToken, verhoeffCheckDigit } from "../lib/crypto";
import { logger } from "../lib/logger";

/**
 * Seeds the in-memory database for a fully local run (`npm run local` at the
 * repository root): one account per role, and the reference roles table.
 *
 * Refused unless NYAY_DB=memory, so it can never touch a real database. The
 * password comes from DEV_SEED_PASSWORD or is generated fresh at every start and
 * printed once — there is no committed shared password, because a password that
 * lives in a repository is a back door into every copy of it.
 */

const ROLES = [
  { role: "police", name: "Inspector Asha Kulkarni", designation: "Police Inspector", place: "Shivajinagar PS" },
  // Two more stations, so Vehicle Trace and Third Eye have someone to alert.
  { role: "police", name: "PSI Vikram Jadhav", designation: "Police Sub-Inspector", place: "Kothrud PS" },
  { role: "police", name: "API Farah Inamdar", designation: "Assistant Police Inspector", place: "Hinjewadi PS" },
  { role: "forensic_lab", name: "Dr. Rohan Mehta", designation: "Assistant Director, RFSL", place: "Regional Forensic Science Laboratory, Pune" },
  { role: "prosecutor", name: "Adv. Neha Joshi", designation: "Assistant Public Prosecutor", place: "District Court, Pune" },
  { role: "judge", name: "Hon. S. R. Deshpande", designation: "Judicial Magistrate First Class", place: "JMFC Court, Pune" },
  { role: "defence_lawyer", name: "Adv. Imran Shaikh", designation: "Defence Counsel", place: "Pune Bar" },
  { role: "accused", name: "Ravi Patil", designation: null, place: null },
  { role: "court_admin", name: "Court Registry", designation: "Registrar", place: "District Court, Pune" },
] as const;

let counter = 400_000_000;
function fakeAadhaar(): string {
  const prefix = `7${String(counter++).padStart(10, "0")}`;
  return prefix + verhoeffCheckDigit(prefix);
}

export async function seedMemoryDatabase(): Promise<void> {
  if (process.env.NYAY_DB !== "memory") throw new Error("devSeed only runs against the memory database.");

  const db = memoryDatabase();
  if (db.table("users").length > 0) return;

  const password = process.env.DEV_SEED_PASSWORD || randomBytes(9).toString("base64url");
  const hash = await bcrypt.hash(password, 10);

  for (const role of [
    ["police", "Police", "Field officers who register FIRs and capture evidence", "/police"],
    ["forensic_lab", "Forensic laboratory", "Receives and analyses evidence", "/forensic"],
    ["prosecutor", "Prosecution", "Builds and files the case", "/prosecutor"],
    ["judge", "Court", "Issues summons, grants bail, decides", "/judge"],
    ["defence_lawyer", "Defence counsel", "Verifies evidence independently", "/defence"],
    ["accused", "Accused", "Acknowledges summons, checks in on bail", "/accused"],
    ["court_admin", "Court registry", "Runs the registry", "/admin"],
  ]) {
    db.table("roles").push({ role: role[0], label: role[1], description: role[2], portal_path: role[3] });
  }

  const { DEFAULT_SECTION63 } = await import("../services/certificate.service");
  db.table("document_templates").push({ id: randomUUID(), ...DEFAULT_SECTION63 });

  const lines: string[] = [];
  for (const entry of ROLES) {
    const id = randomUUID();
    const station = entry.role === "police" && entry.place !== "Shivajinagar PS" ? `.${entry.place.split(" ")[0].toLowerCase()}` : "";
    const email = `${entry.role.replace("_", ".")}${station}@nyaysetu.local`;
    db.table("users").push({
      id,
      email,
      password_hash: hash,
      full_name: entry.name,
      role: entry.role,
      designation: entry.designation,
      station_or_court: entry.place,
      theme: "light",
      is_active: true,
      failed_login_attempts: 0,
      locked_until: null,
      must_change_password: false,
      mfa_email_enabled: false,
      created_at: new Date().toISOString(),
    });
    db.table("user_pii").push({ user_id: id, aadhaar_token: aadhaarToken(fakeAadhaar()), aadhaar_last4: "0000" });
    lines.push(`    ${entry.role.padEnd(15)} ${email}`);
  }

  // Synthetic Vehicle Trace and Third Eye records, written through the services.
  const officers = db
    .table("users")
    .filter((u) => u.role === "police")
    .map((u) => ({ id: u.id, email: u.email, fullName: u.full_name, role: "police" as const, designation: u.designation, stationOrCourt: u.station_or_court, theme: "light" as const, aadhaarToken: null, mustChangePassword: false }));
  const { seedSmartDemo } = await import("./smartDemo");
  const demo = await seedSmartDemo(officers);
  lines.push(`    (demo data: ${demo.vehicles} vehicle reports, ${demo.persons} Third Eye records — all synthetic)`);

  logger.info("Local stack seeded (memory database, discarded on restart)");
  // Printed directly, once: this is a local, throwaway database.
  console.log(
    [
      "",
      "  NyaySetu local accounts (in-memory, gone when this process stops)",
      ...lines,
      `    password        ${password}${process.env.DEV_SEED_PASSWORD ? "  (from DEV_SEED_PASSWORD)" : "  (generated for this run)"}`,
      "",
    ].join("\n")
  );
}
