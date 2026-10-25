import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { ROLES, assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { caseIdHash, keccakOfString } from "../src/lib/crypto";
import { normaliseFirNumber, validateFir } from "../src/lib/fir";

after(stopServer);
beforeEach(resetDatabase);

const CASE = {
  title: "Theft of a two-wheeler",
  offenceType: "Theft",
  sections: ["BNS 303"],
  policeStation: "Shivajinagar PS",
  courtName: "JMFC Court, Pune",
};

async function createCase(actor: Actor, extra: Record<string, unknown> = {}) {
  return call(actor, "POST", "/api/cases", { body: { ...CASE, ...extra } });
}

test("only police and the court registry can register a case", async () => {
  for (const role of ROLES) {
    const actor = makeActor(role);
    const response = await createCase(actor, { origin: "complaint" });
    const allowed = role === "police" || role === "court_admin";
    assert.equal(response.status, allowed ? 201 : 403, `${role}: ${JSON.stringify(response.body)}`);
  }
});

test("a case gets its own reference, numbered per station and year", async () => {
  const police = makeActor("police");
  const a = await createCase(police, { origin: "complaint" });
  const b = await createCase(police, { origin: "complaint" });
  const year = new Date().getUTCFullYear();
  assert.equal(a.body.case.case_reference, `NS/SHIVAJINAGAR-PS/${year}/000001`);
  assert.equal(b.body.case.case_reference, `NS/SHIVAJINAGAR-PS/${year}/000002`);

  const elsewhere = await createCase(police, { origin: "complaint", policeStation: "Kothrud PS" });
  assert.equal(elsewhere.body.case.case_reference, `NS/KOTHRUD-PS/${year}/000001`);
});

test("the on-chain key is salted: neither the FIR nor the reference can be recovered from it", async () => {
  const police = makeActor("police");
  const created = await createCase(police, { fir: { number: "0042/2026", year: 2026 } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const row = mem.table("cases").find((c) => c.id === created.body.case.id)!;

  assert.equal(row.case_key_scheme, "salted_v2");
  assert.match(row.case_salt, /^[0-9a-f]{64}$/);
  assert.notEqual(row.case_id_hash, caseIdHash("0042/2026"));
  assert.notEqual(row.case_id_hash, keccakOfString(row.case_reference));
  assert.equal(row.fir_number, null, "2.0 cases keep the FIR out of the cases table");
  // The salt never leaves the API.
  assert.ok(!JSON.stringify(created.body).includes(row.case_salt));
});

test("an FIR is unique per station and year, whatever way the number is written", async () => {
  const police = makeActor("police");
  assert.equal((await createCase(police, { fir: { number: "0042/2026", year: 2026 } })).status, 201);

  for (const spelling of ["42/2026", " 0042 / 2026 ", "FIR NO. 42/2026"]) {
    const duplicate = await createCase(police, { fir: { number: spelling, year: 2026 } });
    assert.equal(duplicate.status, 409, `${spelling}: ${JSON.stringify(duplicate.body)}`);
  }

  // Same number, different year or station: a different FIR.
  assert.equal((await createCase(police, { fir: { number: "0042/2026", year: 2025 } })).status, 201);
  assert.equal(
    (await createCase(police, { policeStation: "Kothrud PS", fir: { number: "0042/2026", year: 2026 } })).status,
    201
  );
});

test("FIR input is validated before anything is stored", async () => {
  const police = makeActor("police");
  const nextYear = new Date().getUTCFullYear() + 1;
  const cases = [
    { fir: { number: "42", year: nextYear } },
    { fir: { number: "42", year: 2026, date: "2025-12-31" } },
    { fir: { number: "<script>", year: 2026 } },
    { origin: "fir" },
  ];
  for (const extra of cases) {
    const response = await createCase(police, extra);
    assert.ok([400, 409].includes(response.status), `${JSON.stringify(extra)} -> ${response.status}`);
  }
  assert.equal(mem.table("cases").length, 0, "nothing was created by a refused request");
  assert.equal(normaliseFirNumber("CR No. 0042/2026"), "42/2026");
  assert.throws(() => validateFir({ number: "42", year: 2026, date: "2027-01-01", policeStation: "X PS" }));
});

test("1.0 clients that send only firNumber are still accepted", async () => {
  const police = makeActor("police");
  const response = await call(police, "POST", "/api/cases", { body: { ...CASE, firNumber: "PUNE/77/2026" } });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.case.fir.number, "PUNE/77/2026");
  assert.equal(response.body.case.origin, "fir");
});

test("the FIR number is visible to police, prosecutor, judge and registry only", async () => {
  const police = makeActor("police");
  const created = await createCase(police, { fir: { number: "SECRET-0909", year: 2026 } });
  const caseId = created.body.case.id;

  for (const role of ROLES) {
    const actor = makeActor(role);
    if (role !== "court_admin") assign(actor, caseId, "read");

    const responses = [
      await call(actor, "GET", "/api/cases"),
      await call(actor, "GET", `/api/cases/${caseId}`),
      await call(actor, "GET", `/api/cases/${caseId}/overview`),
      await call(actor, "GET", `/api/cases/${caseId}/timeline`),
    ];
    const privileged = ["police", "prosecutor", "judge", "court_admin"].includes(role);

    for (const response of responses) {
      assert.equal(response.status, 200, `${role}: ${JSON.stringify(response.body)}`);
      const text = JSON.stringify(response.body);
      // The timeline never carries it, whoever is asking.
      const expectNumber = privileged && !response.body.entries;
      assert.equal(text.includes("SECRET-0909"), expectNumber, `${role} ${expectNumber ? "should" : "must not"} see the FIR`);
    }

    const detail = responses[1].body.case;
    assert.equal(detail.fir.linked, true, `${role} is told an FIR is linked`);

    const firRoute = await call(actor, "GET", `/api/cases/${caseId}/fir`);
    assert.equal(firRoute.status, privileged ? 200 : 403, `${role} GET /fir`);
  }
});

test("linking or correcting an FIR needs police write access or the registry, and is logged", async () => {
  const police = makeActor("police");
  const created = await createCase(police, { origin: "complaint" });
  const caseId = created.body.case.id;
  const body = { number: "77/2026", year: 2026, date: "2026-02-03", policeStation: "Shivajinagar PS" };

  const reader = makeActor("police");
  assign(reader, caseId, "read");
  assert.equal((await call(reader, "PUT", `/api/cases/${caseId}/fir`, { body })).status, 403);

  const prosecutor = makeActor("prosecutor");
  assign(prosecutor, caseId, "write");
  assert.equal((await call(prosecutor, "PUT", `/api/cases/${caseId}/fir`, { body })).status, 403);

  const linked = await call(police, "PUT", `/api/cases/${caseId}/fir`, { body });
  assert.equal(linked.status, 200, JSON.stringify(linked.body));
  assert.equal(linked.body.fir.number, "77/2026");

  const corrected = await call(police, "PUT", `/api/cases/${caseId}/fir`, { body: { ...body, number: "78/2026" } });
  assert.equal(corrected.status, 200);

  const actions = mem.table("action_log").filter((a) => a.case_id === caseId).map((a) => a.action);
  assert.deepEqual(actions, ["case.register", "case.fir_linked", "case.fir_corrected"]);
  // The number itself is kept out of the action log.
  assert.ok(!JSON.stringify(mem.table("action_log")).includes("78/2026"));
});

test("unassigned users cannot read a case or its timeline (no IDOR)", async () => {
  const police = makeActor("police");
  const caseId = (await createCase(police, { origin: "complaint" })).body.case.id;

  for (const role of ROLES.filter((r) => r !== "court_admin")) {
    const stranger = makeActor(role);
    for (const path of [`/api/cases/${caseId}`, `/api/cases/${caseId}/overview`, `/api/cases/${caseId}/timeline`]) {
      assert.equal((await call(stranger, "GET", path)).status, 403, `${role} ${path}`);
    }
  }
  assert.equal((await call(makeActor("court_admin"), "GET", `/api/cases/${caseId}/timeline`)).status, 200);
});

test("a judge cannot hand out access on a case they do not sit on", async () => {
  const police = makeActor("police");
  const caseId = (await createCase(police, { origin: "complaint" })).body.case.id;
  const judge = makeActor("judge");
  const defence = makeActor("defence_lawyer");

  const refused = await call(judge, "POST", `/api/cases/${caseId}/assignments`, { body: { userId: defence.id } });
  assert.equal(refused.status, 403);

  assign(judge, caseId, "write");
  const granted = await call(judge, "POST", `/api/cases/${caseId}/assignments`, {
    body: { userId: defence.id, access: "write" },
  });
  assert.equal(granted.status, 201);
  assert.equal(granted.body.assignment.access, "read", "defence is always downgraded to read");
});

test("evidence is linked to exactly one case and is not reachable through another", async () => {
  const police = makeActor("police");
  const caseA = (await createCase(police, { origin: "complaint" })).body.case.id;
  const caseB = (await createCase(police, { origin: "complaint" })).body.case.id;
  const evidenceId = randomUUID();
  mem.table("evidence_items").push({
    id: evidenceId,
    case_id: caseA,
    file_hash: "0x" + "ab".repeat(32),
    file_name: "scene.jpg",
    kind: "photo",
    collected_at: new Date().toISOString(),
    current_stage: "SCENE",
    officer_aadhaar_token: "0x" + "cd".repeat(32),
    anomaly_flagged: false,
    anomaly_reasons: [],
    mismatch_count: 0,
  });

  const listA = await call(police, "GET", `/api/evidence/case/${caseA}`);
  const listB = await call(police, "GET", `/api/evidence/case/${caseB}`);
  assert.deepEqual(listA.body.items.map((i: any) => i.id), [evidenceId]);
  assert.deepEqual(listB.body.items, []);

  const otherOfficer = makeActor("police");
  assign(otherOfficer, caseB, "write");
  assert.equal((await call(otherOfficer, "GET", `/api/evidence/${evidenceId}`)).status, 403);
  assert.equal((await call(otherOfficer, "GET", `/api/evidence/case/${caseA}`)).status, 403);
});

test("closing a case is refused here; it goes through two-person approval", async () => {
  const police = makeActor("police");
  const caseId = (await createCase(police, { origin: "complaint" })).body.case.id;
  const response = await call(police, "PATCH", `/api/cases/${caseId}/status`, { body: { status: "disposed" } });
  assert.equal(response.status, 403);
  assert.match(response.body.error.message, /two-person approval/);

  const moved = await call(police, "PATCH", `/api/cases/${caseId}/status`, { body: { status: "under_investigation" } });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.case.status, "under_investigation");
});
