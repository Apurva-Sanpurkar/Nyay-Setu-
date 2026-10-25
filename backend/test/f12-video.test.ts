import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { assign, call, makeActor, mem, resetDatabase, startServer, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { createCase, manifestFor, sha } from "./support/evidence";
import { env } from "../src/config/env";
import { manifestDigest } from "../src/shared/integrity";

after(stopServer);

let fake: FakeChain;
let police: Actor;
let kase: { id: string; case_reference: string };
const CHUNK = 256 * 1024;
const originalDepth = env.confirmationDepth;

beforeEach(async () => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  police = makeActor("police");
  kase = await createCase(police);
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = originalDepth;
});

async function putPiece(actor: Actor, uploadId: string, index: number, bytes: Buffer, declared = sha(bytes)) {
  const base = await startServer();
  const response = await fetch(`${base}/api/uploads/${uploadId}/chunks/${index}`, {
    method: "PUT",
    headers: {
      cookie: `nyaysetu_session=${actor.token}`,
      "x-csrf-token": actor.csrf,
      "content-type": "application/octet-stream",
      "x-chunk-sha256": declared,
    },
    body: bytes,
  });
  return { status: response.status, body: await response.json() };
}

function pieces(video: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < video.length; i += CHUNK) out.push(video.subarray(i, i + CHUNK));
  return out;
}

async function open(video: Buffer, actor = police) {
  return call(actor, "POST", "/api/uploads", {
    body: { caseId: kase.id, fileName: "search.webm", mimeType: "video/webm", totalBytes: video.length, chunkSize: CHUNK, sha256: sha(video) },
  });
}

async function register(video: Buffer, uploadId: string, extra: Record<string, string> = {}) {
  const now = Date.now();
  const manifest = manifestFor(police, kase.case_reference, video, {
    mediaKind: "video",
    purpose: "search_seizure",
    file: { sha256: sha(video), bytes: video.length, mimeType: "video/webm" },
    durationMs: 95_000,
    deviceTimeMs: now - 95_000,
    gpsStart: { lat: 18.5308, lng: 73.8474, accuracyMetres: 6, takenAtMs: now - 96_000 },
    gpsEnd: { lat: 18.5309, lng: 73.8475, accuracyMetres: 9, takenAtMs: now - 500 },
  });
  const form = new FormData();
  form.append("uploadId", uploadId);
  form.append("caseId", kase.id);
  form.append("clientHash", sha(video));
  form.append("kind", "video");
  form.append("source", "capture");
  form.append("collectedAt", new Date(manifest.deviceTimeMs).toISOString());
  form.append("manifest", JSON.stringify(manifest));
  form.append("deviceClockAtSendMs", String(now));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return { response: await call(police, "POST", "/api/evidence", { form }), manifest };
}

