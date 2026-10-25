import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { captureEvidence, createCase, manifestFor, sha, uploadEvidence } from "./support/evidence";
import { pdfText } from "./support/pdfText";
import { env } from "../src/config/env";
import { DEFAULT_SECTION63 } from "../src/services/certificate.service";

after(stopServer);

let fake: FakeChain;
let police: Actor;
const depth = env.confirmationDepth;

beforeEach(() => {
  resetDatabase();
  mem.table("document_templates").push({ id: randomUUID(), ...DEFAULT_SECTION63 });
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  police = makeActor("police", { name: "Inspector Asha Kulkarni" });
  mem.table("users").find((u) => u.id === police.id)!.designation = "Police Inspector";
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = depth;
});

const flat = (s: string) => s.replace(/\s+/g, "");

test("a capture's certificate is filled from the record, and its hash is the anchored digest", async () => {
  const kase = await createCase(police);
  const bytes = randomBytes(4000);
  const manifest = manifestFor(police, kase.case_reference, bytes);
  const captured = await captureEvidence(police, kase.id, manifest, bytes);
  const id = captured.body.evidence.id;

  const response = await call(police, "POST", `/api/evidence/${id}/certificate`, { body: {} });
  assert.equal(response.status, 200, String(response.body));
  assert.equal(response.headers.get("content-type"), "application/pdf");
  const text = flat(pdfText(response.raw));

  // Every field comes from the record, not from defaults.
  for (const value of [
    sha(bytes),
    fake.registry.get(1)!.fileHash,
    captured.body.evidence.public_ref,
    "InspectorAshaKulkarni",
    "PoliceInspector",
    "web-test-device-01",
    "SHA-256",
  ]) {
    assert.ok(text.includes(flat(value)), `certificate is missing ${value}`);
  }
  assert.equal(fake.registry.get(1)!.fileHash, captured.body.evidence.anchored_digest);
  assert.ok(text.includes("PartA"), "Part A present");
  assert.ok(text.includes("PartB"), "Part B present");
  assert.ok(text.includes(flat("verify against the current Schedule")), "template disclaimer on the page");
  assert.equal(mem.table("certificates").length, 1);
  assert.equal(mem.table("certificates")[0].anchored_digest, fake.registry.get(1)!.fileHash);
});

test("missing data blocks generation with a clear list, rather than a blank that looks filled", async () => {
  const kase = await createCase(police);
  const { response: uploaded } = await uploadEvidence(police, kase.id);
  const id = uploaded.body.evidence.id;

  const refused = await call(police, "POST", `/api/evidence/${id}/certificate`, { body: {} });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, "CERTIFICATE_INCOMPLETE");
  assert.ok(refused.body.error.details.missing.some((m: string) => m.includes("description of the device")));
  assert.ok(refused.body.error.details.missing.some((m: string) => m.includes("how the record was produced")));

  const filled = await call(police, "POST", `/api/evidence/${id}/certificate`, {
    body: { deviceDescription: "Samsung Galaxy A54, IMEI on file", productionMethod: "Copied from the complainant's phone by USB." },
  });
  assert.equal(filled.status, 200);
});

test("an item that is not confirmed on chain cannot be certified", async () => {
  fake.nextSend = "rpc-down";
  const kase = await createCase(police);
  const bytes = randomBytes(1000);
  const captured = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  const refused = await call(police, "POST", `/api/evidence/${captured.body.evidence.id}/certificate`, { body: {} });
  assert.equal(refused.status, 422);
  assert.ok(refused.body.error.details.missing[0].includes("confirmed anchor"));
});

test("a record that disagrees with the chain cannot be certified", async () => {
  const kase = await createCase(police);
  const bytes = randomBytes(1000);
  const captured = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  fake.setDigest(1, "0x" + "ee".repeat(32));
  const refused = await call(police, "POST", `/api/evidence/${captured.body.evidence.id}/certificate`, { body: {} });
  assert.equal(refused.status, 422);
  assert.ok(refused.body.error.details.missing.some((m: string) => m.includes("differ")));
});

test("only assigned roles may generate it; the registry edits the template, keeping the disclaimer", async () => {
  const kase = await createCase(police);
  const bytes = randomBytes(1000);
  const captured = await captureEvidence(police, kase.id, manifestFor(police, kase.case_reference, bytes), bytes);
  const id = captured.body.evidence.id;

  const defence = makeActor("defence_lawyer");
  assign(defence, kase.id, "read");
  assert.equal((await call(defence, "POST", `/api/evidence/${id}/certificate`, { body: {} })).status, 403);
  assert.equal((await call(makeActor("prosecutor"), "POST", `/api/evidence/${id}/certificate`, { body: {} })).status, 403);

  const admin = makeActor("court_admin");
  const body = { title: "Certificate under Section 63", sections: [{ heading: "Part A", body: "Hash {file_sha256}" }], footer: "Remove the warning" };
  assert.equal((await call(admin, "PUT", "/api/templates/section63_certificate", { body })).status, 400);
  assert.equal((await call(police, "PUT", "/api/templates/section63_certificate", { body: { ...body, footer: "TEMPLATE — verify with counsel" } })).status, 403);
  const updated = await call(admin, "PUT", "/api/templates/section63_certificate", { body: { ...body, footer: "TEMPLATE — verify with counsel before use." } });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.template.version, 2);

  const rendered = await call(police, "POST", `/api/evidence/${id}/certificate`, { body: {} });
  assert.ok(flat(pdfText(rendered.raw)).includes(flat(`Hash ${sha(bytes)}`)), "the edited template is what renders");
});

test("the in-code default template is identical to the one migration 012 seeds", () => {
  const sql = readFileSync(join(__dirname, "..", "..", "database", "migrations", "012_workflows.sql"), "utf8");
  for (const section of DEFAULT_SECTION63.sections) {
    assert.ok(sql.includes(section.body.replace(/'/g, "''")), `migration lacks: ${section.heading}`);
  }
  assert.ok(sql.includes(DEFAULT_SECTION63.footer));
});
