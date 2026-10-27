import { startOcrStub, stopOcrStub, stub } from "./support/ocrStub";
import { test, after, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import express from "express";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { createCase, uploadEvidence } from "./support/evidence";
import { env } from "../src/config/env";
import { canonicalJson } from "../src/shared/integrity";
import { proofProblem, type OcrResult } from "../src/lib/ai";
import { AppError, fromSupabase } from "../src/lib/errors";
import { errorHandler } from "../src/middleware/error";

before(startOcrStub);
after(async () => {
  await stopServer();
  await stopOcrStub();
});

let fake: FakeChain;
let police: Actor;
let kase: { id: string; case_reference: string };
const depth = env.confirmationDepth;

beforeEach(async () => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  stub.mode = "ok";
  stub.calls.length = 0;
  police = makeActor("police");
  kase = await createCase(police);
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = depth;
});

const sha = (data: Buffer | string) => "0x" + createHash("sha256").update(data).digest("hex");

async function photo() {
  const { response, bytes } = await uploadEvidence(police, kase.id);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return { id: response.body.evidence.id as string, bytes };
}

test("OCR reads the registered bytes, checks the proof, stores it and anchors the digest", async () => {
  const item = await photo();
  const anchorsBefore = fake.sent.length;

  const first = await call(police, "POST", `/api/evidence/${item.id}/ocr`);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const reading = first.body.reading;
  assert.equal(reading.text, stub.text);
  assert.equal(reading.proof.inputSha256, sha(item.bytes), "the proof names the registered file");
  assert.equal(stub.calls[0].expected, sha(item.bytes), "the service was told which bytes it may read");
  assert.equal(reading.confidence, 0.91);
  assert.ok(["CONFIRMED", "SUBMITTED", "PENDING"].includes(reading.verification.state), reading.verification.state);
  assert.equal(fake.sent.length, anchorsBefore + 1, "the result digest went on chain");
  assert.equal(fake.sent.at(-1)!.args[1], reading.resultDigest);

  // The same file through the same pipeline is the same reading: no second row, no second anchor.
  const again = await call(police, "POST", `/api/evidence/${item.id}/ocr`);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(mem.table("evidence_ocr").length, 1);
  assert.equal(fake.sent.length, anchorsBefore + 1);

  const listed = await call(police, "GET", `/api/evidence/${item.id}/ocr`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.readings.length, 1);
  assert.equal(listed.body.available, true);
});

test("a result whose text does not match its proof is discarded", async () => {
  const item = await photo();
  stub.mode = "tampered_text";
  const response = await call(police, "POST", `/api/evidence/${item.id}/ocr`);
  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /does not match its digest/);
  assert.equal(mem.table("evidence_ocr").length, 0);
});

test("a result that describes other bytes is discarded", async () => {
  const item = await photo();
  stub.mode = "other_bytes";
  const response = await call(police, "POST", `/api/evidence/${item.id}/ocr`);
  assert.equal(response.status, 409);
  assert.match(response.body.error.message, /different bytes/);
  assert.equal(mem.table("evidence_ocr").length, 0);
});

test("a damaged stored file is never sent to OCR", async () => {
  const item = await photo();
  const row = mem.table("evidence_items").find((e) => e.id === item.id)!;
  const blob = path.join(env.localBlobDir, `${row.ipfs_cid}.bin`);
  fs.writeFileSync(blob, randomBytes(fs.statSync(blob).size));
  const response = await call(police, "POST", `/api/evidence/${item.id}/ocr`);
  assert.equal(response.status, 409);
  assert.equal(stub.calls.length, 0);
});

test("the OCR service being down is a 503 that says so, not a bare failure", async () => {
  const item = await photo();
  stub.mode = "down";
  const response = await call(police, "POST", `/api/evidence/${item.id}/ocr`);
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, "OCR_UNAVAILABLE");
  assert.match(response.body.error.message, /Tesseract/);
});

test("only a role that handles evidence creates a reading; an assigned defence lawyer may read them", async () => {
  const item = await photo();
  const defence = makeActor("defence_lawyer");
  assign(defence, kase.id, "read");
  assert.equal((await call(defence, "POST", `/api/evidence/${item.id}/ocr`)).status, 403);
  await call(police, "POST", `/api/evidence/${item.id}/ocr`);
  const listed = await call(defence, "GET", `/api/evidence/${item.id}/ocr`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.readings.length, 1);
  const stranger = makeActor("police");
  assert.equal((await call(stranger, "GET", `/api/evidence/${item.id}/ocr`)).status, 403);
});

