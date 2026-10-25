import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { captureEvidence, createCase, manifestFor, sha, uploadEvidence } from "./support/evidence";
import { env } from "../src/config/env";

after(stopServer);

let fake: FakeChain;
let police: Actor;
const originalDepth = env.confirmationDepth;

beforeEach(() => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  police = makeActor("police", { name: "Inspector Leakwell" });
});

afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = originalDepth;
});

async function registered(bytes = randomBytes(4096)) {
  const kase = await createCase(police);
  const { response } = await uploadEvidence(police, kase.id, { bytes });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { kase, bytes, evidence: response.body.evidence, ref: response.body.evidence.public_ref as string };
}

test("a reference is unguessable: 128 random bits in Crockford base32", async () => {
  const refs = new Set<string>();
  const kase = await createCase(police);
  for (let i = 0; i < 5; i++) {
    const { response } = await uploadEvidence(police, kase.id);
    refs.add(response.body.evidence.public_ref);
  }
  assert.equal(refs.size, 5);
  for (const ref of refs) assert.match(ref, /^NSE-[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("the public page needs no sign-in and reads the digest from the chain", async () => {
  const { ref, bytes } = await registered();
  const response = await call(null, "GET", `/api/public/verify/${ref}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const p = response.body.passport;
  assert.equal(p.reference, ref);
  assert.equal(p.digest, sha(bytes));
  assert.equal(p.digestSource, "chain");
  assert.equal(p.agreement, "AGREES");
  assert.equal(p.state, "CONFIRMED");
  assert.equal(p.verified, true);
  assert.ok(p.registeredAt);
  assert.ok(p.transaction.hash);
  assert.deepEqual(p.custody.map((c: any) => c.type), ["REGISTERED"]);
  assert.match(p.limits, /does not prove/);
});

test("the genuine file matches; a modified copy does not", async () => {
  const { ref, bytes } = await registered();
  const genuine = await call(null, "POST", `/api/public/verify/${ref}/check`, { body: { sha256: sha(bytes) } });
  assert.equal(genuine.status, 200, JSON.stringify(genuine.body));
  assert.equal(genuine.body.result.matched, true);
  assert.equal(genuine.body.result.comparedAgainst, "chain");

  const modified = Buffer.from(bytes);
  modified[100] ^= 0x01;
  const tampered = await call(null, "POST", `/api/public/verify/${ref}/check`, { body: { sha256: sha(modified) } });
  assert.equal(tampered.body.result.matched, false);
});

test("unknown and malformed references are told apart, and both refused", async () => {
  await registered();
  assert.equal((await call(null, "GET", "/api/public/verify/NSE-00000000000000000000000000")).status, 404);
  assert.equal((await call(null, "GET", "/api/public/verify/not-a-ref")).status, 400);
  assert.equal((await call(null, "GET", "/api/public/verify/NSE-abc'%20or%201=1")).status, 400);
  assert.equal(
    (await call(null, "POST", "/api/public/verify/NSE-00000000000000000000000000/check", { body: { sha256: "0x" + "ab".repeat(32) } })).status,
    404
  );
  assert.equal(
    (await call(null, "POST", "/api/public/verify/NSE-00000000000000000000000000/check", { body: { sha256: "nope" } })).status,
    400
  );
});

test("when the database disagrees with the chain, the chain's value is shown and flagged", async () => {
  const { ref, evidence } = await registered();
  fake.setDigest(1, "0x" + "ee".repeat(32));
  const p = (await call(null, "GET", `/api/public/verify/${ref}`)).body.passport;
  assert.equal(p.digest, "0x" + "ee".repeat(32));
  assert.equal(p.agreement, "DISAGREES");
  assert.ok(p.flags.includes("RECORD_DISAGREES_WITH_CHAIN"));
  assert.equal(p.verified, false, "never verified while the record and the chain disagree");
  assert.ok(evidence.id);
});

test("when the chain cannot be read, nothing is shown as verified and the check refuses", async () => {
  const { ref, bytes } = await registered();
  fake.rpcDown = true;
  const p = (await call(null, "GET", `/api/public/verify/${ref}`)).body.passport;
  assert.equal(p.digestSource, "record");
  assert.ok(p.flags.includes("CHAIN_UNREADABLE"));
  assert.equal(p.verified, false);
  const check = await call(null, "POST", `/api/public/verify/${ref}/check`, { body: { sha256: sha(bytes) } });
  assert.equal(check.status, 503);
  assert.equal(check.body.error.code, "CANNOT_VERIFY_NOW");
});

test("an item that failed to anchor is shown honestly, not as verified", async () => {
  fake.nextSend = "rpc-down";
  const { ref } = await registered();
  const p = (await call(null, "GET", `/api/public/verify/${ref}`)).body.passport;
  assert.equal(p.state, "SYNC_ERROR");
  assert.equal(p.verified, false);
  assert.ok(p.flags.includes("NOT_ANCHORED"));
});

test("no personal or case data ever appears in a public response", async () => {
  const kase = await createCase(police, {
    title: "Narrative that must stay private",
    summary: "Witness Ramesh saw everything",
    fir: { number: "LEAK-FIR-7711", year: 2026 },
    origin: "fir",
  });
  const bytes = randomBytes(5000);
  const manifest = manifestFor(police, kase.case_reference, bytes, { deviceId: "device-leak-check-99" });
  const captured = await captureEvidence(police, kase.id, manifest, bytes);
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  const { response: uploaded } = await uploadEvidence(police, kase.id, { notes: "Bag sealed by constable Sunita" });

  const forbiddenValues = [
    "LEAK-FIR-7711",
    "Narrative that must stay private",
    "Witness Ramesh",
    "Inspector Leakwell",
    "constable Sunita",
    "device-leak-check-99",
    kase.case_reference,
    kase.id,
    police.id,
    police.aadhaarToken,
    "18.53",
    "73.84",
    "18530822",
    "73847465",
    manifest.nonce,
  ];
  const forbiddenKeys = [
    "fir", "fir_number", "title", "summary", "notes", "case_id", "caseId", "case_reference", "caseRef",
    "officer_id", "officerId", "full_name", "name", "gps_lat", "gps_lng", "lat", "lng", "latE6", "lngE6",
    "capture_manifest", "manifest", "deviceId", "device_id", "aadhaar_token", "officer_aadhaar_token", "accuracyCm",
  ];

  const keysOf = (value: unknown, out = new Set<string>()): Set<string> => {
    if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
    else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        out.add(k);
        keysOf(v, out);
      }
    }
    return out;
  };

  for (const ref of [captured.body.evidence.public_ref, uploaded.body.evidence.public_ref]) {
    const page = await call(null, "GET", `/api/public/verify/${ref}`);
    const check = await call(null, "POST", `/api/public/verify/${ref}/check`, { body: { sha256: sha(bytes) } });
    for (const response of [page, check]) {
      const text = JSON.stringify(response.body);
      for (const value of forbiddenValues) assert.ok(!text.includes(value), `public response leaked "${value}"`);
      const keys = keysOf(response.body);
      for (const key of forbiddenKeys) assert.ok(!keys.has(key), `public response has forbidden key "${key}"`);
    }
    // The capture says only that its location is committed.
    if (ref === captured.body.evidence.public_ref) assert.equal(page.body.passport.locationCommitted, true);
  }
});

test("the PDF and the QR code are served for a real reference only", async () => {
  const { ref } = await registered();
  const pdf = await call(null, "GET", `/api/public/verify/${ref}/passport.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(pdf.raw).subarray(0, 5).toString(), "%PDF-");

  const qr = await call(null, "GET", `/api/public/verify/${ref}/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(String(qr.body), /^<svg/);

  assert.equal((await call(null, "GET", "/api/public/verify/NSE-00000000000000000000000000/passport.pdf")).status, 404);
});

test("assigned roles get capture detail; the accused gets none; strangers get nothing", async () => {
  const kase = await createCase(police);
  const bytes = randomBytes(3000);
  const captured = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  const id = captured.body.evidence.id;

  const own = await call(police, "GET", `/api/evidence/${id}/passport`);
  assert.equal(own.status, 200);
  assert.equal(own.body.capture.gps.status, "OK");
  assert.ok(Math.abs(own.body.capture.gps.lat - 18.530823) < 1e-6);

  const accused = makeActor("accused");
  assign(accused, kase.id, "read");
  const theirs = await call(accused, "GET", `/api/evidence/${id}/passport`);
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.capture, null);
  assert.equal((await call(accused, "GET", `/api/evidence/${id}/manifest`)).status, 403);

  const stranger = makeActor("prosecutor");
  assert.equal((await call(stranger, "GET", `/api/evidence/${id}/passport`)).status, 403);
  assert.equal((await call(stranger, "GET", `/api/evidence/${id}/passport.pdf`)).status, 403);

  const authorisedPdf = await call(police, "GET", `/api/evidence/${id}/passport.pdf`);
  assert.equal(authorisedPdf.status, 200);
  assert.ok(mem.table("action_log").some((a) => a.action === "evidence.passport_pdf"));
});
