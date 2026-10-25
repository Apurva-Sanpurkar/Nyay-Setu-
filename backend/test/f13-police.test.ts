import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assign, call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { createCase, uploadEvidence } from "./support/evidence";
import { pdfText } from "./support/pdfText";
import { env } from "../src/config/env";

after(stopServer);

let fake: FakeChain;
let police: Actor;
let kase: { id: string; case_reference: string };
const depth = env.confirmationDepth;

beforeEach(async () => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  police = makeActor("police");
  kase = await createCase(police);
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = depth;
});

const flat = (s: string) => s.replace(/\s+/g, "");

async function threeItems() {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await uploadEvidence(police, kase.id)).response.body.evidence.id);
  return ids;
}

function seizureBody(ids: string[]) {
  return {
    caseId: kase.id,
    memoNumber: "SZ-17/2026",
    seizedAt: new Date().toISOString(),
    place: "Flat 4, Laxmi Building, Shivajinagar",
    seizedFrom: "Mr. Arun Gaikwad",
    witnesses: [{ name: "Sunil Pawar", address: "Flat 2" }, { name: "Meena Kale" }],
    items: [
      { evidenceId: ids[0], label: "Mobile phone", description: "Black, cracked screen" },
      { evidenceId: ids[1], label: "SIM card" },
      { evidenceId: ids[2], label: "Memory card", description: "32 GB" },
    ],
  };
}

test("a seizure groups related items under one memo, each keeping its own digest", async () => {
  const ids = await threeItems();
  const created = await call(police, "POST", "/api/police/seizures", { body: seizureBody(ids) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.verification.state, "CONFIRMED", "the memo's digest is anchored");

  const list = await call(police, "GET", `/api/police/cases/${kase.id}/seizures`);
  const seizure = list.body.seizures[0];
  assert.deepEqual(seizure.items.map((i: any) => i.item_label), ["Mobile phone", "SIM card", "Memory card"]);
  assert.equal(new Set(seizure.items.map((i: any) => i.evidence.file_hash)).size, 3, "three distinct digests");

  // An item cannot be in two seizures, and cannot come from another case.
  assert.equal((await call(police, "POST", "/api/police/seizures", { body: { ...seizureBody(ids), memoNumber: "SZ-18/2026" } })).status, 409);
  const other = await createCase(police);
  assert.equal((await call(police, "POST", "/api/police/seizures", { body: { ...seizureBody(ids), caseId: other.id } })).status, 400);
});

test("the seizure memo is filled from the record; defence gets it with place and witnesses withheld", async () => {
  const ids = await threeItems();
  const created = await call(police, "POST", "/api/police/seizures", { body: seizureBody(ids) });
  const id = created.body.seizure.id;

  const memo = flat(pdfText((await call(police, "GET", `/api/police/seizures/${id}/memo.pdf`)).raw));
  for (const value of ["SZ-17/2026", "Flat4,LaxmiBuilding", "SunilPawar", "Mobilephone", "SIMcard", "Memorycard", mem.table("evidence_items")[0].file_hash]) {
    assert.ok(memo.includes(flat(value)), `memo is missing ${value}`);
  }
  assert.ok(memo.includes(flat(mem.table("seizures")[0].memo_digest)));

  const defence = makeActor("defence_lawyer");
  assign(defence, kase.id, "read");
  const theirs = flat(pdfText((await call(defence, "GET", `/api/police/seizures/${id}/memo.pdf`)).raw));
  assert.ok(!theirs.includes("SunilPawar") && !theirs.includes("LaxmiBuilding"));
  assert.ok(theirs.includes("withheld"));
  const listed = await call(defence, "GET", `/api/police/cases/${kase.id}/seizures`);
  assert.equal(listed.body.seizures[0].place, null);

  assert.equal((await call(makeActor("police"), "GET", `/api/police/seizures/${id}/memo.pdf`)).status, 403, "strangers refused");
  assert.equal((await call(defence, "POST", "/api/police/seizures", { body: seizureBody(ids) })).status, 403);
});

test("the malkhana register enforces in-before-out, anchors every movement, and cannot be edited", async () => {
  const [id] = await threeItems();
  const move = (movement: string, extra: Record<string, unknown> = {}) =>
    call(police, "POST", `/api/police/evidence/${id}/malkhana`, {
      body: { movement, location: "Malkhana, Shivajinagar PS", shelf: "R2-S4", reason: "Deposit after seizure", ...extra },
    });

  assert.equal((await move("OUT")).status, 409, "cannot take out what was never put in");
  const deposited = await move("IN");
  assert.equal(deposited.status, 201);
  assert.equal(deposited.body.verification.state, "CONFIRMED");
  assert.equal((await move("IN")).status, 409, "cannot deposit twice");
  assert.equal((await move("OUT", { reason: "Sent to RFSL for examination", counterparty: "RFSL Pune" })).status, 201);
  assert.equal((await move("RETURN", { reason: "Returned from RFSL" })).status, 201);

  const history = await call(police, "GET", `/api/police/evidence/${id}/malkhana`);
  assert.deepEqual(history.body.movements.map((m: any) => m.movement), ["IN", "OUT", "RETURN"]);
  assert.ok(history.body.movements.every((m: any) => m.verification?.state === "CONFIRMED"));
  // Each movement's digest chains to the previous one.
  const digests = mem.table("malkhana_movements").map((m) => m.movement_digest);
  assert.equal(new Set(digests).size, 3);
  assert.equal(mem.table("action_log").filter((a) => a.action === "police.malkhana").length, 3);

  const register = await call(police, "GET", "/api/police/malkhana");
  assert.equal(register.body.items[0].onShelf, true);
  assert.equal(register.body.items[0].shelf, "R2-S4");
});

test("the custody form lists every hop, check and movement from the record", async () => {
  const [id] = await threeItems();
  await call(police, "POST", `/api/police/evidence/${id}/malkhana`, {
    body: { movement: "IN", location: "Malkhana", reason: "Deposit" },
  });
  const form = flat(pdfText((await call(police, "GET", `/api/police/evidence/${id}/custody-form.pdf`)).raw));
  const item = mem.table("evidence_items").find((e) => e.id === id)!;
  assert.ok(form.includes(item.public_ref));
  assert.ok(form.includes(item.file_hash));
  // Stages and states are printed in words, not as internal codes.
  assert.ok(form.includes(flat("Scene of offence")));
  assert.ok(!form.includes("SCENE"), "no raw stage codes");
  assert.ok(form.includes("Deposit"));
  assert.ok(form.includes(flat("Confirmed on the ledger")));
});
