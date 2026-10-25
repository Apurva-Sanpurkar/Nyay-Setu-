import { test, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "crypto";
import { call, makeActor, mem, resetDatabase, stopServer, type Actor } from "./support/harness";
import { FakeChain } from "./support/fakeChain";
import { env } from "../src/config/env";
import { comparePlates, normalisePlate, plateShape } from "../src/lib/similarity";

after(stopServer);

let fake: FakeChain;
let stationA: Actor;
let stationB: Actor;
const depth = env.confirmationDepth;

function at(actor: Actor, station: string): Actor {
  mem.table("users").find((u) => u.id === actor.id)!.station_or_court = station;
  return actor;
}

beforeEach(() => {
  resetDatabase();
  fake = new FakeChain().install();
  (env as any).confirmationDepth = 1;
  stationA = at(makeActor("police"), "Shivajinagar PS");
  stationB = at(makeActor("police"), "Kothrud PS");
});
afterEach(() => {
  fake.uninstall();
  (env as any).confirmationDepth = depth;
});

const stolen = {
  reportType: "stolen",
  registration: "MH-12 AB 1234",
  vehicleType: "two_wheeler",
  make: "Honda",
  model: "Activa",
  colour: "Grey",
  complaintRef: "FIR 112/2026",
  ownerContact: "Owner: +91 98220 00000",
};
const found = {
  reportType: "abandoned",
  registration: "MH12AB1234",
  vehicleType: "two_wheeler",
  make: "Honda",
  colour: "Grey",
  latitude: 18.5074,
  longitude: 73.8077,
  locationSource: "gps",
  locationText: "Roadside near Karve Road",
};

test("plates are normalised and Indian formats recognised; misreads compare as partial", () => {
  assert.equal(normalisePlate("mh-12 ab 1234"), "MH12AB1234");
  assert.deepEqual(plateShape("MH12AB1234"), { valid: true, format: "standard", state: "MH", serial: "1234" });
  assert.equal(plateShape("22BH1234AA").format, "bharat");
  assert.equal(plateShape("XX12AB1234").valid, false, "XX is not a state code");
  assert.equal(comparePlates("MH12AB1234", "MH12AB1234").kind, "exact");
  assert.equal(comparePlates("MH12AB1234", "MH12A81234").kind, "partial", "B read as 8");
  assert.equal(comparePlates("MH12AB1234", "MH14CD1234").kind, "partial", "same state and serial");
  assert.equal(comparePlates("MH12AB1234", "KA01ZZ9876").kind, "none");
});

test("a stolen bike found in another jurisdiction is matched and the complaint station is alerted", async () => {
  const complaint = await call(stationA, "POST", "/api/vehicles", { body: stolen });
  assert.equal(complaint.status, 201, JSON.stringify(complaint.body));
  assert.equal(complaint.body.report.status, "MISSING_REPORTED");
  assert.equal(complaint.body.report.registration_norm, "MH12AB1234");
  assert.equal(complaint.body.verification.state, "CONFIRMED", "the complaint's digest is anchored");

  const sighting = await call(stationB, "POST", "/api/vehicles", { body: found });
  assert.equal(sighting.status, 201, JSON.stringify(sighting.body));
  assert.equal(sighting.body.matches.length, 1);
  assert.equal(sighting.body.matches[0].match_type, "exact_registration");
  assert.equal(sighting.body.report.status, "POTENTIAL_MATCH");

  // Station A, which holds the complaint, has the alert with what it needs to act.
  const alerts = await call(stationA, "GET", "/api/smart/alerts");
  assert.equal(alerts.body.alerts.length, 1);
  const payload = alerts.body.alerts[0].payload;
  assert.equal(payload.registration, "MH12AB1234");
  assert.equal(payload.originalComplaintRef, "FIR 112/2026");
  assert.equal(payload.reportingStation, "Kothrud PS");
  assert.match(payload.mapsLink, /google\.com\/maps\?q=18\.5074,73\.8077/);
  // Station B raised it and is not its addressee.
  assert.equal((await call(stationB, "GET", "/api/smart/alerts")).body.alerts.length, 0);

  // The owner's contact is for the complaint station only.
  const fromB = await call(stationB, "GET", `/api/vehicles/${complaint.body.report.id}`);
  assert.equal(fromB.body.report.owner_contact, null);
  assert.equal(fromB.body.report.owner_contact_withheld, true);
  const fromA = await call(stationA, "GET", `/api/vehicles/${complaint.body.report.id}`);
  assert.equal(fromA.body.report.owner_contact, stolen.ownerContact);
  assert.equal(fromA.body.integrity.intact, true);
  assert.equal(fromA.body.integrity.onChain, true, "confirmed by the (fake) chain");
});

test("the same vehicle reported twice is refused as a duplicate and the existing report is returned", async () => {
  await call(stationB, "POST", "/api/vehicles", { body: found });
  const again = await call(stationA, "POST", "/api/vehicles", { body: { ...found, reportType: "found" } });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "DUPLICATE_REPORT");
  assert.equal(again.body.error.details.existing.registration, "MH12AB1234");

  // Without a plate: same type and colour within 150 m is a likely duplicate,
  // which the officer may override after looking.
  const noPlate = { ...found, registration: null, latitude: 18.5075, longitude: 73.8078, colour: "Red", make: "Bajaj" };
  assert.equal((await call(stationB, "POST", "/api/vehicles", { body: noPlate })).status, 201);
  const near = await call(stationA, "POST", "/api/vehicles", { body: noPlate });
  assert.equal(near.status, 409);
  assert.equal((await call(stationA, "POST", "/api/vehicles", { body: { ...noPlate, confirmNotDuplicate: true } })).status, 201);

  // An observation goes onto the existing report instead.
  const existing = again.body.error.details.existing.id;
  const obs = await call(stationA, "POST", `/api/vehicles/${existing}/observations`, { body: { note: "Seen again this morning, front tyre flat." } });
  assert.equal(obs.status, 201);
});