test("an item that is not an image is not sent to OCR", async () => {
  const bytes = Buffer.from("plain text, not an image");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "text/plain" }), "note.txt");
  form.append("caseId", kase.id);
  form.append("clientHash", sha(bytes));
  form.append("kind", "document");
  form.append("source", "upload");
  form.append("collectedAt", new Date().toISOString());
  const registered = await call(police, "POST", "/api/evidence", { form });
  assert.equal(registered.status, 201);
  const response = await call(police, "POST", `/api/evidence/${registered.body.evidence.id}/ocr`);
  assert.equal(response.status, 409);
  assert.equal(stub.calls.length, 0);
});

test("the proof digest is the same in Python and here (shared vector)", () => {
  const core = {
    confidencePct: 87,
    engine: { name: "tesseract", version: "5.4.0" },
    inputSha256: "0x" + "ab".repeat(32),
    pipeline: { mode: "document", psm: 3, steps: [{ name: "deskew", angleDeciDegrees: -35 }], variant: "otsu", version: "nyaysetu-ocr-1.0" },
    preprocessedSha256: "0x" + "cd".repeat(32),
    textSha256: "0x" + "ef".repeat(32),
  };
  // Also asserted in ai-service/tests/test_ocr.py.
  assert.equal(sha(canonicalJson(core)), "0xb07a02985e889745a63cecded029f8489041a9cd7f45e51281c770d830fa28ab");
  const text = "x";
  const result = { text, proof: { ...core, textSha256: sha(text), resultDigest: "" } } as unknown as OcrResult;
  result.proof.resultDigest = sha(canonicalJson({ ...core, textSha256: sha(text) }));
  assert.equal(proofProblem(result, core.inputSha256), null);
  assert.match(proofProblem(result, "0x" + "00".repeat(32))!, /different bytes/);
});

test("server ANPR falls back to the NyaySetu plate reader when no provider token is set", async () => {
  const form = new FormData();
  form.append("image", new Blob([randomBytes(4000)], { type: "image/jpeg" }), "plate.jpg");
  const response = await call(police, "POST", "/api/vehicles/anpr", { form });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.engine, "nyaysetu-ocr");
  assert.equal(response.body.candidates[0].plate, "MH12AB1234");
  assert.ok(response.body.proof.resultDigest);

  stub.mode = "down";
  const down = await call(police, "POST", "/api/vehicles/anpr", { form });
  assert.equal(down.status, 501, "the app then reads the plate on the device");
});

/* --------------------------------------------- infrastructure failures, explained */

test("a database that cannot be reached, or refuses the key, is explained instead of masked", async () => {
  const unreachable = fromSupabase({ message: "TypeError: fetch failed", code: "" });
  assert.equal(unreachable.code, "DB_UNREACHABLE");
  assert.equal(unreachable.status, 503);
  assert.equal(fromSupabase({ message: "Invalid API key", code: "" }).code, "DB_UNAUTHORISED");
  assert.equal(fromSupabase({ message: "relation \"x\" does not exist", code: "42P01" }).code, "SCHEMA_OUT_OF_DATE");
  // A genuine internal error is still not shown.
  assert.equal(fromSupabase({ message: "deadlock detected", code: "40P01" }).expose, false);

  const app = express();
  app.get("/unreachable", (_req, _res, next) => next(unreachable));
  app.get("/rpc", (_req, _res, next) => next(new AppError(503, "UNAVAILABLE", "Blockchain unavailable: could not detect network (url=https://eth-sepolia.g.alchemy.com/v2/SECRETKEY)")));
  app.get("/internal", (_req, _res, next) => next(new AppError(500, "DB_ERROR", "deadlock detected", { table: "x" })));
  app.use(errorHandler);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  try {
    const a = await (await fetch(`http://127.0.0.1:${port}/unreachable`)).json();
    assert.match(a.error.message, /could not reach its database/);
    assert.equal(a.error.details, undefined, "a 5xx never carries driver details");
    const b = await (await fetch(`http://127.0.0.1:${port}/rpc`)).json();
    assert.doesNotMatch(b.error.message, /SECRETKEY|alchemy/);
    assert.match(b.error.message, /Blockchain unavailable/);
    const c = await (await fetch(`http://127.0.0.1:${port}/internal`)).json();
    assert.equal(c.error.message, "Something went wrong. Please try again.");
  } finally {
    server.close();
  }
});
