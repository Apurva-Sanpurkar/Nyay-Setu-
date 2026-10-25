import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { captureEvidence, createCase, manifestFor, sha, uploadEvidence } from "./support/evidence";
import { env } from "../src/config/env";
import { detectDiscrepancies } from "../src/services/alerts.service";

after(stopServer);

let fake: FakeChain;
let police: Actor;
let lab: Actor;
let kase: { id: string; case_reference: string };
const depth = env.confirmationDepth;

beforeEach(async () => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  police = makeActor("police");
  lab = makeActor("forensic_lab");
  kase = await createCase(police);
  assign(lab, kase.id, "write");
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = depth;
});

async function atLab(bytes = randomBytes(3000)) {
  const { response } = await uploadEvidence(police, kase.id, { bytes });
  const id = response.body.evidence.id;
  const moved = await call(lab, "POST", `/api/evidence/${id}/custody`, { body: { confirmedHash: sha(bytes) } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  return { id, bytes };
}

test("intake with an intact seal and a matching re-hash is recorded and anchored", async () => {
  const { id, bytes } = await atLab();
  const intake = await call(lab, "POST", `/api/lab/evidence/${id}/intake`, {
    body: { sealIntact: true, conditionNotes: "Sealed envelope, signatures intact", recheckSha256: sha(bytes) },
  });
  assert.equal(intake.status, 201, JSON.stringify(intake.body));
  assert.equal(intake.body.matched, true);
  assert.equal(intake.body.verification.state, "CONFIRMED");
  assert.equal(mem.table("discrepancy_alerts").length, 0);
});

test("a re-hash on arrival that does not match goes the INTEGRITY_MISMATCH way and raises a serious alert", async () => {
  const { id, bytes } = await atLab();
  const altered = Buffer.from(bytes);
  altered[0] ^= 1;
  const intake = await call(lab, "POST", `/api/lab/evidence/${id}/intake`, { body: { sealIntact: true, recheckSha256: sha(altered) } });
  assert.equal(intake.status, 201);
  assert.equal(intake.body.matched, false);
  // On chain by a transaction that succeeded, not a revert.
  assert.ok(fake.sent.some((s) => s.method === "reportIntegrityCheck"));
  assert.equal(fake.registry.get(1)!.mismatchCount, 1);

  const state = await call(lab, "GET", `/api/evidence/${id}/verification`);
  assert.equal(state.body.verification.state, "INTEGRITY_MISMATCH");
  const alerts = mem.table("discrepancy_alerts");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "HASH_MISMATCH");
  assert.equal(alerts[0].severity, "serious");
});

test("a broken seal must be described and raises its own alert", async () => {
  const { id, bytes } = await atLab();
  assert.equal((await call(lab, "POST", `/api/lab/evidence/${id}/intake`, { body: { sealIntact: false, recheckSha256: sha(bytes) } })).status, 400);
  await call(lab, "POST", `/api/lab/evidence/${id}/intake`, { body: { sealIntact: false, sealNotes: "Tape lifted at one corner", recheckSha256: sha(bytes) } });
  const alerts = mem.table("discrepancy_alerts");
  assert.equal(alerts[0].kind, "SEAL_BROKEN");
  assert.equal(alerts[0].severity, "warning", "warning, because the digest still matched");
});

test("packaging photographs: the lab may capture them live, and nothing else", async () => {
  const bytes = randomBytes(1500);
  const photo = await captureEvidence(lab, kase.id, manifestFor(lab, kase.case_reference, bytes, { purpose: "lab_intake" }), bytes);
  assert.equal(photo.status, 201, JSON.stringify(photo.body));
  const general = randomBytes(1500);
  assert.equal((await captureEvidence(lab, kase.id, manifestFor(lab, kase.case_reference, general), general)).status, 403);
  assert.equal((await uploadEvidence(lab, kase.id)).response.status, 403);
});

test("working copies are linked to the original with their derivation, and anchored", async () => {
  const { id } = await atLab();
  const copy = await call(lab, "POST", `/api/lab/evidence/${id}/working-copies`, {
    body: { copySha256: "0x" + "cc".repeat(32), tool: "FTK Imager", toolVersion: "4.7.1", method: "Logical copy of the image to a sterile drive" },
  });
  assert.equal(copy.status, 201, JSON.stringify(copy.body));
  assert.equal(copy.body.verification.state, "CONFIRMED");
  const detail = await call(police, "GET", `/api/lab/evidence/${id}`);
  assert.equal(detail.body.workingCopies[0].original_evidence_id, id);
  assert.equal(detail.body.workingCopies[0].tool_version, "4.7.1");
});

test("reports are immutable: a correction is a new version that supersedes the latest", async () => {
  const { id } = await atLab();
  const body = { conclusion: "No evidence of editing; EXIF consistent.", tool: "ExifTool 12.7", method: "Metadata and error-level analysis" };
  const first = await call(lab, "POST", `/api/lab/evidence/${id}/reports`, { body });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.report.version, 1);
  assert.equal((await call(lab, "POST", `/api/lab/evidence/${id}/reports`, { body })).status, 409, "no second original");

  const corrected = await call(lab, "POST", `/api/lab/evidence/${id}/reports`, {
    body: { ...body, conclusion: "Corrected: timestamp offset explained by device time zone.", supersedesId: first.body.report.id },
  });
  assert.equal(corrected.status, 201);
  assert.equal(corrected.body.report.version, 2);
  assert.equal(corrected.body.report.supersedes_id, first.body.report.id);
  assert.equal(corrected.body.verification.state, "CONFIRMED", "the correction has its own anchor");
  assert.deepEqual(fake.sent.filter((s) => s.method === "anchorForensicResult").length, 1, "write-once on chain respected");
});

