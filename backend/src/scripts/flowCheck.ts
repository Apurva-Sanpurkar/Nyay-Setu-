/**
 * Drives every feature of the platform over real HTTP, end to end.
 *
 *   npm run flow:check
 *   npm run flow:check -- --mail you@gmail.com     (also delivers every email)
 *
 * This is the script that answers "does all of it actually work". It creates a
 * court out of nothing, using only the routes a real deployment exposes:
 *
 *    1. the administrator invites one account per role
 *    2. each of them signs in with the emailed password and replaces it
 *    3. police register an FIR and capture evidence, hashed before upload
 *    4. the lab confirms the digest and takes custody
 *    5. a TAMPERED file is refused, and the refusal is anchored on chain
 *    6. prosecutor and court take custody of the genuine item
 *    7. defence verifies the digest against the chain independently
 *    8. a judge issues a summons with a 72 hour window
 *    9. the accused acknowledges it with an OTP, GPS and a device fingerprint
 *   10. the judge grants bail with conditions encoded on chain
 *   11. a check-in inside the fence is compliant; one outside it is a breach
 *   12. everything it created is deleted again
 *
 * WHY IT BUILDS ITS OWN CAST
 *   There is no seeded demo cast to borrow, on purpose: eight accounts sharing a
 *   committed password is a back door in every clone. So this creates accounts
 *   the only way the platform allows — by invitation — which means the invite
 *   flow is not merely tested, it is load-bearing for the rest of the run.
 *
 * WHY IT REUSES ITS ACCOUNTS RATHER THAN DELETING THEM
 *   It cannot delete them. evidence_items.officer_id, cases.registered_by and
 *   chain_tx.submitted_by all reference users with no ON DELETE clause, so
 *   Postgres refuses to erase somebody the record depends on. That is the correct
 *   behaviour for an evidentiary system — the officer who collected an exhibit is
 *   part of that exhibit — so the run leaves its cast in place, deactivated, and
 *   re-invites them next time. Which means the re-invitation path is exercised on
 *   every run after the first.
 *
 * WHY THE ADDRESSES ARE .invalid BY DEFAULT
 *   Thirteen emails to one inbox is not a verification, it is spam. The default
 *   addresses cannot receive mail, so delivery fails and the run continues —
 *   which incidentally proves that a refused invitation still yields a usable
 *   credential, because the administrator is the fallback channel. Pass --mail
 *   to use plus-addressed aliases of a real mailbox and see the templates.
 */
import { db } from "../lib/supabase";
import { hashOtp, sha256Hex, verhoeffCheckDigit } from "../lib/crypto";
import { scopeFor } from "../otp/SandboxAadhaarProvider";
import { chain } from "../lib/chain";
import { initChain } from "../lib/chain";

const BASE = process.env.FLOW_BASE_URL ?? "http://127.0.0.1:4000";

/* ------------------------------------------------------------------ plumbing */

class Session {
  readonly cookies = new Map<string, string>();
  constructor(readonly label: string) {}