test("a misread plate is offered as a partial match for an officer to verify", async () => {
  await call(stationA, "POST", "/api/vehicles", { body: stolen });
  const sighting = await call(stationB, "POST", "/api/vehicles", { body: { ...found, registration: "MH12A81234", registrationSource: "anpr" } });
  assert.equal(sighting.body.matches.length, 1);
  assert.equal(sighting.body.matches[0].match_type, "partial_registration");
  assert.ok(sighting.body.matches[0].score < 1);
});

test("the recovery workflow moves both reports together, refuses skipped steps, and anchors the handover", async () => {
  const complaint = (await call(stationA, "POST", "/api/vehicles", { body: stolen })).body.report;
  const sighting = (await call(stationB, "POST", "/api/vehicles", { body: found })).body;
  const matchId = sighting.matches[0].id;

  // Status cannot jump to returned, and a match cannot be verified without a reason.
  assert.equal((await call(stationB, "POST", `/api/vehicles/${complaint.id}/status`, { body: { status: "VEHICLE_RETURNED", note: "Handed over to owner" } })).status, 409);
  assert.equal((await call(stationA, "POST", `/api/vehicles/matches/${matchId}/decision`, { body: { decision: "verified", note: "ok" } })).status, 400);

  // An officer of an uninvolved station cannot decide it.
  const stationC = at(makeActor("police"), "Hinjewadi PS");
  assert.equal((await call(stationC, "POST", `/api/vehicles/matches/${matchId}/decision`, { body: { decision: "verified", note: "Chassis number checked on site." } })).status, 403);

  const verified = await call(stationA, "POST", `/api/vehicles/matches/${matchId}/decision`, { body: { decision: "verified", note: "Chassis number checked on site, matches the RC." } });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  for (const id of [complaint.id, sighting.report.id]) {
    assert.equal(mem.table("vehicle_reports").find((r) => r.id === id)!.status, "MATCH_VERIFIED");
  }

  for (const [status, note] of [
    ["RECOVERY_IN_PROGRESS", null],
    ["OWNER_VERIFICATION_PENDING", null],
    ["VEHICLE_RETURNED", "Returned to the registered owner after RC and ID were verified."],
    ["CASE_CLOSED", "Recovered and returned; complaint disposed of."],
  ] as const) {
    const moved = await call(stationB, "POST", `/api/vehicles/${sighting.report.id}/status`, { body: { status, note } });
    assert.equal(moved.status, 200, `${status}: ${JSON.stringify(moved.body)}`);
  }
  assert.equal(mem.table("vehicle_reports").find((r) => r.id === complaint.id)!.status, "CASE_CLOSED", "the linked complaint moved too");

  const detail = await call(stationA, "GET", `/api/vehicles/${complaint.id}`);
  const anchored = detail.body.events.filter((e: any) => e.anchored).map((e: any) => e.to_status);
  assert.deepEqual(anchored, ["MATCH_VERIFIED", "RECOVERY_IN_PROGRESS", "VEHICLE_RETURNED", "CASE_CLOSED"]);
  assert.ok(detail.body.events.every((e: any, i: number, all: any[]) => i === 0 || e.previous_digest === all[i - 1].event_digest), "the timeline is hash-chained");

  // Station B returned it, so station A is told.
  const alerts = (await call(stationA, "GET", "/api/smart/alerts")).body.alerts;
  assert.ok(alerts.some((a: any) => a.kind === "vehicle_recovered"));
});

