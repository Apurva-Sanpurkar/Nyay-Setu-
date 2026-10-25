import { test, after, beforeEach, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "crypto";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { env } from "../src/config/env";
import {
  STATES,
  TRANSITIONS,
  assertConfirmationProof,
  assertTransition,
  canTransition,
  decide,
  IllegalTransitionError,
  type Observation,
} from "../src/services/verification/stateMachine";
import { loadAnchor, trackAnchors, transition } from "../src/services/verification/anchors";

after(stopServer);

const sha = (bytes: Buffer) => "0x" + createHash("sha256").update(bytes).digest("hex");
const HASH = (c: string) => "0x" + c.repeat(64);

/* ======================================================= pure state machine */

describe("transition table", () => {
  test("every one of the 36 pairs is legal exactly when the table says so", () => {
    let legal = 0;
    for (const from of STATES) {
      for (const to of STATES) {
        const expected = TRANSITIONS[from].includes(to);
        assert.equal(canTransition(from, to), expected, `${from} → ${to}`);
        if (expected) {
          assert.doesNotThrow(() => assertTransition(from, to));
          legal++;
        } else {
          assert.throws(() => assertTransition(from, to), IllegalTransitionError, `${from} → ${to}`);
        }
      }
    }
    assert.equal(legal, 16, "the table has 16 legal edges");
  });

  test("nothing reaches CONFIRMED except from SUBMITTED or after review", () => {
    const into = STATES.filter((s) => canTransition(s, "CONFIRMED"));
    assert.deepEqual(into.sort(), ["REVIEW_REQUIRED", "SUBMITTED"]);
    assert.ok(!canTransition("LOCAL_ONLY", "CONFIRMED"), "an offline record can never jump to confirmed");
    assert.ok(!canTransition("SYNC_ERROR", "CONFIRMED"));
    assert.deepEqual(TRANSITIONS.INTEGRITY_MISMATCH, ["REVIEW_REQUIRED"]);
  });

  test("CONFIRMED needs proof: receipt, event, digest and depth", () => {
    const good = { receiptStatus: 1, eventMatched: true, digestMatched: true, confirmations: 3, required: 3, blockHash: HASH("a") } as const;
    assert.doesNotThrow(() => assertConfirmationProof(good));
    assert.throws(() => assertConfirmationProof(undefined));
    assert.throws(() => assertConfirmationProof({ ...good, confirmations: 2 }));
    assert.throws(() => assertConfirmationProof({ ...good, blockHash: "nope" }));
    assert.throws(() => assertConfirmationProof({ ...good, digestMatched: false as any }));
  });
});

describe("decide(): what an observation justifies", () => {
  const policy = { depth: 3, pendingTimeoutMs: 30 * 60_000, droppedAfterMs: 10 * 60_000 };
  const submitted = { state: "SUBMITTED" as const, blockHash: null };
  const receipt = (status: 0 | 1, blockNumber = 100) => ({ status, blockNumber, blockHash: HASH("b") });
  const event = (o: Partial<NonNullable<Observation["event"]>> = {}) => ({
    found: true,
    digestMatches: true,
    argsMatch: true,
    chainRecordId: 7,
    ...o,
  });
  const seen = (o: Partial<Observation>): Observation => ({ ageMs: 60_000, receipt: null, txKnown: true, head: 100, event: null, ...o });

  const cases: [string, Observation, string | null, string][] = [
    ["RPC down", seen({ rpcFailed: true }), null, "RPC_UNAVAILABLE"],
    ["no receipt yet", seen({}), null, "AWAITING_RECEIPT"],
    ["dropped", seen({ txKnown: false, ageMs: 11 * 60_000 }), "SYNC_ERROR", "DROPPED"],
    ["unknown but young", seen({ txKnown: false, ageMs: 60_000 }), null, "AWAITING_RECEIPT"],
    ["pending too long", seen({ ageMs: 31 * 60_000 }), "REVIEW_REQUIRED", "PENDING_TOO_LONG"],
    ["reverted", seen({ receipt: receipt(0) }), "SYNC_ERROR", "REVERTED"],
    ["event missing", seen({ receipt: receipt(1), event: event({ found: false }) }), "REVIEW_REQUIRED", "EVENT_MISSING"],
    ["digest differs", seen({ receipt: receipt(1), event: event({ digestMatches: false }) }), "INTEGRITY_MISMATCH", "EVENT_DIGEST_MISMATCH"],
    ["case differs", seen({ receipt: receipt(1), event: event({ argsMatch: false }) }), "REVIEW_REQUIRED", "EVENT_ARGS_MISMATCH"],
    ["1 of 3 confirmations", seen({ receipt: receipt(1, 100), head: 100, event: event() }), null, "AWAITING_CONFIRMATIONS"],
    ["3 of 3 confirmations", seen({ receipt: receipt(1, 100), head: 102, event: event() }), "CONFIRMED", "CONFIRMED"],
  ];

  for (const [label, observation, to, code] of cases) {
    test(label, () => {
      const decision = decide(submitted, observation, policy);
      assert.equal(decision.to, to);
      assert.equal(decision.code, code);
    });
  }

  test("a confirmed transaction whose receipt vanishes or moves block is sent to review", () => {
    const confirmed = { state: "CONFIRMED" as const, blockHash: HASH("b") };
    assert.equal(decide(confirmed, seen({ receipt: null }), policy).to, "REVIEW_REQUIRED");
    const moved = decide(confirmed, seen({ receipt: { status: 1, blockNumber: 101, blockHash: HASH("c") } }), policy);
    assert.equal(moved.to, "REVIEW_REQUIRED");
    assert.equal(moved.code, "REORGED");
    assert.equal(decide(confirmed, seen({ receipt: receipt(1) }), policy).to, null);
  });
});

/* =============================================== through the real routes */

describe("registration through the API with a simulated chain", () => {
  let fake: FakeChain;
  let police: Actor;
  let caseId: string;
  const originalDepth = env.confirmationDepth;

  beforeEach(async () => {
    resetDatabase();
    fake = new FakeChain().install();
    (env as any).confirmationDepth = 1;
    police = makeActor("police");
    const created = await call(police, "POST", "/api/cases", {
      body: { title: "Burglary", offenceType: "Burglary", policeStation: "Shivajinagar PS", origin: "complaint" },
    });
    caseId = created.body.case.id;
  });

  afterEach(() => {
    fake.uninstall();
    (env as any).confirmationDepth = originalDepth;
  });

  async function upload(actor: Actor, bytes = randomBytes(2048), headers: Record<string, string> = {}) {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "image/jpeg" }), "scene.jpg");
    form.append("caseId", caseId);
    form.append("clientHash", sha(bytes));
    form.append("kind", "photo");
    form.append("gpsLat", "18.5308");
    form.append("gpsLng", "73.8478");
    form.append("collectedAt", new Date().toISOString());
    return call(actor, "POST", "/api/evidence", { form, headers });
  }

  test("a healthy chain: SUBMITTED on send, CONFIRMED once the event and depth check out", async () => {
    const response = await upload(police);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(response.body.verification.state, "CONFIRMED");
    assert.equal(response.body.verification.verified, true);
    assert.equal(response.body.chain.chainEvidenceId, 1);

    const history = await call(police, "GET", `/api/evidence/${response.body.evidence.id}/verification`);
    assert.deepEqual(
      history.body.history.map((h: any) => `${h.from_state ?? "∅"}→${h.to_state}:${h.reason_code}`),
      ["∅→LOCAL_ONLY:CREATED", "LOCAL_ONLY→SUBMITTED:SENT", "SUBMITTED→CONFIRMED:CONFIRMED"]
    );
  });

  test("coordinates stay off chain unless explicitly enabled", async () => {
    await upload(police);
    const registration = fake.sent.find((s) => s.method === "registerEvidence")!;
    assert.equal(registration.args[2], 0n);
    assert.equal(registration.args[3], 0n);
    // And the officer identity is a pseudonym, not the Aadhaar token.
    assert.notEqual(registration.args[4], police.aadhaarToken);
  });

  test("with depth 3 the item waits in SUBMITTED until the tracker sees enough blocks", async () => {
    (env as any).confirmationDepth = 3;
    const response = await upload(police);
    assert.equal(response.body.verification.state, "SUBMITTED");
    assert.equal(response.body.verification.verified, false, "submitted is never shown as verified");

    fake.mine(1);
    await trackAnchors();
    const middle = await call(police, "GET", `/api/evidence/${response.body.evidence.id}/verification`);
    assert.equal(middle.body.verification.state, "SUBMITTED");
    assert.equal(middle.body.verification.confirmations, 2);

    fake.mine(1);
    await trackAnchors();
    const done = await call(police, "GET", `/api/evidence/${response.body.evidence.id}/verification`);
    assert.equal(done.body.verification.state, "CONFIRMED");
  });

  test("RPC down at send time: the item is kept, marked SYNC_ERROR, and a retry anchors it", async () => {
    fake.nextSend = "rpc-down";
    const response = await upload(police);
    assert.equal(response.status, 201);
    assert.equal(response.body.verification.state, "SYNC_ERROR");
    assert.equal(response.body.verification.failureCode, "RPC_UNAVAILABLE");
    assert.equal(mem.table("evidence_items").length, 1, "the item was not lost");
    assert.equal(mem.table("custody_events").length, 1, "its genesis custody record exists");

    const retried = await call(police, "POST", `/api/evidence/${response.body.evidence.id}/anchor/retry`);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.verification.state, "CONFIRMED");
    const row = mem.table("evidence_items")[0];
    assert.equal(row.chain_evidence_id, 1);
    assert.ok(mem.table("custody_events")[0].tx_hash, "the genesis custody record learned its transaction");
  });

  test("a chain that is not configured at all also lands in SYNC_ERROR, not a 503", async () => {
    fake.ready = false;
    const response = await upload(police);
    assert.equal(response.status, 201);
    assert.equal(response.body.verification.state, "SYNC_ERROR");
  });

  test("a transaction not mined within the request's wait stays SUBMITTED and the request still answers", async () => {
    fake.nextSend = "pending";
    const response = await upload(police);
    assert.equal(response.status, 201);
    assert.equal(response.body.verification.state, "SUBMITTED");
    assert.equal(response.body.verification.verified, false);
  });

  test("when the tracker confirms first, the request accepts that instead of failing", async () => {
    const response = await upload(police);
    const anchor = await loadAnchor(mem.table("evidence_items")[0].anchor_id);
    assert.equal(anchor.state, "CONFIRMED");
    // A second worker trying the same move finds it already done: no error.
    const stale = { ...anchor, state: "SUBMITTED" as const };
    const result = await transition(stale, "CONFIRMED", {
      code: "CONFIRMED",
      reason: "race",
      proof: { receiptStatus: 1, eventMatched: true, digestMatched: true, confirmations: 1, required: 1, blockHash: anchor.block_hash! },
    });
    assert.equal(result.state, "CONFIRMED");
    assert.ok(response.body.evidence.id);
  });

  test("a reverted registration is SYNC_ERROR with the reason, never confirmed", async () => {
    fake.nextSend = "revert";
    const response = await upload(police);
    assert.equal(response.body.verification.state, "SYNC_ERROR");
    assert.equal(response.body.verification.failureCode, "REVERTED");
    assert.equal(response.body.chain.chainEvidenceId, null);
  });

  test("duplicate submit with one Idempotency-Key registers once", async () => {
    const bytes = randomBytes(4096);
    const headers = { "idempotency-key": "capture-0001-abcdef" };
    const [first, second] = await Promise.all([upload(police, bytes, headers), upload(police, bytes, headers)]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 201]);
    assert.equal(first.body.evidence.id, second.body.evidence.id);
    assert.equal(mem.table("evidence_items").length, 1);
    assert.equal(fake.sent.filter((s) => s.method === "registerEvidence").length, 1, "one transaction");

    const third = await upload(police, bytes, headers);
    assert.equal(third.status, 200);
    assert.equal(third.body.replayed, true);

    const otherOfficer = makeActor("police");
    assign(otherOfficer, caseId, "write");
    assert.equal((await upload(otherOfficer, bytes, headers)).status, 409, "a key cannot be reused by someone else");
  });

  test("a retry never resends when the earlier transaction did land", async () => {
    fake.holdReceipts = true;
    (env as any).confirmationDepth = 1;
    const response = await upload(police);
    const id = response.body.evidence.id;
    const anchor = await loadAnchor(mem.table("evidence_items")[0].anchor_id);
    // Force a review state, as the tracker would after a long wait.
    await transition(anchor, "REVIEW_REQUIRED", { code: "PENDING_TOO_LONG", reason: "test" });

    // The transaction is mined after all.
    const sent = fake.sent[0];
    fake.receipts.set(sent.txHash, {
      status: 1,
      blockNumber: fake.head,
      blockHash: HASH("e"),
      events: [{ name: "EvidenceRegistered", args: { evidenceId: "1", caseId: sent.args[0], fileHash: sent.args[1] } }],
    });

    const retried = await call(police, "POST", `/api/evidence/${id}/anchor/retry`);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.verification.state, "CONFIRMED");
    assert.equal(fake.sent.length, 1, "no second registration was sent");
  });

  test("the tracker catches a dropped transaction and a reorg", async () => {
    (env as any).confirmationDepth = 3;
    const dropped = await upload(police);
    const tx = dropped.body.verification.txHash;
    fake.drop(tx);
    const anchor = await loadAnchor(mem.table("evidence_items")[0].anchor_id);
    // Age the submission past DROPPED_AFTER_MINUTES.
    mem.table("anchors").find((a) => a.id === anchor.id)!.submitted_at = new Date(Date.now() - 3_600_000).toISOString();
    await trackAnchors();
    assert.equal((await loadAnchor(anchor.id)).state, "SYNC_ERROR");
    assert.equal((await loadAnchor(anchor.id)).failure_code, "DROPPED");

    (env as any).confirmationDepth = 1;
    const second = await upload(police);
    assert.equal(second.body.verification.state, "CONFIRMED");
    fake.reorg(second.body.verification.txHash);
    await trackAnchors();
    const after = await call(police, "GET", `/api/evidence/${second.body.evidence.id}/verification`);
    assert.equal(after.body.verification.state, "REVIEW_REQUIRED");
    assert.equal(after.body.verification.failureCode, "REORGED");
  });

  test("the tracker leaves state alone while the RPC is down", async () => {
    (env as any).confirmationDepth = 3;
    const response = await upload(police);
    fake.rpcDown = true;
    fake.mine(5);
    await trackAnchors();
    const view = await call(police, "GET", `/api/evidence/${response.body.evidence.id}/verification`);
    assert.equal(view.body.verification.state, "SUBMITTED");
  });

  test("an illegal transition is refused and written to the action log", async () => {
    const response = await upload(police);
    const anchor = await loadAnchor(mem.table("evidence_items")[0].anchor_id);
    assert.equal(anchor.state, "CONFIRMED");
    await assert.rejects(transition(anchor, "LOCAL_ONLY", { code: "TEST", reason: "should fail" }), /Illegal verification transition/);
    const refused = mem.table("action_log").filter((a) => a.action === "verification.illegal_transition");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].outcome, "refused");
    assert.ok(response.body.evidence.id);
  });

  test("custody is decided by the chain: a tampered database cannot wave a tampered file through", async () => {
    const genuine = randomBytes(3000);
    const registered = await upload(police, genuine);
    const id = registered.body.evidence.id;

    const lab = makeActor("forensic_lab");
    assign(lab, caseId, "write");

    // Someone edits the database so it agrees with a doctored file.
    const doctored = Buffer.concat([genuine, Buffer.from([1])]);
    mem.table("evidence_items")[0].file_hash = sha(doctored);

    const refused = await call(lab, "POST", `/api/evidence/${id}/custody`, { body: { confirmedHash: sha(doctored) } });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, "HASH_MISMATCH");
    assert.match(refused.body.error.message, /integrity-check transaction, which succeeded/);
    assert.ok(!fake.sent.some((s) => s.method === "transferCustody"), "transferCustody was never sent");

    const state = await call(lab, "GET", `/api/evidence/${id}/verification`);
    assert.equal(state.body.verification.state, "INTEGRITY_MISMATCH");
    assert.equal(mem.table("integrity_checks")[0].matched, false);
  });

  test("custody moves when the chain confirms the receiver holds the registered file", async () => {
    const genuine = randomBytes(3000);
    const registered = await upload(police, genuine);
    const lab = makeActor("forensic_lab");
    assign(lab, caseId, "write");

    const moved = await call(lab, "POST", `/api/evidence/${registered.body.evidence.id}/custody`, {
      body: { confirmedHash: sha(genuine) },
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.toStage, "FORENSIC_LAB");
    assert.equal(moved.body.verification.state, "CONFIRMED");
    assert.deepEqual(
      fake.sent.map((s) => s.method),
      ["registerEvidence", "reportIntegrityCheck", "transferCustody"]
    );
  });

  test("a failed integrity-check send leaves custody where it was", async () => {
    const genuine = randomBytes(3000);
    const registered = await upload(police, genuine);
    const lab = makeActor("forensic_lab");
    assign(lab, caseId, "write");
    fake.nextSend = "rpc-down";
    const response = await call(lab, "POST", `/api/evidence/${registered.body.evidence.id}/custody`, {
      body: { confirmedHash: sha(genuine) },
    });
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, "INTEGRITY_CHECK_NOT_RECORDED");
    assert.equal(mem.table("evidence_items")[0].current_stage, "SCENE");
  });

  test("retry and recheck are refused to roles and people without access", async () => {
    fake.nextSend = "rpc-down";
    const response = await upload(police);
    const id = response.body.evidence.id;

    const stranger = makeActor("police");
    assert.equal((await call(stranger, "POST", `/api/evidence/${id}/anchor/retry`)).status, 403);
    assert.equal((await call(stranger, "POST", `/api/evidence/${id}/anchor/recheck`)).status, 403);

    const defence = makeActor("defence_lawyer");
    assign(defence, caseId, "read");
    assert.equal((await call(defence, "POST", `/api/evidence/${id}/anchor/retry`)).status, 403);
    assert.equal((await call(defence, "GET", `/api/evidence/${id}/verification`)).status, 200);
  });
});
