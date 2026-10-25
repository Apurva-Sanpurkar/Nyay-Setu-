import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { env } from "../src/config/env";
import { nameSimilarity } from "../src/lib/similarity";

after(stopServer);

let fake: FakeChain;
let pune: Actor;
let mumbai: Actor;
const depth = env.confirmationDepth;

function at(actor: Actor, station: string): Actor {
  mem.table("users").find((u) => u.id === actor.id)!.station_or_court = station;
  return actor;
}

beforeEach(() => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  pune = at(makeActor("police"), "Shivajinagar PS, Pune");
  mumbai = at(makeActor("police"), "Dadar PS, Mumbai");
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = depth;
});

const person = {
  fullName: "Ravi Shankar Patil",
  aliases: ["Bunty"],
  gender: "male",
  ageEstimate: 32,
  identifyingMarks: "Scar above left eyebrow, tattoo of an anchor on right forearm",
  classification: "suspect",
};

const puneRobbery = {
  firNumber: "112/2026",
  policeStation: "Shivajinagar PS, Pune",
  offence: "Robbery (BNS 309)",
  offenceCategory: "robbery",
  modusOperandi: "Two men on a black motorcycle snatch bags from pedestrians near bus stops at dusk, rider wears red helmet",
  crimeDate: "2026-03-14",
  involvement: "suspect",
  investigationStatus: "under_investigation",
};

const purpose = "Investigating FIR 77/2026 at Dadar PS";

test("names are compared by tokens and spelling", () => {
  assert.equal(nameSimilarity("Ravi Patil", "Patil Ravi"), 1);
  assert.ok(nameSimilarity("Ravi Patil", "Ravee Patil") > 0.8);
  assert.ok(nameSimilarity("Ravi Patil", "Suresh Kumar") < 0.5);
});

