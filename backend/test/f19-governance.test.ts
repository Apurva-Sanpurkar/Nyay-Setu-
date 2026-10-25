import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "crypto";
import { unzipSync, strFromU8 } from "fflate";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { captureEvidence, createCase, manifestFor, sha, uploadEvidence } from "./support/evidence";
import { env } from "../src/config/env";
import { DEFAULT_SECTION63 } from "../src/services/certificate.service";
import { randomUUID } from "crypto";

after(stopServer);

let fake: FakeChain;
let police: Actor;
let judge: Actor;
let kase: { id: string; case_reference: string };
const depth = env.confirmationDepth;

beforeEach(async () => {
  resetDatabase();
  mem.table("document_templates").push({ id: randomUUID(), ...DEFAULT_SECTION63 });
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  police = makeActor("police");
  mem.table("users").find((u) => u.id === police.id)!.designation = "Police Inspector";
  judge = makeActor("judge");
  kase = await createCase(police, { fir: { number: "SECRET-FIR-55", year: 2026 }, origin: "fir" });
  assign(judge, kase.id, "write");
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = depth;
});

test("closing a case needs two different people, and the second must be a judge or the registry", async () => {
  const request = await call(police, "POST", "/api/governance/approvals", {
    body: { action: "case_close", subjectId: kase.id, reason: "Trial concluded; judgment delivered." },
  });
  assert.equal(request.status, 201, JSON.stringify(request.body));
  const id = request.body.approval.id;

  // The police officer cannot approve (wrong role); a judge who requested cannot approve their own.
  assert.equal((await call(police, "POST", `/api/governance/approvals/${id}/decide`, { body: { decision: "approve", reason: "approving my own request" } })).status, 403);

  const judgeRequest = await call(judge, "POST", "/api/governance/approvals", {
    body: { action: "case_close", subjectId: (await createCase(police)).id, reason: "Closing an unrelated case" },
  });
  assert.equal(judgeRequest.status, 403, "a judge not assigned to that case cannot even request");

  const outsider = makeActor("judge");
  assert.equal((await call(outsider, "POST", `/api/governance/approvals/${id}/decide`, { body: { decision: "approve", reason: "outsider approving" } })).status, 403);

  const approved = await call(judge, "POST", `/api/governance/approvals/${id}/decide`, { body: { decision: "approve", reason: "Judgment on record." } });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.approval.status, "executed");
  assert.equal(approved.body.approval.approver_id, judge.id);
  assert.equal(approved.body.approval.requested_by, police.id);
  assert.equal(mem.table("cases").find((c) => c.id === kase.id)!.status, "disposed");

  // Decided once only.
  assert.equal((await call(makeActor("court_admin"), "POST", `/api/governance/approvals/${id}/decide`, { body: { decision: "reject", reason: "too late to decide" } })).status, 409);
});

test("a judge who requests an action cannot approve it themselves", async () => {
  const request = await call(judge, "POST", "/api/governance/approvals", {
    body: { action: "case_close", subjectId: kase.id, reason: "Closing at the end of trial." },
  });
  assert.equal(request.status, 201);
  const self = await call(judge, "POST", `/api/governance/approvals/${request.body.approval.id}/decide`, { body: { decision: "approve", reason: "approving my own request" } });
  assert.equal(self.status, 403);
  assert.match(self.body.error.message, /cannot also approve/);
  assert.ok(mem.table("action_log").some((a) => a.action === "approval.self_approval_refused"));
  assert.equal(mem.table("cases").find((c) => c.id === kase.id)!.status, "registered");
});

test("a legal hold blocks disposal, even one placed after the request; release needs a reason", async () => {
  const { response } = await uploadEvidence(police, kase.id);
  const evidenceId = response.body.evidence.id;
  const destroy = { action: "evidence_destroy", subjectId: evidenceId, reason: "Perishable item; order of the court.", payload: { method: "destroyed" } };

  const hold = await call(judge, "POST", "/api/governance/holds", { body: { subjectType: "case", subjectId: kase.id, caseId: kase.id, reason: "Appeal pending in the High Court." } });
  assert.equal(hold.status, 201);
  const blocked = await call(police, "POST", "/api/governance/approvals", { body: destroy });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error.message, /legal hold/i);

  assert.equal((await call(police, "POST", `/api/governance/holds/${hold.body.hold.id}/release`, { body: { reason: "No longer needed" } })).status, 403);
  assert.equal((await call(judge, "POST", `/api/governance/holds/${hold.body.hold.id}/release`, { body: { reason: "short" } })).status, 400);
  assert.equal((await call(judge, "POST", `/api/governance/holds/${hold.body.hold.id}/release`, { body: { reason: "Appeal dismissed on 12 October." } })).status, 200);

  const request = await call(police, "POST", "/api/governance/approvals", { body: destroy });
  assert.equal(request.status, 201);
  // A new hold, placed after the request but before approval.
  await call(judge, "POST", "/api/governance/holds", { body: { subjectType: "evidence", subjectId: evidenceId, caseId: kase.id, reason: "Fresh application for re-examination." } });
  const stillBlocked = await call(judge, "POST", `/api/governance/approvals/${request.body.approval.id}/decide`, { body: { decision: "approve", reason: "Approved per order." } });
  assert.equal(stillBlocked.status, 409);
  assert.equal(mem.table("disposal_records").length, 0);
});