test("rejecting the only match sends both reports back to where they started", async () => {
  await call(stationA, "POST", "/api/vehicles", { body: stolen });
  const sighting = (await call(stationB, "POST", "/api/vehicles", { body: found })).body;
  const rejected = await call(stationB, "POST", `/api/vehicles/matches/${sighting.matches[0].id}/decision`, {
    body: { decision: "rejected", note: "Different chassis number; cloned plate suspected." },
  });
  assert.equal(rejected.status, 200);
  const statuses = mem.table("vehicle_reports").map((r) => r.status).sort();
  assert.deepEqual(statuses, ["MISSING_REPORTED", "VEHICLE_FOUND"]);
});

test("a record edited outside the API fails its integrity check", async () => {
  const complaint = (await call(stationA, "POST", "/api/vehicles", { body: stolen })).body.report;
  mem.table("vehicle_reports").find((r) => r.id === complaint.id)!.colour = "Black";
  const detail = await call(stationA, "GET", `/api/vehicles/${complaint.id}`);
  assert.equal(detail.body.integrity.intact, false);
  assert.equal(detail.body.integrity.rowMatchesStoredDigest, false);
});

test("photographs are stored encrypted, served back intact, and only images are accepted", async () => {
  const report = (await call(stationB, "POST", "/api/vehicles", { body: found })).body.report;
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]);
  const form = new FormData();
  form.append("kind", "vehicle_photo");
  form.append("file", new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" }), "bike.jpg");
  const stored = await call(stationB, "POST", `/api/vehicles/${report.id}/media`, { form });
  assert.equal(stored.status, 201, JSON.stringify(stored.body));
  assert.equal(stored.body.media.mime_type, "image/jpeg");

  const served = await call(stationA, "GET", `/api/smart/media/${stored.body.media.id}`);
  assert.equal(served.status, 200);
  assert.ok(Buffer.from(served.raw).equals(jpeg));

  const bad = new FormData();
  bad.append("kind", "vehicle_photo");
  bad.append("file", new Blob([new TextEncoder().encode("#!/bin/sh\necho hi")]), "x.jpg");
  assert.equal((await call(stationB, "POST", `/api/vehicles/${report.id}/media`, { form: bad })).status, 400);
});

test("only police may file; the registry may read; other roles are refused", async () => {
  const judge = makeActor("judge");
  const accused = makeActor("accused");
  const registry = makeActor("court_admin");
  assert.equal((await call(judge, "GET", "/api/vehicles")).status, 403);
  assert.equal((await call(accused, "POST", "/api/vehicles", { body: stolen })).status, 403);
  assert.equal((await call(registry, "POST", "/api/vehicles", { body: stolen })).status, 403);
  assert.equal((await call(registry, "GET", "/api/vehicles")).status, 200);
  assert.equal((await call(null, "GET", "/api/vehicles")).status, 401);
  assert.equal((await call(stationA, "POST", "/api/vehicles", { body: stolen, noCsrf: true })).status, 403);
  // A stolen report needs something to identify the vehicle by.
  assert.equal((await call(stationA, "POST", "/api/vehicles", { body: { ...stolen, registration: null } })).status, 400);
});

test("server ANPR answers 501 when no provider is configured, so the app reads plates on the device", async () => {
  const form = new FormData();
  form.append("image", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0x00])]), "p.jpg");
  const result = await call(stationA, "POST", "/api/vehicles/anpr", { form });
  assert.equal(result.status, 501);
  assert.equal(result.body.error.code, "ANPR_ON_DEVICE");
});
