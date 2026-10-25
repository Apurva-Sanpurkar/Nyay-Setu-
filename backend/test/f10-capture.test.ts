import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, webcrypto, createHmac } from "crypto";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { captureEvidence, createCase, manifestFor, sha, uploadEvidence } from "./support/evidence";
import { env } from "../src/config/env";
import { canonicalJson, manifestDigest, withFileDigest } from "../src/shared/integrity";

after(stopServer);

let fake: FakeChain;
let police: Actor;
let kase: { id: string; case_reference: string };
const saved = { depth: env.confirmationDepth, requireGps: env.CAPTURE_REQUIRE_GPS, rawCoords: env.ANCHOR_RAW_COORDS_ON_CHAIN };

beforeEach(async () => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  police = makeActor("police");
  kase = await createCase(police);
});

afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = saved.depth;
  (env as any).CAPTURE_REQUIRE_GPS = saved.requireGps;
  (env as any).ANCHOR_RAW_COORDS_ON_CHAIN = saved.rawCoords;
});

const publicCheck = async (ref: string, fileSha: string) =>
  (await call(null, "POST", `/api/public/verify/${ref}/check`, { body: { sha256: fileSha } })).body.result;

test("a capture anchors the manifest digest, which commits to the file inside it", async () => {
  const bytes = randomBytes(8000);
  const manifest = manifestFor(police, kase.case_reference, bytes);
  const response = await captureEvidence(police, kase.id, manifest, bytes);
  assert.equal(response.status, 201, JSON.stringify(response.body));

  const e = response.body.evidence;
  assert.equal(e.source, "capture");
  assert.equal(e.anchor_mode, "manifest");
  assert.equal(e.file_hash, sha(bytes));
  assert.equal(e.anchored_digest, manifestDigest(manifest));
  assert.equal(fake.registry.get(1)!.fileHash, manifestDigest(manifest), "the chain holds the manifest digest");
  assert.equal(response.body.verification.state, "CONFIRMED");
  assert.equal(e.gps_status, "OK");
  assert.equal(Number(e.gps_accuracy_m), 7.5);
  assert.equal(e.capture_manifest, undefined, "the manifest is not echoed in ordinary evidence responses");

  const result = await publicCheck(e.public_ref, sha(bytes));
  assert.equal(result.matched, true);
  assert.equal(result.fileMatchesRecordedManifest, true);
});

test("a tampered pixel, GPS fix or timestamp each fails verification", async () => {
  const bytes = randomBytes(8000);
  const manifest = manifestFor(police, kase.case_reference, bytes);
  const response = await captureEvidence(police, kase.id, manifest, bytes);
  const ref = response.body.evidence.public_ref;
  const row = () => mem.table("evidence_items").find((r) => r.public_ref === ref)!;

  // One pixel.
  const pixel = Buffer.from(bytes);
  pixel[4000] ^= 0x80;
  assert.equal((await publicCheck(ref, sha(pixel))).matched, false, "pixel");

  // The stored GPS moved by one micro-degree (someone edited the record).
  const original = JSON.parse(JSON.stringify(row().capture_manifest));
  row().capture_manifest = { ...original, gps: { ...original.gps, start: { ...original.gps.start, latE6: original.gps.start.latE6 + 1 } } };
  assert.equal((await publicCheck(ref, sha(bytes))).matched, false, "gps");

  // The stored device time moved by one millisecond.
  row().capture_manifest = { ...original, deviceTimeMs: original.deviceTimeMs + 1 };
  assert.equal((await publicCheck(ref, sha(bytes))).matched, false, "timestamp");

  // Restored: matches again.
  row().capture_manifest = original;
  assert.equal((await publicCheck(ref, sha(bytes))).matched, true, "restored");
});

test("permission denied: tagged NO_GPS and accepted, unless the deployment requires a fix", async () => {
  const bytes = randomBytes(3000);
  const denied = manifestFor(police, kase.case_reference, bytes, { gpsStart: null, noFixReason: "DENIED" });
  const accepted = await captureEvidence(police, kase.id, denied, bytes);
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  assert.equal(accepted.body.evidence.gps_status, "NO_GPS");
  assert.equal(accepted.body.evidence.gps_lat, null);

  const passport = (await call(null, "GET", `/api/public/verify/${accepted.body.evidence.public_ref}`)).body.passport;
  assert.equal(passport.locationCommitted, false, "a capture without a fix does not claim a committed location");

  (env as any).CAPTURE_REQUIRE_GPS = true;
  const other = randomBytes(3000);
  const refused = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, other, { gpsStart: null, noFixReason: "DENIED" }), other);
  assert.equal(refused.status, 400);
});

