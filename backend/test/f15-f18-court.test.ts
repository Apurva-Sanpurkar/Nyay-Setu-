import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { createCase, uploadEvidence } from "./support/evidence";
import { env } from "../src/config/env";
import { classifyViolation } from "../src/services/court.service";
import { sendReminders, setNotificationProvider } from "../src/services/notify.service";
import { explainScreening } from "../src/services/aiExplain.service";

after(stopServer);

let fake: FakeChain;
let police: Actor;
let judge: Actor;
let kase: { id: string; case_reference: string };
const depth = env.confirmationDepth;

beforeEach(async () => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  police = makeActor("police");
  judge = makeActor("judge");
  kase = await createCase(police);
  assign(judge, kase.id, "write");
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = depth;
  setNotificationProvider(null);
});

function seedBail(accused: Actor, overrides: Record<string, unknown> = {}) {
  const id = randomUUID();
  mem.table("bail_conditions").push({
    id,
    case_id: kase.id,
    accused_user_id: accused.id,
    accused_name: accused.name,
    accused_aadhaar_token: accused.aadhaarToken,
    conditions: ["Report weekly"],
    condition_tags: ["0x" + "aa".repeat(32)],
    radius_metres: 2000,
    checkin_interval_seconds: 604800,
    expiry_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    active: true,
    created_at: new Date(Date.now() - 8 * 86_400_000).toISOString(),
    ...overrides,
  });
  return id;
}

/* ------------------------------------------------------------- F15 */
test("prosecution overview counts verified, pending and flagged per case, and shows custody gaps", async () => {
  const prosecutor = makeActor("prosecutor");
  assign(prosecutor, kase.id, "read");
  await uploadEvidence(police, kase.id);
  fake.nextSend = "rpc-down";
  await uploadEvidence(police, kase.id);
  mem.table("discrepancy_alerts").push({ id: randomUUID(), case_id: kase.id, kind: "CUSTODY_GAP", severity: "warning", explanation: "x", dedupe_key: "g1", status: "open", detected_at: new Date().toISOString() });

  const overview = await call(prosecutor, "GET", "/api/court/prosecution");
  const row = overview.body.cases[0];
  assert.deepEqual([row.evidence, row.verified, row.pending, row.flagged, row.custodyGaps], [2, 1, 1, 0, 1]);
  assert.equal((await call(makeActor("defence_lawyer"), "GET", "/api/court/prosecution")).status, 403);
});

/* ------------------------------------------------------------- F16 */
test("defence gets exactly what the court grants: read access, after a logged request", async () => {
  const defence = makeActor("defence_lawyer");
  assert.equal((await call(defence, "GET", `/api/cases/${kase.id}`)).status, 403, "no access before a grant");

  const unknown = await call(defence, "POST", "/api/court/access-requests", { body: { caseReference: "NS/NOPE/2026/000009", reason: "Representing the accused." } });
  assert.equal(unknown.status, 404);

  const requested = await call(defence, "POST", "/api/court/access-requests", { body: { caseReference: kase.case_reference, reason: "Engaged by the accused on 3 October." } });
  assert.equal(requested.status, 201);
  assert.equal((await call(defence, "POST", "/api/court/access-requests", { body: { caseReference: kase.case_reference, reason: "Engaged by the accused, again." } })).status, 409);

  const queue = await call(judge, "GET", "/api/court/access-requests?status=pending");
  assert.equal(queue.body.requests.length, 1);
  assert.equal(queue.body.requests[0].requester_name, defence.name);

  const outsiderJudge = makeActor("judge");
  assert.equal((await call(outsiderJudge, "POST", `/api/court/access-requests/${requested.body.request.id}/decide`, { body: { grant: true, reason: "granted" } })).status, 403);

  const granted = await call(judge, "POST", `/api/court/access-requests/${requested.body.request.id}/decide`, { body: { grant: true, reason: "Vakalatnama filed." } });
  assert.equal(granted.body.request.status, "granted");
  const assignment = mem.table("case_assignments").find((a) => a.user_id === defence.id)!;
  assert.equal(assignment.access, "read", "never write");
  assert.equal((await call(defence, "GET", `/api/cases/${kase.id}`)).status, 200);
  assert.ok(["access.request", "access.grant"].every((a) => mem.table("action_log").some((l) => l.action === a)));
});

test("objections are filed by defence and ruled on by the court, every step logged", async () => {
  const defence = makeActor("defence_lawyer");
  assign(defence, kase.id, "read");
  const { response } = await uploadEvidence(police, kase.id);
  const filed = await call(defence, "POST", "/api/court/objections", {
    body: { caseId: kase.id, evidenceId: response.body.evidence.id, grounds: "Custody gap of four days before laboratory intake." },
  });
  assert.equal(filed.status, 201);
  assert.equal((await call(defence, "POST", `/api/court/objections/${filed.body.objection.id}/rule`, { body: { outcome: "upheld", ruling: "Self-serving ruling." } })).status, 403);
  const ruled = await call(judge, "POST", `/api/court/objections/${filed.body.objection.id}/rule`, { body: { outcome: "dismissed", ruling: "Malkhana register accounts for the period." } });
  assert.equal(ruled.body.objection.status, "dismissed");
  const stranger = makeActor("defence_lawyer");
  assert.equal((await call(stranger, "POST", "/api/court/objections", { body: { caseId: kase.id, grounds: "Not my case at all here." } })).status, 403);
});