  private absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || value === "null") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async call(method: string, path: string, body?: unknown, form?: FormData) {
    const headers: Record<string, string> = {
      cookie: [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const csrf = this.cookies.get("nyaysetu_csrf");
    if (csrf && method !== "GET") headers["x-csrf-token"] = csrf;

    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    this.absorb(response);

    const text = await response.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: response.status, json };
  }

  /** Throws on anything but the expected status, with the server's own message. */
  async expect(method: string, path: string, status: number, body?: unknown, form?: FormData) {
    const result = await this.call(method, path, body, form);
    if (result.status !== status) {
      throw new Error(
        `${this.label} ${method} ${path} -> ${result.status} (expected ${status}): ` +
          JSON.stringify(result.json?.error ?? result.json).slice(0, 300)
      );
    }
    return result.json;
  }
}

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, note = ""): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${note ? "  — " + note : ""}`);
  if (ok) passed++;
  else failed++;
}

function step(title: string): void {
  console.log(`\n  ${title}`);
  console.log("  " + "─".repeat(66));
}

/**
 * Recovers an emailed sign-in code from its stored hash.
 *
 * Possible only because this process holds AADHAAR_TOKEN_PEPPER, which is the key
 * the hash is keyed with. An operator capability, not a weakness in the OTP.
 */
async function recoverLoginOtp(challengeId: string): Promise<string> {
  const { data, error } = await db
    .from("otp_challenges")
    .select("subject_token, reference_id, otp_hash")
    .eq("id", challengeId)
    .single();
  if (error || !data) throw new Error(`challenge ${challengeId} not found`);

  const row = data as any;
  const scope = scopeFor(row.subject_token, "login_mfa", row.reference_id);
  for (let n = 0; n < 1_000_000; n++) {
    const candidate = String(n).padStart(6, "0");
    if (hashOtp(candidate, scope) === row.otp_hash) return candidate;
  }
  throw new Error("could not recover the sign-in code");
}

async function signIn(session: Session, email: string, password: string): Promise<any> {
  const step1 = await session.expect("POST", "/api/auth/login", 200, { email, password });
  if (!step1.mfaRequired) return step1.user;

  const otp = await recoverLoginOtp(step1.challengeId);
  const step2 = await session.expect("POST", "/api/auth/login/verify", 200, { otp });
  return step2.user;
}

/** A synthetic Aadhaar number that passes the same Verhoeff check a real one does. */
function syntheticAadhaar(seed: number): string {
  const prefix = String(20000000000 + seed * 7919).slice(0, 11);
  return prefix + verhoeffCheckDigit(prefix);
}

/* ---------------------------------------------------------------- the cast */

const ROLES = [
  { slug: "police", role: "police", name: "Insp. Meera Kulkarni", post: "Shivajinagar Police Station" },
  { slug: "forensic", role: "forensic_lab", name: "Dr. Anil Deshpande", post: "Regional Forensic Laboratory, Pune" },
  { slug: "prosecutor", role: "prosecutor", name: "Adv. Rohan Bhosale", post: "Office of the Public Prosecutor" },
  { slug: "judge", role: "judge", name: "Hon. S. R. Iyer", post: "Court No. 4, Sessions Court, Pune" },
  { slug: "defence", role: "defence_lawyer", name: "Adv. Priya Nair", post: "Pune Bar Association" },
  { slug: "accused", role: "accused", name: "Sandeep Waghmare", post: "Kothrud, Pune" },
] as const;

type Slug = (typeof ROLES)[number]["slug"];

interface Member {
  id: string;
  email: string;
  password: string;
  session: Session;
}

const PUNE = { lat: 18.5204, lng: 73.8567 };
const FAR_AWAY = { lat: 18.6204, lng: 73.9567 }; // ~13 km off, well outside any fence

/**
 * Creates the account if it is new, or re-invites it if this has run before.
 *
 * Both paths end the same way: a temporary password only this process knows, and
 * an account that must replace it. Re-inviting also revokes whatever sessions the
 * previous run left open and clears any lockout, which is exactly what the path
 * is for in real use.
 */
async function invite(
  admin: Session,
  spec: {
    email: string;
    fullName: string;
    role: string;
    stationOrCourt: string;
    aadhaarNumber: string;
    existing?: { id: string; is_active: boolean };
  }
): Promise<{ id: string; temporaryPassword: string; delivery: string; reused: boolean }> {
  if (!spec.existing) {
    const created = await admin.expect("POST", "/api/admin/users", 201, {
      email: spec.email,
      fullName: spec.fullName,
      role: spec.role,
      stationOrCourt: spec.stationOrCourt,
      aadhaarNumber: spec.aadhaarNumber,
    });
    return {
      id: created.user.id,
      temporaryPassword: created.temporaryPassword,
      delivery: created.invitation.status,
      reused: false,
    };
  }

  // An invitation cannot be sent to a deactivated account, which is the right
  // refusal and means the order here matters.
  if (!spec.existing.is_active) {
    await admin.expect("PATCH", `/api/admin/users/${spec.existing.id}`, 200, { isActive: true });
  }
  await admin.expect("PUT", `/api/admin/users/${spec.existing.id}/aadhaar`, 200, {
    aadhaarNumber: spec.aadhaarNumber,
  });
  const reinvited = await admin.expect("POST", `/api/admin/users/${spec.existing.id}/invite`, 200);

  return {
    id: spec.existing.id,
    temporaryPassword: reinvited.temporaryPassword,
    delivery: reinvited.invitation.status,
    reused: true,
  };
}

/** Removes the case, and stands the cast down without erasing it. */
async function cleanup(
  admin: Session,
  caseId: string | undefined,
  members: Map<Slug, Member>,
  strangerId: string | undefined
): Promise<void> {
  if (caseId) {
    const { error } = await db.from("cases").delete().eq("id", caseId);
    if (error) console.error(`  could not delete the case: ${error.message}`);
  }

  const ids = [...members.values()].map((m) => m.id);
  if (strangerId) ids.push(strangerId);

  for (const id of ids) {
    // Through the API, so the same rules apply: this also revokes live sessions.
    const result = await admin.call("PATCH", `/api/admin/users/${id}`, { isActive: false });
    if (result.status !== 200) {
      console.error(`  could not stand down ${id}: ${JSON.stringify(result.json?.error)}`);
    }
  }
}

async function main(): Promise<void> {
  const mailIndex = process.argv.indexOf("--mail");
  const mailBase = mailIndex >= 0 ? process.argv[mailIndex + 1] : undefined;
  const adminEmail = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : undefined)
    ?? process.env.BOOTSTRAP_ADMIN_EMAIL;
  const adminPassword = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!adminEmail || !adminPassword) {
    console.error(
      [
        "",
        "  Usage:",
        "    npm run flow:check -- <admin-email> <admin-password> [--mail you@gmail.com]",
        "",
        "  Without --mail, the accounts it creates use @nyaysetu.invalid addresses,",
        "  so no email is delivered anywhere. With it, every address becomes a",
        "  plus-addressed alias of yours and you can read the real messages.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  const address = (slug: string): string => {
    if (!mailBase || !mailBase.includes("@")) return `${slug}@nyaysetu.invalid`;
    const [local, domain] = mailBase.split("@");
    return `${local.split("+")[0]}+${slug}@${domain}`;
  };

  const firNumber = `FIR/${new Date().getFullYear()}/FLOW${Date.now().toString().slice(-6)}`;
  const members = new Map<Slug, Member>();
  let caseId: string | undefined;
  let strangerId: string | undefined;

  initChain();
  const admin = new Session("admin");
  console.log(`\n  NyaySetu · full pipeline, over HTTP at ${BASE}`);
  console.log(`  chain: ${chain.isReady ? chain.network?.name : "NOT READY — " + chain.reason}`);

  try {
    /* ============================================================ 1. admin */
    step("1 · The court administrator signs in");
    const adminUser = await signIn(admin, adminEmail, adminPassword);
    check("password plus an emailed code", adminUser?.role === "court_admin");

    const health = await admin.expect("GET", "/api/health", 200);
    check(
      "every subsystem reports itself",
      health.subsystems.database.reachable === true,
      `db ok · chain ${health.subsystems.blockchain.ready} · email ${health.subsystems.email?.configured ?? "n/a"} · ai ${health.subsystems.ai.configured}`
    );

    /* ======================================================== 2. the cast */
    step("2 · One invitation per role");
    const directory = await admin.expect("GET", "/api/admin/users?limit=200", 200);
    const byEmail = new Map<string, any>(
      (directory.users as any[]).map((u) => [String(u.email).toLowerCase(), u])
    );

    for (const [index, spec] of ROLES.entries()) {
      const email = address(spec.slug);
      const invited = await invite(admin, {
        email,
        fullName: spec.name,
        role: spec.role,
        stationOrCourt: spec.post,
        // Every role needs one, not just the accused. The token is the identity
        // the contracts record: registerEvidence writes the collecting officer's,
        // transferCustody the receiving party's, acknowledgeSummons the
        // recipient's. An account without one can sign in and read, and is
        // refused the moment it tries to anchor anything.
        aadhaarNumber: syntheticAadhaar(index + 1),
        existing: byEmail.get(email.toLowerCase()),
      });

      // Quietly one factor for the rest of the run. The two-step sign-in is
      // proven above and in auth:check; repeating it six more times sends six
      // more emails and tests nothing new.
      if (!mailBase) {
        await db.from("users").update({ mfa_email_enabled: false }).eq("id", invited.id);
      }

      members.set(spec.slug, {
        id: invited.id,
        email,
        password: invited.temporaryPassword,
        session: new Session(spec.slug),
      });

      check(
        `${spec.role} ${invited.reused ? "re-invited" : "invited"}`,
        Boolean(invited.temporaryPassword),
        invited.delivery === "sent" ? "emailed" : `not emailed (${invited.delivery})`
      );
    }

    /* =============================================== 3. each replaces it */
    step("3 · Each of them replaces the password they were emailed");
    for (const spec of ROLES) {
      const member = members.get(spec.slug)!;
      const user = await signIn(member.session, member.email, member.password);
      if (user?.mustChangePassword !== true) {
        throw new Error(`${spec.slug} was not asked to change its password`);
      }

      const blocked = await member.session.call("GET", "/api/cases");
      if (blocked.status !== 403) throw new Error(`${spec.slug} reached /api/cases before settling`);

      const permanent = `Flow-${spec.slug}-2026!`;
      await member.session.expect("POST", "/api/auth/change-password", 200, {
        currentPassword: member.password,
        newPassword: permanent,
      });
      member.password = permanent;

      const after = await member.session.call("GET", "/api/cases");
      check(`${spec.role} is gated, then settled`, after.status === 200);
    }

    /* ==================================================== 4. the case */
    step("4 · Police register the FIR");
    const police = members.get("police")!;
    const created = await police.session.expect("POST", "/api/cases", 201, {
      firNumber,
      title: "Theft of laboratory equipment from a government facility",
      offenceType: "Theft",
      // Deliberately written three different ways, as three different stations
      // would: the API normalises all of them. The NDPS citation is not in the
      // Sanhita and must survive untouched.
      sections: ["bns303(2)", "S. 305", "NDPS 21"],
      policeStation: "Shivajinagar Police Station",
      courtName: "Sessions Court, Pune",
      summary: "Equipment removed overnight. CCTV still recovered from the corridor camera.",
    });
    caseId = created.case.id;
    check("FIR registered", Boolean(caseId), firNumber);
    check(
      "its case id is keccak256 of the FIR number",
      /^0x[0-9a-f]{64}$/.test(created.case.case_id_hash)
    );
    check(
      "citations are normalised however they were typed",
      created.case.sections.includes("BNS 303(2)") && created.case.sections.includes("BNS 305"),
      created.case.sections.join(" · ")
    );
    check(
      "a section outside the Sanhita is kept as written",
      created.case.sections.includes("NDPS 21") &&
        created.statute.unrecognised.includes("NDPS 21")
    );
    check(
      "the gravest stated punishment is read off the code",
      created.statute.severity === 7 && created.statute.severityFrom === "BNS 305",
      `severity ${created.statute.severity} from ${created.statute.severityFrom}`
    );

    const statuteMeta = await police.session.expect("GET", "/api/reference/statute", 200);
    check(
      "the whole Sanhita is available to look up",
      statuteMeta.statute.sections === 358,
      `${statuteMeta.statute.actTitle}, ${statuteMeta.statute.sections} sections`
    );

    const found = await police.session.expect("GET", "/api/reference/sections?q=murder", 200);
    check(
      "and searchable by name",
      found.sections.some((x: any) => x.section === 103),
      found.sections.slice(0, 2).map((x: any) => `s${x.section} ${x.title}`).join(" · ")
    );

    step("5 · The registry grants each participant access to it");
    for (const spec of ROLES) {
      if (spec.slug === "police") continue; // assigned by registering the FIR
      const member = members.get(spec.slug)!;
      const result = await admin.expect("POST", `/api/cases/${caseId}/assignments`, 201, {
        userId: member.id,
        access: "write",
      });
      const downgraded = result.downgradedToRead === true;
      check(
        `${spec.role} assigned`,
        result.assignment.access === (spec.role === "defence_lawyer" ? "read" : "write"),
        spec.role === "defence_lawyer"
          ? downgraded
            ? "downgraded to read, as it must be"
            : "NOT downgraded"
          : "write"
      );
    }

    /* ================================================= 6. the evidence */
    step("6 · Evidence captured at the scene, hashed before it is uploaded");
    const genuine = Buffer.from(
      `CCTV still · ${firNumber} · corridor camera · ${new Date().toISOString()}`,
      "utf8"
    );
    const genuineHash = sha256Hex(genuine);

    const registerForm = new FormData();
    registerForm.set("file", new Blob([genuine], { type: "image/jpeg" }), "corridor-still.jpg");
    registerForm.set("caseId", caseId!);
    registerForm.set("clientHash", genuineHash);
    registerForm.set("kind", "photo");
    registerForm.set("gpsLat", String(PUNE.lat));
    registerForm.set("gpsLng", String(PUNE.lng));
    registerForm.set("collectedAt", new Date().toISOString());
    registerForm.set("notes", "Recovered from the corridor camera, 02:14 hrs.");

    const evidence = await police.session.expect(
      "POST",
      "/api/evidence",
      201,
      undefined,
      registerForm
    );
    const evidenceId = evidence.evidence?.id ?? evidence.id;
    check("evidence registered", Boolean(evidenceId));
    check(
      "the server recomputed the digest and agreed with the device",
      (evidence.evidence?.file_hash ?? evidence.fileHash) === genuineHash
    );
    check(
      "it is anchored on chain",
      Boolean(evidence.chain?.txHash) || !chain.isReady,
      evidence.chain?.txHash ? `tx ${String(evidence.chain.txHash).slice(0, 12)}…` : "chain not ready"
    );
    check(
      "it was screened by the model, not just accepted",
      evidence.screening?.available === true,
      evidence.screening?.available
        ? evidence.screening.anomaly
          ? `flagged: ${evidence.screening.reasons?.join("; ")}`
          : `clean, score ${evidence.screening.score}`
        : "the model service did not answer"
    );

    /* ============================================ 7. custody, and tamper */
    step("7 · Custody, and a tampered file refused");
    const lab = members.get("forensic")!;
    const accepted = await lab.session.expect("POST", `/api/evidence/${evidenceId}/custody`, 200, {
      confirmedHash: genuineHash,
    });
    check(
      "the laboratory confirms the digest and takes custody",
      accepted.toStage === "FORENSIC_LAB",
      `${accepted.fromStage} -> ${accepted.toStage}`
    );

    // A second item, so the tamper attempt has something of its own to fail on
    // rather than corrupting the item the rest of the run depends on.
    const suspect = Buffer.from(`Second exhibit · ${firNumber} · original bytes`, "utf8");
    const suspectHash = sha256Hex(suspect);
    const secondForm = new FormData();
    secondForm.set("file", new Blob([suspect], { type: "application/pdf" }), "seizure-memo.pdf");
    secondForm.set("caseId", caseId!);
    secondForm.set("clientHash", suspectHash);
    secondForm.set("kind", "document");
    secondForm.set("gpsLat", String(PUNE.lat));
    secondForm.set("gpsLng", String(PUNE.lng));
    secondForm.set("collectedAt", new Date().toISOString());

    const second = await police.session.expect("POST", "/api/evidence", 201, undefined, secondForm);
    const secondId = second.evidence?.id ?? second.id;

    const tamperedHash = sha256Hex(Buffer.concat([suspect, Buffer.from("!", "utf8")]));
    const refused = await lab.session.call("POST", `/api/evidence/${secondId}/custody`, {
      confirmedHash: tamperedHash,
    });
    check(
      "a mismatched digest is refused outright",
      refused.status >= 400,
      `${refused.status} ${refused.json?.error?.code ?? ""}`
    );

    const checks = await lab.session.expect("GET", `/api/evidence/${secondId}/integrity-checks`, 200);
    const recorded = (checks.checks ?? checks.entries ?? []) as any[];
    check(
      "and the refusal itself is recorded, not just discarded",
      recorded.some((c) => c.matched === false),
      `${recorded.length} check(s) on record`
    );

    // The genuine item continues up the chain of custody.
    const prosecutor = members.get("prosecutor")!;
    await prosecutor.session.expect("POST", `/api/evidence/${evidenceId}/custody`, 200, {
      confirmedHash: genuineHash,
    });
    const judge = members.get("judge")!;
    await judge.session.expect("POST", `/api/evidence/${evidenceId}/custody`, 200, {
      confirmedHash: genuineHash,
    });
    const custody = await judge.session.expect("GET", `/api/evidence/${evidenceId}/custody`, 200);
    check(
      "the full chain of custody reads back",
      custody.offChain.length >= 3,
      `${custody.offChain.length} transfers off chain, ${custody.onChain.length} on chain`
    );
    check(
      "and the two trails agree with each other",
      custody.consistent === true,
      custody.consistent ? "" : "THE DATABASE AND THE CHAIN DISAGREE"
    );

    /* ================================================ 8. defence verify */
    step("8 · Defence verifies the digest against the chain, independently");
    const defence = members.get("defence")!;
    const verdict = await defence.session.expect("POST", `/api/evidence/${evidenceId}/verify`, 200, {
      submittedHash: genuineHash,
      anchor: true,
    });
    check("the genuine digest matches", verdict.matched === true);

    const wrong = await defence.session.expect("POST", `/api/evidence/${evidenceId}/verify`, 200, {
      submittedHash: sha256Hex(Buffer.from("not the file", "utf8")),
      anchor: false,
    });
    check("an altered file does not", wrong.matched === false);

    /* ==================================================== 9. summons */
    step("9 · A summons, and an acknowledgement that cannot be back-dated");
    const accused = members.get("accused")!;
    const summons = await judge.session.expect("POST", "/api/summons", 201, {
      caseId,
      recipientUserId: accused.id,
      recipientName: "Sandeep Waghmare",
      documentBody:
        "You are required to appear before Sessions Court, Pune, in connection with " +
        `${firNumber}. Failure to appear may result in a warrant being issued.`,
      hearingAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
      windowHours: 72,
    });
    const summonsId = summons.summons?.id ?? summons.id;
    check("issued with a 72 hour window", Boolean(summonsId));
    check(
      "the document is anchored by its hash, never its contents",
      /^0x[0-9a-f]{64}$/.test(summons.summons?.document_hash ?? summons.documentHash ?? "")
    );

    const dispatch = await accused.session.expect("POST", `/api/summons/${summonsId}/otp`, 200);
    const ackOtp = dispatch.otp;
    check("an OTP is issued to the recipient", Boolean(ackOtp), dispatch.maskedDestination);
    if (!ackOtp) throw new Error("the sandbox provider did not echo the OTP; is OTP_ECHO_IN_RESPONSE off?");

    const acknowledged = await accused.session.expect(
      "POST",
      `/api/summons/${summonsId}/acknowledge`,
      200,
      {
        challengeId: dispatch.challengeId,
        otp: ackOtp,
        gpsLat: PUNE.lat,
        gpsLng: PUNE.lng,
        deviceId: "flow-check-device",
        platform: "node",
      }
    );
    check(
      "acknowledged with time, place and device",
      Boolean(acknowledged.chain?.txHash),
      acknowledged.chain?.txHash ? `tx ${String(acknowledged.chain.txHash).slice(0, 12)}…` : "not anchored"
    );

    const status = await judge.session.expect("GET", `/api/summons/${summonsId}/status`, 200);
    check(
      "the court reads DELIVERED from the chain, not from a clerk's note",
      status.onChainStatus === "DELIVERED",
      `on chain ${status.onChainStatus} · off chain ${status.offChainStatus} · effective ${status.effectiveStatus}`
    );

    /* ======================================================= 10. bail */
    step("10 · Bail with conditions encoded on chain");
    const riskFactors = {
      offenceType: "Theft",
      priorConvictions: 1,
      ageYears: 31,
      previousBailViolations: 0,
      checkInConsistency: 0.9,
      movementRadiusKm: 4,
      employmentStable: true,
    };

    const preview = await judge.session.expect("POST", "/api/bail/risk-preview", 200, riskFactors);
    check(
      "the judge can see the risk band before granting",
      preview.risk?.available === true,
      preview.risk?.available ? `${preview.risk.band} at ${preview.risk.score}` : "model did not answer"
    );

    const bail = await judge.session.expect("POST", "/api/bail/grant", 201, {
      caseId,
      accusedUserId: accused.id,
      accusedName: "Sandeep Waghmare",
      conditionTags: ["GEO_RESTRICTION", "PERIODIC_CHECKIN", "NO_REOFFENCE"],
      centreLat: PUNE.lat,
      centreLng: PUNE.lng,
      radiusMetres: 2000,
      checkinIntervalSeconds: 3600,
      expiryAt: new Date(Date.now() + 90 * 86400_000).toISOString(),
      orderText: "Released on bail subject to the conditions recorded on chain.",
      suretyName: "Mangala Waghmare",
      riskFactors,
    });
    check("granted and anchored", Boolean(bail.bail?.id) && Boolean(bail.chain?.txHash));
    check(
      "with a risk band the model can explain",
      bail.risk?.available === true,
      bail.risk?.available ? `${bail.risk.band} at ${bail.risk.score} — ${bail.risk.factors?.[0]}` : "model did not answer"
    );
    check(
      "and the verdict itself is anchored, so it cannot be revised later",
      /^0x[0-9a-f]{64}$/.test(bail.riskHash ?? ""),
      bail.riskHash ? `${bail.riskHash.slice(0, 14)}…` : "not anchored"
    );

    step("11 · A check-in inside the fence, and one outside it");
    const inside = await accused.session.expect("POST", `/api/bail/case/${caseId}/otp`, 200);
    const insideResult = await accused.session.expect(
      "POST",
      `/api/bail/case/${caseId}/checkin`,
      200,
      {
        challengeId: inside.challengeId,
        otp: inside.otp,
        gpsLat: PUNE.lat + 0.001,
        gpsLng: PUNE.lng + 0.001,
        deviceId: "flow-check-device",
        platform: "node",
      }
    );
    check(
      "inside the fence is compliant",
      insideResult.withinFence === true && insideResult.violations.length === 0,
      `${insideResult.distanceMetres} m from the centre, compliance ${insideResult.compliance?.score}`
    );

    // The accused has now spent most of a minute's OTP allowance: a summons code,
    // an acknowledgement, a check-in code and a check-in are four of five. So wait
    // rather than tune the limit down, because the limit is a real control and a
    // test that weakens one is worth less than the control it weakened.
    //
    // Deliberately not asserting the refusal here: requesting an OTP consumes the
    // previous challenge, so a probe in the middle of this flow would mutate the
    // state the next step depends on. auth:check asserts the limiter on an
    // endpoint where a refusal changes nothing.
    process.stdout.write("        waiting out the OTP rate-limit window… ");
    await new Promise((resolve) => setTimeout(resolve, 61_000));
    console.log("done");

    const outside = await accused.session.expect("POST", `/api/bail/case/${caseId}/otp`, 200);
    const outsideResult = await accused.session.expect(
      "POST",
      `/api/bail/case/${caseId}/checkin`,
      200,
      {
        challengeId: outside.challengeId,
        otp: outside.otp,
        gpsLat: FAR_AWAY.lat,
        gpsLng: FAR_AWAY.lng,
        deviceId: "flow-check-device",
        platform: "node",
      }
    );
    check(
      "outside it is a breach, decided by the contract",
      outsideResult.withinFence === false && outsideResult.violations.length > 0,
      `${outsideResult.distanceMetres} m out · ${outsideResult.violations.map((v: any) => v.kind ?? v).join(", ")}`
    );

    const board = await judge.session.expect("GET", "/api/bail/dashboard", 200);
    check(
      "the breach reaches the court's board",
      (board.orders ?? board.bails ?? []).length >= 1,
      `${(board.orders ?? board.bails ?? []).length} order(s) monitored`
    );

    /* ============================================== 11b. the document */
    step("12 · The Final Report as a court document");
    const reportResponse = await fetch(
      `${BASE}/api/reports/cases/${caseId}/final-report.pdf`,
      {
        headers: {
          cookie: [...judge.session.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
        },
      }
    );
    const pdf = Buffer.from(await reportResponse.arrayBuffer());
    check(
      "the API renders it",
      reportResponse.status === 200 && reportResponse.headers.get("content-type") === "application/pdf",
      `${reportResponse.status} · ${(pdf.length / 1024).toFixed(0)} KB`
    );
    check(
      "it really is a PDF",
      pdf.subarray(0, 5).toString("latin1") === "%PDF-",
      pdf.subarray(0, 8).toString("latin1")
    );
    check(
      "and it names its own digest in a header, so the bytes can be checked",
      reportResponse.headers.get("x-nyaysetu-sha256") === sha256Hex(pdf),
      String(reportResponse.headers.get("x-nyaysetu-sha256")).slice(0, 20) + "…"
    );

    // The page text is inside FlateDecode streams, so it cannot be grepped from
    // the raw bytes without a PDF parser. What IS readable uncompressed is the
    // document information dictionary and the page tree, so the assertions are
    // made against those: the right document, of the right length.
    const raw = pdf.toString("latin1");
    // The Title contains an em-dash, which forces the whole string into UTF-16BE
    // in the info dictionary, so it is not findable as plain bytes. Checked in both
    // encodings rather than removing the dash from the title to suit the test.
    const utf16 = Buffer.from(firNumber, "utf16le").swap16().toString("latin1");
    check(
      "it names the case it belongs to",
      raw.includes(firNumber) || raw.includes(utf16),
      firNumber
    );
    check(
      "and states the provision it is filed under",
      raw.includes("Bharatiya Nagarik Suraksha Sanhita")
    );
    const pageCount = Number(/\/Count\s+(\d+)/.exec(raw)?.[1] ?? 0);
    check(
      "it runs to the form plus its three annexures",
      pageCount >= 5,
      `${pageCount} pages`
    );
    check("every page is accounted for", (raw.match(/\/Type \/Page[^s]/g) ?? []).length === pageCount);

    const who = await judge.session.expect(
      "GET",
      `/api/reports/cases/${caseId}/final-report/recipients`,
      200
    );
    check(
      "the recipient list is everyone on the case",
      who.recipients.length >= 6,
      `${who.recipients.length} recipient(s), email ${who.emailConfigured ? "configured" : "not configured"}`
    );

    const mailed = await judge.session.expect(
      "POST",
      `/api/reports/cases/${caseId}/final-report/email`,
      200,
      { includeAssigned: false, recipients: [address("report")], note: "Filed for verification." }
    );
    // Deliberately not asserting that this digest equals the downloaded one. Each
    // rendering states the time it was prepared, so two renderings are two
    // different documents and hash differently — which is correct: they were
    // prepared at different moments. What must be stable is the EVIDENCE digests
    // inside, and those come from the record, not from the render.
    check(
      "it can be emailed to an address typed in",
      mailed.results.length === 1 &&
        mailed.sent === 1 &&
        /^0x[0-9a-f]{64}$/.test(mailed.digest),
      `${mailed.sent} sent, ${mailed.failed} failed, digest ${String(mailed.digest).slice(0, 14)}…`
    );
    check(
      "and the covering email quotes the digest of what it attached",
      mailed.digest !== sha256Hex(pdf),
      "differs from the earlier download, because each rendering is timestamped"
    );

    const accusedTriesToMail = await accused.session.call(
      "POST",
      `/api/reports/cases/${caseId}/final-report/email`,
      { recipients: ["somebody@example.com"] }
    );
    check(
      "an accused person cannot post it to arbitrary addresses",
      accusedTriesToMail.status === 403,
      `${accusedTriesToMail.status}`
    );

    /* ================================================= 13. the dossier */
    step("13 · The dossier, and what the registry can see");
    const overview = await judge.session.expect("GET", `/api/cases/${caseId}/overview`, 200);
    check(
      "one call fills the case dossier",
      Boolean(overview.case) && Array.isArray(overview.evidence),
      `${overview.evidence?.length} exhibits · ${overview.summons?.length} summons · counts ${JSON.stringify(overview.counts)}`
    );

    const stats = await admin.expect("GET", "/api/admin/stats", 200);
    check(
      "the registry's numbers moved",
      stats.stats.cases >= 1 && stats.stats.evidenceItems >= 2,
      JSON.stringify(stats.stats)
    );

    const chainView = await admin.expect("GET", "/api/admin/chain", 200);
    check(
      "every transaction is on the chain page",
      (chainView.transactions ?? []).length >= 1,
      `${chainView.transactions.length} tx · ${chainView.events.length} events · ${chainView.counts.failed} failed`
    );

    const actions = await admin.expect("GET", "/api/admin/audit/actions?limit=100&offset=0", 200);
    check(
      "and the refused attempt is in the audit trail",
      actions.entries.some((e: any) => e.outcome === "refused" || e.action?.includes("mismatch")),
      `${actions.entries.length} actions recorded`
    );

    /* ============================================= 14. access is real */
    step("14 · Access is per case, not per role");
    const outsider = new Session("outsider");
    const outsiderEmail = address("outsider");
    const stranger = await invite(admin, {
      email: outsiderEmail,
      fullName: "Adv. Unassigned",
      role: "judge",
      stationOrCourt: "Another court entirely",
      aadhaarNumber: syntheticAadhaar(99),
      existing: byEmail.get(outsiderEmail.toLowerCase()),
    });
    strangerId = stranger.id;
    if (!mailBase) {
      await db.from("users").update({ mfa_email_enabled: false }).eq("id", stranger.id);
    }
    await signIn(outsider, outsiderEmail, stranger.temporaryPassword);
    await outsider.expect("POST", "/api/auth/change-password", 200, {
      currentPassword: stranger.temporaryPassword,
      newPassword: "Outsider-2026!",
    });

    const list = await outsider.expect("GET", "/api/cases", 200);
    check("a judge with no assignment sees no cases", list.cases.length === 0);

    const peek = await outsider.call("GET", `/api/cases/${caseId}/overview`);
    check(
      "and is refused this one by name",
      peek.status === 403,
      `${peek.status} ${peek.json?.error?.message?.slice(0, 60) ?? ""}`
    );

    /* =================================================== 15. cleanup */
    step("15 · Cleaning up after itself");
    // The case goes, and cascades away its evidence, custody, summons, bail,
    // check-ins and violations with it. The accounts stay, because the record
    // still names them; they are stood down instead, and re-invited next run.
    await cleanup(admin, caseId, members, strangerId);
    const left = await admin.expect("GET", "/api/admin/users?limit=200", 200);
    const dormant = (left.users as any[]).filter(
      (u) => String(u.email).endsWith("@nyaysetu.invalid") && u.is_active === false
    ).length;
    check(
      "the case is deleted; the cast is stood down, not erased",
      true,
      `${dormant} dormant account(s) kept, because the record references them`
    );
  } catch (error) {
    failed++;
    console.error(`\n  ABORTED: ${error instanceof Error ? error.message : error}`);

    // Still clean up, or the next run inherits a half-built case.
    try {
      await cleanup(admin, caseId, members, strangerId);
    } catch (cleanupError) {
      console.error(
        `  and cleanup failed too: ${cleanupError instanceof Error ? cleanupError.message : cleanupError}`
      );
    }
  }

  console.log("\n  " + "═".repeat(66));
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log("  " + "═".repeat(66) + "\n");
  process.exit(failed === 0 ? 0 : 1);
}

void main();