test("a low-accuracy fix is tagged LOW_ACCURACY; a manifest that misreports it is refused", async () => {
  const bytes = randomBytes(3000);
  const now = Date.now();
  const wide = manifestFor(police, kase.case_reference, bytes, {
    deviceTimeMs: now,
    gpsStart: { lat: 18.53, lng: 73.84, accuracyMetres: 420, takenAtMs: now - 1000 },
  });
  const response = await captureEvidence(police, kase.id, wide, bytes);
  assert.equal(response.status, 201);
  assert.equal(response.body.evidence.gps_status, "LOW_ACCURACY");

  const liar = { ...wide, gps: { ...wide.gps, status: "OK" as const } };
  const second = randomBytes(10);
  const lied = await captureEvidence(police, kase.id, { ...liar, file: { ...liar.file, sha256: sha(second), bytes: second.length } }, second);
  assert.equal(lied.status, 400);
  assert.match(lied.body.error.message, /says GPS was OK/);
});

test("upload and capture are tagged differently and anchored differently", async () => {
  const { response: uploaded, bytes } = await uploadEvidence(police, kase.id);
  assert.equal(uploaded.body.evidence.source, "upload");
  assert.equal(uploaded.body.evidence.anchor_mode, "file");
  assert.equal(uploaded.body.evidence.anchored_digest, sha(bytes));

  // A manifest cannot be smuggled onto an upload, and a capture needs one.
  const form = new FormData();
  form.append("file", new Blob([bytes]), "x.jpg");
  form.append("caseId", kase.id);
  form.append("clientHash", sha(bytes));
  form.append("kind", "photo");
  form.append("source", "capture");
  form.append("collectedAt", new Date().toISOString());
  assert.equal((await call(police, "POST", "/api/evidence", { form })).status, 409);

  // A manifest that says "upload" is not accepted as a live capture.
  const fresh = randomBytes(100);
  const uploadManifest = manifestFor(police, kase.case_reference, fresh, { source: "upload" });
  assert.equal((await captureEvidence(police, kase.id, uploadManifest, fresh)).status, 409);
});

test("the manifest must describe these bytes, this case and this officer", async () => {
  const bytes = randomBytes(2000);
  const otherBytes = randomBytes(2000);

  const wrongFile = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, otherBytes), bytes);
  assert.equal(wrongFile.status, 409);

  const wrongCase = await captureEvidence(police, kase.id, manifestFor(police, "NS/ELSEWHERE/2026/000001", bytes), bytes);
  assert.equal(wrongCase.status, 409);

  const colleague = makeActor("police");
  assign(colleague, kase.id, "write");
  const wrongOfficer = await captureEvidence(colleague, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  assert.equal(wrongOfficer.status, 403);

  assert.equal(mem.table("evidence_items").length, 0, "nothing was registered");
});

test("raw coordinates stay off chain and off the public page unless the flag is set", async () => {
  const bytes = randomBytes(2000);
  const response = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  const registration = fake.sent.find((s) => s.method === "registerEvidence")!;
  assert.deepEqual([registration.args[2], registration.args[3]], [0n, 0n]);

  (env as any).ANCHOR_RAW_COORDS_ON_CHAIN = true;
  const more = randomBytes(2000);
  await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, more), more);
  const second = fake.sent.filter((s) => s.method === "registerEvidence")[1];
  assert.equal(second.args[2], 18_530_823n, "with the flag, micro-degrees go on chain");

  // Either way, the public page never carries them.
  const page = JSON.stringify((await call(null, "GET", `/api/public/verify/${response.body.evidence.public_ref}`)).body);
  assert.ok(!page.includes("18530823") && !page.includes("18.53"));
});

test("a duplicate offline sync with the same key registers once", async () => {
  const bytes = randomBytes(4000);
  const manifest = manifestFor(police, kase.case_reference, bytes);
  const headers = { "idempotency-key": `sync-${manifest.nonce}` };
  const first = await captureEvidence(police, kase.id, manifest, bytes, { headers });
  const second = await captureEvidence(police, kase.id, manifest, bytes, { headers });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(first.body.evidence.id, second.body.evidence.id);
  assert.equal(fake.sent.filter((s) => s.method === "registerEvidence").length, 1);
});