/* ------------------------------------------------------------- F17 */
test("court events link to the record; the accused sees only hearing dates", async () => {
  const accused = makeActor("accused");
  assign(accused, kase.id, "read");
  await call(judge, "POST", `/api/court/cases/${kase.id}/events`, { body: { kind: "hearing", title: "Framing of charges", scheduledFor: new Date(Date.now() + 7 * 86_400_000).toISOString() } });
  await call(judge, "POST", `/api/court/cases/${kase.id}/events`, { body: { kind: "order", title: "Direction to produce the CDR", body: "Draft order text" } });
  assert.equal((await call(police, "POST", `/api/court/cases/${kase.id}/events`, { body: { kind: "order", title: "Not mine to make" } })).status, 403);

  const theirs = await call(accused, "GET", `/api/court/cases/${kase.id}/events`);
  assert.deepEqual(theirs.body.events.map((e: any) => e.kind), ["hearing"]);
  const hearings = await call(judge, "GET", "/api/court/hearings");
  assert.equal(hearings.body.hearings.length, 1);
});

test("summons service status lists every attempt", async () => {
  const summonsId = randomUUID();
  mem.table("summons").push({ id: summonsId, case_id: kase.id, recipient_name: "Ravi Patil", status: "PENDING", issued_at: new Date().toISOString(), expiry_at: new Date(Date.now() + 72 * 3_600_000).toISOString(), document_hash: "0x" + "ab".repeat(32), recipient_aadhaar_token: "0x" + "cd".repeat(32) });
  await call(police, "POST", `/api/court/summons/${summonsId}/attempts`, { body: { method: "in_person", outcome: "not_found", notes: "House locked" } });
  await call(police, "POST", `/api/court/summons/${summonsId}/attempts`, { body: { method: "affixture", outcome: "served" } });
  const status = await call(judge, "GET", `/api/court/cases/${kase.id}/summons`);
  assert.deepEqual(status.body.summons[0].attempts.map((a: any) => a.outcome), ["not_found", "served"]);
});

test("bail violations are ranked by severity, and GPS drift inside the accuracy radius is minor", () => {
  const base = { radiusMetres: 1000, hasExplanation: false, missedInLast30Days: 0, courtFinding: null };
  assert.equal(classifyViolation({ ...base, kind: "GEO_FENCE_BREACH", distanceMetres: 1040, accuracyMetres: 65 }).severity, "minor");
  assert.equal(classifyViolation({ ...base, kind: "GEO_FENCE_BREACH", distanceMetres: 1600, accuracyMetres: 20 }).severity, "moderate");
  assert.equal(classifyViolation({ ...base, kind: "GEO_FENCE_BREACH", distanceMetres: 9000, accuracyMetres: 20 }).severity, "serious");
  assert.equal(classifyViolation({ ...base, kind: "MISSED_CHECK_IN", distanceMetres: null, accuracyMetres: null, hasExplanation: true }).severity, "moderate");
  assert.equal(classifyViolation({ ...base, kind: "MISSED_CHECK_IN", distanceMetres: null, accuracyMetres: null, missedInLast30Days: 3 }).severity, "serious");
  assert.equal(classifyViolation({ ...base, kind: "GEO_FENCE_BREACH", distanceMetres: 1040, accuracyMetres: 65, courtFinding: "absconding" }).severity, "critical");
});