test("a recording sent in pieces, interrupted and resumed, registers exactly as sent", async () => {
  const video = randomBytes(CHUNK * 5 + 1234);
  const opened = await open(video);
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.totalChunks, 6);
  const id = opened.body.uploadId;

  // The connection drops after three pieces, sent out of order.
  const parts = pieces(video);
  for (const index of [2, 0, 1]) assert.equal((await putPiece(police, id, index, parts[index])).status, 200);

  // Coming back online, the device asks what is missing and resumes from there.
  const status = await call(police, "GET", `/api/uploads/${id}`);
  assert.deepEqual(status.body.received, [0, 1, 2]);
  assert.equal(status.body.nextMissing, 3);
  assert.equal(status.body.complete, false);

  // Registering before every piece has arrived is refused, not half-done.
  const early = await register(video, id);
  assert.equal(early.response.status, 409);

  for (const index of [3, 4, 5]) await putPiece(police, id, index, parts[index]);
  // A piece re-sent after a timeout is harmless.
  assert.equal((await putPiece(police, id, 4, parts[4])).status, 200);

  const { response, manifest } = await register(video, id, {
    witnesses: JSON.stringify([{ name: "Sunil Pawar", description: "neighbour" }, { name: "Meena Kale" }]),
    searchChecklist: JSON.stringify({ place: true, witnesses: true, continuous: true, sealed: true }),
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.evidence.file_hash, sha(video));
  assert.equal(response.body.evidence.anchored_digest, manifestDigest(manifest));
  assert.equal(response.body.evidence.capture_purpose, "search_seizure");
  assert.equal(response.body.evidence.duration_ms, 95_000);
  assert.equal(response.body.evidence.witnesses, undefined, "witness names are not in ordinary responses");

  // Witnesses reach assigned roles, never the accused or the public page.
  const own = await call(police, "GET", `/api/evidence/${response.body.evidence.id}/passport`);
  assert.deepEqual(own.body.capture.witnesses.map((w: any) => w.name), ["Sunil Pawar", "Meena Kale"]);
  const accused = makeActor("accused");
  assign(accused, kase.id, "read");
  const theirs = await call(accused, "GET", `/api/evidence/${response.body.evidence.id}/passport`);
  assert.equal(theirs.body.capture, null);
  const page = await call(null, "GET", `/api/public/verify/${response.body.evidence.public_ref}`);
  assert.ok(!JSON.stringify(page.body).includes("Sunil Pawar"));

  assert.equal(mem.table("upload_sessions")[0].status, "consumed");
});

test("a piece damaged in transit is refused, and so is different content for a piece already received", async () => {
  const video = randomBytes(CHUNK * 2);
  const id = (await open(video)).body.uploadId;
  const [first] = pieces(video);

  const damaged = Buffer.from(first);
  damaged[10] ^= 0xff;
  const refused = await putPiece(police, id, 0, damaged, sha(first));
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /damaged in transit/);

  assert.equal((await putPiece(police, id, 0, first)).status, 200);
  const swapped = await putPiece(police, id, 0, damaged);
  assert.equal(swapped.status, 409);
  assert.match(swapped.body.error.message, /different content/);
});

test("a tampered byte anywhere in the recording is caught at assembly and nothing is registered", async () => {
  const video = randomBytes(CHUNK * 3);
  const id = (await open(video)).body.uploadId;
  const parts = pieces(video);
  const tampered = Buffer.from(parts[1]);
  tampered[CHUNK - 1] ^= 0x01;
  // Each piece is consistent with its own digest, so it is accepted on arrival…
  await putPiece(police, id, 0, parts[0]);
  await putPiece(police, id, 1, tampered);
  await putPiece(police, id, 2, parts[2]);

  // …but the recording as a whole no longer hashes to what the device declared.
  const { response } = await register(video, id);
  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /does not hash to the digest your device declared/);
  assert.equal(mem.table("evidence_items").length, 0);
  assert.equal(mem.table("upload_sessions")[0].status, "refused");
});

test("pieces of the wrong size, uploads of other people and oversized recordings are refused", async () => {
  const video = randomBytes(CHUNK * 2);
  const id = (await open(video)).body.uploadId;
  assert.equal((await putPiece(police, id, 0, randomBytes(100))).status, 400);
  assert.equal((await putPiece(police, id, 7, pieces(video)[0])).status, 400);

  const colleague = makeActor("police");
  assign(colleague, kase.id, "write");
  assert.equal((await putPiece(colleague, id, 0, pieces(video)[0])).status, 403);
  assert.equal((await call(colleague, "GET", `/api/uploads/${id}`)).status, 403);

  const huge = await call(police, "POST", "/api/uploads", {
    body: { caseId: kase.id, fileName: "x.webm", mimeType: "video/webm", totalBytes: env.MAX_CHUNKED_UPLOAD_BYTES + 1, chunkSize: CHUNK, sha256: sha(video) },
  });
  assert.equal(huge.status, 400);

  const defence = makeActor("defence_lawyer");
  assign(defence, kase.id, "read");
  assert.equal((await open(video, defence)).status, 403);
});