test("the lab queue shows status and turnaround per case", async () => {
  const { id, bytes } = await atLab();
  const intake = await call(lab, "POST", `/api/lab/evidence/${id}/intake`, { body: { sealIntact: true, recheckSha256: sha(bytes) } });
  const intakeId = intake.body.intake.id;
  assert.equal((await call(lab, "PATCH", `/api/lab/intakes/${intakeId}`, { body: { status: "in_analysis" } })).status, 200);
  assert.equal((await call(lab, "PATCH", `/api/lab/intakes/${intakeId}`, { body: { status: "received" } })).status, 400);
  await call(lab, "PATCH", `/api/lab/intakes/${intakeId}`, { body: { status: "reported" } });
  const queue = await call(lab, "GET", "/api/lab/queue");
  assert.equal(queue.body.items[0].queueStatus, "reported");
  assert.equal(queue.body.turnaround[0].reported, 1);
  assert.equal((await call(makeActor("defence_lawyer"), "GET", "/api/lab/queue")).status, 403);
});

test("seeded discrepancies are each raised once, explained, and resolved only with a reason", async () => {
  // A failed anchor, a capture with a bad signature and skewed clock, and an item left at the scene for days.
  fake.nextSend = "rpc-down";
  await uploadEvidence(police, kase.id);
  const bytes = randomBytes(1000);
  const captured = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes, {
    deviceClockAtSendMs: Date.now() + 7_200_000,
    signature: { alg: "ECDSA-P256-SHA256", keyId: "no-such-key-001", value: "AAAA" },
  });
  mem.table("evidence_items").find((e) => e.id === captured.body.evidence.id)!.signature_status = "invalid";
  const stale = mem.table("evidence_items").find((e) => e.id === captured.body.evidence.id)!;
  stale.created_at = new Date(Date.now() - 100 * 3_600_000).toISOString();
  for (const c of mem.table("custody_events")) if (c.evidence_id === stale.id) c.occurred_at = stale.created_at;

  await detectDiscrepancies();
  await detectDiscrepancies();
  const kinds = mem.table("discrepancy_alerts").map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["CLOCK_SKEW", "CUSTODY_GAP", "SIGNATURE_INVALID", "SYNC_FAILED"], "each raised once, however often detection runs");
  assert.ok(mem.table("discrepancy_alerts").every((a) => a.explanation.length > 40));

  const listed = await call(police, "GET", `/api/alerts?caseId=${kase.id}`);
  assert.equal(listed.body.alerts.length, 4);
  const alertId = listed.body.alerts[0].id;
  assert.equal((await call(police, "POST", `/api/alerts/${alertId}/acknowledge`)).status, 200);
  assert.equal((await call(police, "POST", `/api/alerts/${alertId}/comments`, { body: { body: "Checking with the station" } })).status, 201);
  assert.equal((await call(police, "POST", `/api/alerts/${alertId}/resolve`, { body: { resolution: "ok" } })).status, 400);
  const resolved = await call(police, "POST", `/api/alerts/${alertId}/resolve`, { body: { resolution: "Re-anchored after the RPC outage." } });
  assert.equal(resolved.body.alert.status, "resolved");
  assert.equal(mem.table("action_log").filter((a) => a.action.startsWith("alert.")).length, 3);

  // Alerts change nothing on their own: no case or item state moved because of them.
  assert.equal(mem.table("cases")[0].status, "registered");

  const stranger = makeActor("police");
  assert.equal((await call(stranger, "POST", `/api/alerts/${alertId}/comments`, { body: { body: "x" } })).status, 403);
  assert.equal((await call(makeActor("accused"), "GET", "/api/alerts")).status, 403);
});

test("the audit timeline labels every entry and lists what could not be verified", async () => {
  const { id } = await atLab();
  fake.nextSend = "rpc-down";
  await uploadEvidence(police, kase.id);
  const timeline = await call(police, "GET", `/api/alerts/cases/${kase.id}/timeline`);
  assert.equal(timeline.status, 200);
  const trusts = new Set(timeline.body.entries.map((e: any) => e.trust));
  assert.ok(trusts.has("VERIFIED_ON_CHAIN"));
  assert.ok(trusts.has("DB_ONLY"));
  assert.ok(trusts.has("PENDING"));
  assert.ok(timeline.body.notVerified.length >= 1, "the failed anchor is listed, not hidden behind a green badge");
  assert.ok(id);
});