test("the court's bail view ranks real violations and shows the accused's reason beside a missed check-in", async () => {
  const accused = makeActor("accused");
  const bailId = seedBail(accused);
  const drift = randomUUID();
  const far = randomUUID();
  const missed = randomUUID();
  mem.table("violations").push(
    { id: drift, case_id: kase.id, bail_id: bailId, kind: "GEO_FENCE_BREACH", reason: "outside", detected_at: new Date(Date.now() - 3000).toISOString(), tx_hash: "0x" + "01".repeat(32) },
    { id: far, case_id: kase.id, bail_id: bailId, kind: "GEO_FENCE_BREACH", reason: "outside", detected_at: new Date(Date.now() - 2000).toISOString(), tx_hash: "0x" + "02".repeat(32) },
    { id: missed, case_id: kase.id, bail_id: bailId, kind: "MISSED_CHECK_IN", reason: "missed", detected_at: new Date(Date.now() - 1000).toISOString(), tx_hash: null }
  );
  mem.table("checkins").push(
    { id: randomUUID(), bail_id: bailId, case_id: kase.id, tx_hash: "0x" + "01".repeat(32), distance_metres: 2030, accuracy_metres: 45, within_fence: false, occurred_at: new Date().toISOString() },
    { id: randomUUID(), bail_id: bailId, case_id: kase.id, tx_hash: "0x" + "02".repeat(32), distance_metres: 15000, accuracy_metres: 10, within_fence: false, occurred_at: new Date().toISOString() }
  );

  const explained = await call(accused, "POST", `/api/court/bail/${bailId}/explanations`, { body: { violationId: missed, category: "medical", reason: "Admitted to Sassoon hospital overnight." } });
  assert.equal(explained.status, 201);
  assert.equal((await call(accused, "POST", `/api/court/bail/${bailId}/explanations`, { body: { violationId: missed, category: "other", reason: "Again, twice over" } })).status, 409);

  const view = await call(judge, "GET", "/api/court/bail/compliance");
  const order = view.body.violations.map((v: any) => [v.id, v.severity]);
  assert.deepEqual(order, [[far, "serious"], [missed, "moderate"], [drift, "minor"]]);
  assert.equal(view.body.violations[1].explanation.reason, "Admitted to Sassoon hospital overnight.");
  assert.match(view.body.violations[2].why, /GPS drift/);

  // A missed check-in with a reason is shown to the court; it does not change the order.
  assert.equal(mem.table("bail_conditions")[0].active, true);
  const other = makeActor("accused");
  assert.equal((await call(other, "POST", `/api/court/bail/${bailId}/explanations`, { body: { category: "other", reason: "Not my order at all" } })).status, 404);
});

/* ------------------------------------------------------------- F18 */
test("reminders go out once per deadline through the configured provider, without case content", async () => {
  const accused = makeActor("accused");
  seedBail(accused, { created_at: new Date(Date.now() - 6.5 * 86_400_000).toISOString() });
  mem.table("summons").push({ id: randomUUID(), case_id: kase.id, recipient_user_id: accused.id, recipient_name: "x", status: "PENDING", issued_at: new Date().toISOString(), expiry_at: new Date(Date.now() + 5 * 3_600_000).toISOString(), document_hash: "0x" + "ab".repeat(32), recipient_aadhaar_token: "0x" + "cd".repeat(32) });

  const delivered: any[] = [];
  setNotificationProvider({ name: "sandbox", deliver: async (m) => (delivered.push(m), { status: "sent" }) });
  await sendReminders();
  await sendReminders();
  assert.deepEqual(delivered.map((d) => d.template).sort(), ["checkin_due", "summons_due"]);
  assert.equal(mem.table("notification_outbox").length, 2);

  const mine = await call(accused, "GET", "/api/court/me/notifications");
  assert.ok(mine.body.notifications.every((n: any) => n.body.includes(kase.case_reference) && !n.body.includes("Burglary")), JSON.stringify(mine.body));
  const obligations = await call(accused, "GET", "/api/court/me/obligations");
  assert.equal(obligations.body.bail[0].overdue, false);
  assert.equal(obligations.body.summons.length, 1);
});

/* ------------------------------------------------------------- F5 */
test("AI explanations list rule findings first, label forest-only flags, and reviews change nothing", async () => {
  const explained = explainScreening(
    {
      anomaly: true,
      score: 0.81,
      reasons: [
        "The combination of size, timing and location is unlike routine intake, though no single field is individually implausible.",
        "The file was last modified after the claimed collection time.",
      ],
    },
    { gps_status: "OK", gps_lat: 18.5 }
  );
  assert.deepEqual(explained.reasons.map((r) => r.kind), ["rule", "statistical_outlier"]);
  assert.equal(explained.reasons[1].label, "Unexplained statistical outlier");

  const noGps = explainScreening({ anomaly: true, reasons: ["Coordinates are null island (0, 0): the GPS fix probably failed."] }, { gps_status: "NO_GPS", gps_lat: null });
  assert.equal(noGps.reasons[0].kind, "context", "a missing fix is explained, not presented as a GPS fault");

  const flagId = randomUUID();
  mem.table("ai_flags").push({ id: flagId, model: "evidence_anomaly", model_version: "synthetic-v1", subject_type: "case", subject_id: kase.id, case_id: kase.id, input: {}, output: { anomaly: true, score: 0.9, reasons: ["The collection timestamp is in the future."] }, payload_hash: "0x" + "ee".repeat(32), created_at: new Date().toISOString() });
  const insights = await call(judge, "GET", `/api/ai/cases/${kase.id}/insights`);
  assert.match(insights.body.banner, /Decision support only/);
  assert.match(insights.body.trainingCaveat, /synthetic/);

  assert.equal((await call(judge, "POST", `/api/ai/flags/${flagId}/review`, { body: { decision: "contest", reason: "short" } })).status, 400);
  const reviewed = await call(judge, "POST", `/api/ai/flags/${flagId}/review`, { body: { decision: "contest", reason: "The device clock was set to a wrong time zone." } });
  assert.equal(reviewed.status, 201);
  assert.equal(mem.table("cases")[0].status, "registered", "AI review never changes case status");
  assert.equal((await call(makeActor("accused"), "GET", `/api/ai/cases/${kase.id}/insights`)).status, 403);
});