test("disposal with two people leaves a record and closes the malkhana register for the item", async () => {
  const { response } = await uploadEvidence(police, kase.id);
  const evidenceId = response.body.evidence.id;
  const request = await call(police, "POST", "/api/governance/approvals", {
    body: { action: "evidence_destroy", subjectId: evidenceId, reason: "Returned to owner at the end of trial.", payload: { method: "returned_to_owner", witnesses: [{ name: "Head Constable More" }] } },
  });
  const done = await call(judge, "POST", `/api/governance/approvals/${request.body.approval.id}/decide`, { body: { decision: "approve", reason: "Per judgment." } });
  assert.equal(done.status, 200);
  const record = mem.table("disposal_records")[0];
  assert.equal(record.method, "returned_to_owner");
  assert.equal(record.approval_id, request.body.approval.id);
  const moved = await call(police, "POST", `/api/police/evidence/${evidenceId}/malkhana`, { body: { movement: "IN", location: "Malkhana", reason: "after disposal" } });
  assert.equal(moved.status, 409);
});

test("custody after a mismatch is released for review only by two people", async () => {
  const bytes = randomBytes(2000);
  const { response } = await uploadEvidence(police, kase.id, { bytes });
  const evidenceId = response.body.evidence.id;
  const lab = makeActor("forensic_lab");
  assign(lab, kase.id, "write");
  const altered = Buffer.from(bytes);
  altered[3] ^= 1;
  await call(lab, "POST", `/api/evidence/${evidenceId}/custody`, { body: { confirmedHash: sha(altered) } });
  assert.equal((await call(lab, "GET", `/api/evidence/${evidenceId}/verification`)).body.verification.state, "INTEGRITY_MISMATCH");

  const request = await call(lab, "POST", "/api/governance/approvals", { body: { action: "custody_after_mismatch", subjectId: evidenceId, reason: "Lab copy was corrupted in transfer; original sealed drive intact." } });
  assert.equal(request.status, 201);
  await call(judge, "POST", `/api/governance/approvals/${request.body.approval.id}/decide`, { body: { decision: "approve", reason: "Re-examine from the sealed original." } });
  const after = await call(lab, "GET", `/api/evidence/${evidenceId}/verification`);
  assert.equal(after.body.verification.state, "REVIEW_REQUIRED");
  assert.equal(after.body.history.at(-1).reason_code, "TWO_PERSON_RELEASE");
});

test("the export bundle contains only what the requester can see, with sums and a README", async () => {
  const bytes = randomBytes(3000);
  const captured = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  const ref = captured.body.evidence.public_ref;

  const own = await call(police, "GET", `/api/governance/export?caseId=${kase.id}`);
  assert.equal(own.status, 200);
  const files = unzipSync(new Uint8Array(own.raw));
  const names = Object.keys(files);
  for (const name of ["README.md", "bundle.json", "SHA256SUMS.txt", `evidence/${ref}/passport.pdf`, `evidence/${ref}/custody-form.pdf`, `evidence/${ref}/section63-certificate.pdf`, `evidence/${ref}/chain-proofs.json`, `evidence/${ref}/capture-manifest.json`]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  const evidenceFile = names.find((n) => n.startsWith(`evidence/${ref}/file/`))!;
  assert.equal("0x" + createHash("sha256").update(files[evidenceFile]).digest("hex"), sha(bytes));
  for (const line of strFromU8(files["SHA256SUMS.txt"]).trim().split("\n")) {
    const [sum, path] = line.split("  ");
    assert.equal(createHash("sha256").update(files[path]).digest("hex"), sum, path);
  }
  const manifest = JSON.parse(strFromU8(files["bundle.json"]));
  assert.equal(manifest.case.fir.number, "SECRET-FIR-55");
  const proofs = JSON.parse(strFromU8(files[`evidence/${ref}/chain-proofs.json`]));
  assert.ok(proofs[0].tx_hash && proofs[0].block_number);

  const defence = makeActor("defence_lawyer");
  assign(defence, kase.id, "read");
  const theirs = unzipSync(new Uint8Array((await call(defence, "GET", `/api/governance/export?caseId=${kase.id}`)).raw));
  const theirNames = Object.keys(theirs);
  assert.ok(!theirNames.some((n) => n.includes("/file/")), "no evidence files for defence");
  assert.ok(!theirNames.some((n) => n.endsWith("section63-certificate.pdf")));
  const everything = theirNames.map((n) => strFromU8(theirs[n], true)).join("\n");
  assert.ok(!everything.includes("SECRET-FIR-55"), "no FIR number for defence");

  assert.equal((await call(makeActor("prosecutor"), "GET", `/api/governance/export?caseId=${kase.id}`)).status, 403, "strangers refused");
  const accused = makeActor("accused");
  assign(accused, kase.id, "read");
  assert.equal((await call(accused, "GET", `/api/governance/export?caseId=${kase.id}`)).status, 403);
});