test("a person record is created, anchored and kept distinct from a finding of guilt", async () => {
  const created = await call(pune, "POST", "/api/third-eye/persons", { body: person });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.person.classification, "suspect");
  assert.equal(created.body.verification.state, "CONFIRMED");
  assert.match(created.body.disclaimer, /not identifications/);

  const detail = await call(pune, "GET", `/api/third-eye/persons/${created.body.person.id}?purpose=${encodeURIComponent(purpose)}`);
  assert.equal(detail.body.integrity.intact, true);
  assert.equal(detail.body.events[0].kind, "created");

  // Reclassifying needs a reason, and the change is recorded on the timeline.
  const id = created.body.person.id;
  assert.equal((await call(pune, "PATCH", `/api/third-eye/persons/${id}`, { body: { classification: "accused" } })).status, 400);
  const changed = await call(pune, "PATCH", `/api/third-eye/persons/${id}`, { body: { classification: "accused", reason: "Chargesheet filed in FIR 112/2026" } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  const after = await call(pune, "GET", `/api/third-eye/persons/${id}`);
  const update = after.body.events.find((e: any) => e.kind === "updated");
  assert.deepEqual(update.detail.classification, { from: "suspect", to: "accused" });
  assert.equal(after.body.integrity.intact, true, "the new digest was anchored");
});

test("a second record for the same individual is raised as a possible duplicate lead, not merged", async () => {
  await call(pune, "POST", "/api/third-eye/persons", { body: person });
  const second = await call(mumbai, "POST", "/api/third-eye/persons", { body: { ...person, fullName: "Ravi S. Patil", aliases: [], ageEstimate: 33 } });
  assert.equal(second.status, 201);
  assert.equal(second.body.leads.length, 1);
  assert.equal(second.body.leads[0].kind, "possible_duplicate");
  assert.equal(mem.table("ti_persons").length, 2, "nothing is merged automatically");
});

test("searches require a purpose, which goes to the audit trail with the criteria", async () => {
  const created = (await call(pune, "POST", "/api/third-eye/persons", { body: person })).body.person;
  await call(pune, "POST", `/api/third-eye/persons/${created.id}/cases`, { body: puneRobbery });

  assert.equal((await call(mumbai, "POST", "/api/third-eye/search", { body: { name: "Ravi Patil" } })).status, 400);
  assert.equal((await call(mumbai, "POST", "/api/third-eye/search", { body: { purpose: "look" , name: "Ravi" } })).status, 400);
  assert.equal((await call(mumbai, "POST", "/api/third-eye/search", { body: { purpose } })).status, 400, "at least one criterion");

  const byName = await call(mumbai, "POST", "/api/third-eye/search", { body: { purpose, name: "Ravi Patil" } });
  assert.equal(byName.status, 200);
  assert.equal(byName.body.results[0].person.id, created.id);
  assert.deepEqual(byName.body.results[0].stations, ["Shivajinagar PS, Pune"]);

  const byMo = await call(mumbai, "POST", "/api/third-eye/search", { body: { purpose, modusOperandi: "motorcycle bag snatch near bus stop red helmet" } });
  assert.equal(byMo.body.results.length, 1);
  const byAlias = await call(mumbai, "POST", "/api/third-eye/search", { body: { purpose, name: "Bunty" } });
  assert.equal(byAlias.body.results.length, 1);

  const logged = mem.table("action_log").filter((a) => a.action === "third_eye.search");
  assert.equal(logged.length, 3);
  assert.equal(logged[0].detail.purpose, purpose);
  assert.equal(logged[0].actor_id, mumbai.id);
});

test("a similar case at another station is raised as a lead; confirming it alerts the other station", async () => {
  const p1 = (await call(pune, "POST", "/api/third-eye/persons", { body: person })).body.person;
  await call(pune, "POST", `/api/third-eye/persons/${p1.id}/cases`, { body: puneRobbery });
  const p2 = (await call(mumbai, "POST", "/api/third-eye/persons", { body: { fullName: "Unknown rider (red helmet)", classification: "person_of_interest" } })).body.person;
  const linked = await call(mumbai, "POST", `/api/third-eye/persons/${p2.id}/cases`, {
    body: {
      ...puneRobbery,
      firNumber: "77/2026",
      policeStation: "Dadar PS, Mumbai",
      modusOperandi: "Pillion rider snatches bag from pedestrian at bus stop, escapes on black motorcycle, rider in red helmet",
      crimeDate: "2026-07-02",
    },
  });
  assert.equal(linked.status, 201, JSON.stringify(linked.body));
  assert.equal(linked.body.leads.length, 1);
  const lead = linked.body.leads[0];
  assert.equal(lead.kind, "related_cases");

  // Same FIR twice on one person is refused.
  assert.equal((await call(mumbai, "POST", `/api/third-eye/persons/${p2.id}/cases`, { body: { ...puneRobbery, firNumber: "77/2026", policeStation: "Dadar PS, Mumbai" } })).status, 409);

  // A review needs a real reason.
  assert.equal((await call(mumbai, "POST", `/api/third-eye/leads/${lead.id}/review`, { body: { decision: "confirmed", note: "yes" } })).status, 400);
  const reviewed = await call(mumbai, "POST", `/api/third-eye/leads/${lead.id}/review`, {
    body: { decision: "confirmed", note: "Same vehicle description and timing pattern; CCTV from both scenes requested." },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
  assert.equal((await call(mumbai, "POST", `/api/third-eye/leads/${lead.id}/review`, { body: { decision: "rejected", note: "Changing my mind about this one." } })).status, 409);

  const puneAlerts = (await call(pune, "GET", "/api/smart/alerts")).body.alerts;
  assert.equal(puneAlerts.length, 1);
  assert.equal(puneAlerts[0].kind, "third_eye_link");
  assert.equal(puneAlerts[0].payload.yourFir, "112/2026");
  assert.equal(puneAlerts[0].payload.otherFir, "77/2026");
});

test("the same photograph on two records is a lead; sketches are never auto-compared", async () => {
  const p1 = (await call(pune, "POST", "/api/third-eye/persons", { body: person })).body.person;
  const p2 = (await call(mumbai, "POST", "/api/third-eye/persons", { body: { fullName: "Suresh Kale", classification: "suspect" } })).body.person;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(1500)]);
  const upload = (actor: Actor, id: string, kind: string, hash: string) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("perceptualHash", hash);
    form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "p.jpg");
    return call(actor, "POST", `/api/third-eye/persons/${id}/media`, { form });
  };
  const first = await upload(pune, p1.id, "cctv_still", "f0f0f0f0aaaa5555");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await upload(mumbai, p2.id, "suspect_photo", "f0f0f0f0aaaa5554"); // 1 bit differs
  assert.equal(second.body.leads.length, 1);
  assert.equal(second.body.leads[0].kind, "image_similarity");
  assert.match(second.body.leads[0].reasons.join(" "), /not a facial identification/);

  const sketch = await upload(mumbai, p2.id, "sketch", "f0f0f0f0aaaa5555");
  assert.equal(sketch.body.leads.length, 0, "sketches are stored but not compared");

  const byImage = await call(mumbai, "POST", "/api/third-eye/search/image", { body: { purpose, perceptualHash: "f0f0f0f0aaaa5557" } });
  assert.equal(byImage.body.results.length, 2);
  assert.equal(mem.table("secure_media").length, 3, "an image search stores nothing");

  const meta = await call(pune, "GET", "/api/third-eye/meta");
  assert.equal(meta.body.capabilities.faceRecognition, false);
});

test("repeat offenders across stations are listed, and only police can touch person records", async () => {
  const p = (await call(pune, "POST", "/api/third-eye/persons", { body: person })).body.person;
  await call(pune, "POST", `/api/third-eye/persons/${p.id}/cases`, { body: puneRobbery });
  await call(mumbai, "POST", `/api/third-eye/persons/${p.id}/cases`, { body: { ...puneRobbery, firNumber: "201/2026", policeStation: "Dadar PS, Mumbai" } });
  const repeat = await call(pune, "GET", "/api/third-eye/repeat-offenders");
  assert.equal(repeat.body.people.length, 1);
  assert.equal(repeat.body.people[0].stations.length, 2);

  const registry = makeActor("court_admin");
  const defence = makeActor("defence_lawyer");
  assert.equal((await call(registry, "GET", `/api/third-eye/persons/${p.id}`)).status, 403);
  assert.equal((await call(registry, "GET", "/api/third-eye/activity")).status, 200, "oversight reads the activity log");
  assert.equal((await call(defence, "POST", "/api/third-eye/search", { body: { purpose, name: "Ravi" } })).status, 403);
  assert.equal((await call(defence, "GET", "/api/third-eye/activity")).status, 403);
});