test("custody of a capture: the receiver hashes the file, the server derives the manifest digest", async () => {
  const bytes = randomBytes(6000);
  const manifest = manifestFor(police, kase.case_reference, bytes);
  const response = await captureEvidence(police, kase.id, manifest, bytes);
  const lab = makeActor("forensic_lab");
  assign(lab, kase.id, "write");

  const moved = await call(lab, "POST", `/api/evidence/${response.body.evidence.id}/custody`, { body: { confirmedHash: sha(bytes) } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const transfer = fake.sent.find((s) => s.method === "transferCustody")!;
  assert.equal(transfer.args[3], manifestDigest(manifest));

  const prosecutor = makeActor("prosecutor");
  assign(prosecutor, kase.id, "write");
  const tampered = Buffer.from(bytes);
  tampered[0] ^= 1;
  const refused = await call(prosecutor, "POST", `/api/evidence/${response.body.evidence.id}/custody`, { body: { confirmedHash: sha(tampered) } });
  assert.equal(refused.status, 409);
  const check = fake.sent.filter((s) => s.method === "reportIntegrityCheck").at(-1)!;
  assert.equal(check.args[1], manifestDigest(withFileDigest(manifest, sha(tampered))));
});

test("device signatures: a registered ECDSA key verifies, a stranger's key and a forged value do not", async () => {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const registered = await call(police, "POST", "/api/devices/keys", {
    body: { algorithm: "ECDSA-P256-SHA256", keyId: "web-key-0001", platform: "web", publicJwk: jwk },
  });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));

  const sign = async (manifest: object) =>
    Buffer.from(
      await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, Buffer.from(canonicalJson(manifest), "utf8"))
    ).toString("base64url");

  const bytes = randomBytes(1500);
  const manifest = manifestFor(police, kase.case_reference, bytes);
  const good = await captureEvidence(police, kase.id, manifest, bytes, {
    signature: { alg: "ECDSA-P256-SHA256", keyId: "web-key-0001", value: await sign(manifest) },
  });
  assert.equal(good.body.evidence.signature_status, "valid");

  const b2 = randomBytes(1500);
  const m2 = manifestFor(police, kase.case_reference, b2);
  const forged = await captureEvidence(police, kase.id, m2, b2, {
    signature: { alg: "ECDSA-P256-SHA256", keyId: "web-key-0001", value: await sign(manifest) },
  });
  assert.equal(forged.status, 201, "a bad signature is flagged, not a reason to lose the evidence");
  assert.equal(forged.body.evidence.signature_status, "invalid");

  const b3 = randomBytes(1500);
  const m3 = manifestFor(police, kase.case_reference, b3);
  const unknown = await captureEvidence(police, kase.id, m3, b3, {
    signature: { alg: "ECDSA-P256-SHA256", keyId: "never-registered", value: await sign(m3) },
  });
  assert.equal(unknown.body.evidence.signature_status, "unknown_key");
});

test("device signatures: an HMAC key from the phone verifies, and its secret is never returned", async () => {
  const secret = randomBytes(32).toString("hex");
  await call(police, "POST", "/api/devices/keys", {
    body: { algorithm: "HMAC-SHA256", keyId: "android-key-0001", platform: "android", secret },
  });
  const listed = await call(police, "GET", "/api/devices/keys");
  assert.ok(!JSON.stringify(listed.body).includes(secret));
  assert.ok(!JSON.stringify(mem.table("device_keys")).includes(secret), "stored encrypted");

  const bytes = randomBytes(1200);
  const manifest = manifestFor(police, kase.case_reference, bytes, { platform: "android" });
  const value = createHmac("sha256", Buffer.from(secret, "hex")).update(canonicalJson(manifest)).digest("base64url");
  const response = await captureEvidence(police, kase.id, manifest, bytes, {
    signature: { alg: "HMAC-SHA256", keyId: "android-key-0001", value },
  });
  assert.equal(response.body.evidence.signature_status, "valid");

  const defence = makeActor("defence_lawyer");
  assert.equal(
    (await call(defence, "POST", "/api/devices/keys", { body: { algorithm: "HMAC-SHA256", keyId: "defence-key-01", platform: "web", secret } })).status,
    403
  );
});

test("device clock skew is measured and flagged", async () => {
  const bytes = randomBytes(1000);
  const manifest = manifestFor(police, kase.case_reference, bytes);
  const skewed = await captureEvidence(police, kase.id, manifest, bytes, { deviceClockAtSendMs: Date.now() + 3_600_000 });
  assert.equal(skewed.body.evidence.clock_skew_flagged, true);
  assert.ok(Math.abs(skewed.body.evidence.clock_skew_seconds - 3600) <= 2);

  const ok = randomBytes(1000);
  const fine = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, ok), ok);
  assert.equal(fine.body.evidence.clock_skew_flagged, false);
});
