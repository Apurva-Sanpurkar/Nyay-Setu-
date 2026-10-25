import type { Request } from "express";
import { db, unwrapList } from "../lib/supabase";
import { logger } from "../lib/logger";
import type { SessionUser } from "../middleware/auth";
import { createReport } from "../services/vehicleTrace.service";
import { addCaseLink, createPerson } from "../services/thirdEye.service";

/**
 * Synthetic demonstration data for Vehicle Trace and Third Eye.
 *
 * Every name, registration number, FIR and place below is invented. None of it
 * is drawn from, or should be mistaken for, a real police record. It is written
 * through the same services as live data, so it is anchored, audited and
 * matched exactly as an officer's entry would be.
 *
 *   Local stack:     seeded automatically into the memory database.
 *   Real database:   npm --prefix backend run demo:smart -- --confirm
 *                    (needs at least one active police account; uses the
 *                    stations already on those accounts)
 */

function seedRequest(user: SessionUser): Request {
  return { user, ip: "127.0.0.1", get: () => "nyaysetu-demo-seed" } as unknown as Request;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

export async function seedSmartDemo(officers: SessionUser[]): Promise<{ vehicles: number; persons: number }> {
  if (officers.length === 0) throw new Error("Seeding needs at least one police officer.");
  const a = officers[0];
  const b = officers[1] ?? officers[0];
  const c = officers[2] ?? b;
  const ra = seedRequest(a);
  const rb = seedRequest(b);
  const rc = seedRequest(c);
  let vehicles = 0;
  let persons = 0;

  const file = async (req: Request, user: SessionUser, input: Parameters<typeof createReport>[2]) => {
    try {
      await createReport(req, user, input);
      vehicles++;
    } catch (error) {
      logger.warn("Demo vehicle skipped", { error: error instanceof Error ? error.message : error });
    }
  };

  // Complaints at station A.
  await file(ra, a, { reportType: "stolen", registration: "MH12QW4821", vehicleType: "two_wheeler", make: "Honda", model: "Activa 6G", colour: "Grey", chassisLast5: "K4821", complaintRef: "FIR 214/2026 (DEMO)", incidentAt: daysAgo(6), ownerContact: "Demo owner, +91 90000 00001", latitude: 18.5308, longitude: 73.8475, locationSource: "manual", locationText: "Outside FC Road bus stop (demo)" });
  await file(ra, a, { reportType: "stolen", registration: "MH12HJ7710", vehicleType: "car", make: "Maruti Suzuki", model: "Swift", colour: "Red", complaintRef: "FIR 219/2026 (DEMO)", incidentAt: daysAgo(4), ownerContact: "Demo owner, +91 90000 00002" });
  await file(ra, a, { reportType: "missing", registration: "MH14ZX3302", vehicleType: "two_wheeler", make: "Bajaj", model: "Pulsar 150", colour: "Black", complaintRef: "NC 88/2026 (DEMO)", incidentAt: daysAgo(10) });
  await file(ra, a, { reportType: "stolen", registration: "MH12LP0904", vehicleType: "three_wheeler", make: "Bajaj", model: "RE Auto", colour: "Yellow", complaintRef: "FIR 230/2026 (DEMO)", incidentAt: daysAgo(2) });

  // Sightings at station B: one exact match, one misread plate, one unrelated.
  await file(rb, b, { reportType: "abandoned", registration: "MH12QW4821", registrationSource: "anpr", vehicleType: "two_wheeler", make: "Honda", colour: "Grey", conditionNotes: "Ignition lock broken, no helmet lock (demo).", latitude: 18.5074, longitude: 73.8077, locationAccuracyM: 12, locationSource: "gps", locationText: "Lane behind Karve Road petrol pump (demo)" });
  await file(rb, b, { reportType: "found", registration: "MH12HJ771O", registrationSource: "anpr", vehicleType: "car", make: "Maruti Suzuki", colour: "Red", conditionNotes: "Rear number plate missing; front plate dirty (demo).", latitude: 18.4966, longitude: 73.8586, locationSource: "manual", locationText: "Swargate depot parking (demo)" });
  await file(rb, b, { reportType: "suspicious", registration: "KA05MN1188", vehicleType: "suv", make: "Mahindra", model: "Scorpio", colour: "White", conditionNotes: "Parked 3 days, tinted windows (demo).", latitude: 18.5196, longitude: 73.8553, locationSource: "manual", locationText: "Near Shaniwar Wada (demo)" });
  await file(rc, c, { reportType: "abandoned", vehicleType: "bicycle", colour: "Blue", conditionNotes: "No plate; front wheel missing (demo).", latitude: 18.5600, longitude: 73.7769, locationSource: "manual", locationText: "Baner road footpath (demo)" });

  // Third Eye: a chain-snatching pattern across two stations.
  const person = async (req: Request, user: SessionUser, input: Parameters<typeof createPerson>[2], links: Parameters<typeof addCaseLink>[3][]) => {
    try {
      const created = await createPerson(req, user, input);
      persons++;
      for (const link of links) await addCaseLink(req, user, created.person.id, link);
    } catch (error) {
      logger.warn("Demo person skipped", { error: error instanceof Error ? error.message : error });
    }
  };
  const stationA = a.stationOrCourt ?? "Station A";
  const stationB = b.stationOrCourt ?? "Station B";

  await person(ra, a, { fullName: "Demo Suspect Raju Kale", aliases: ["Bunty (demo)"], gender: "male", ageEstimate: 29, heightCm: 172, build: "Thin", identifyingMarks: "Scar on right cheek; dragon tattoo on left forearm", classification: "accused" }, [
    { firNumber: "DEMO-140/2026", policeStation: stationA, offence: "Snatching (BNS 304)", offenceCategory: "chain_snatching", modusOperandi: "Two men on a black motorcycle without number plate snatch gold chains from women walking near temples in the early morning; pillion rider wears a red cap", crimeDate: daysAgo(70).slice(0, 10), crimeLocation: "Near Omkareshwar temple (demo)", involvement: "accused", investigationStatus: "chargesheeted", arrestStatus: "on_bail", investigatingOfficer: "PSI Demo One" },
  ]);
  await person(rb, b, { fullName: "Unidentified pillion rider (demo)", gender: "male", ageEstimate: 30, physicalDescription: "Thin build, red cap, black jacket", identifyingMarks: "Tattoo on left forearm visible in CCTV", classification: "person_of_interest" }, [
    { firNumber: "DEMO-311/2026", policeStation: stationB, offence: "Snatching (BNS 304)", offenceCategory: "chain_snatching", modusOperandi: "Pillion rider in red cap snatches gold chain from woman near temple at dawn, escapes on black motorcycle with no number plate", crimeDate: daysAgo(12).slice(0, 10), crimeLocation: "Near Dagdusheth temple (demo)", involvement: "suspect", investigationStatus: "under_investigation", arrestStatus: "not_arrested" },
  ]);
  await person(rb, b, { fullName: "Demo Suspect Raju Kaale", gender: "male", ageEstimate: 31, classification: "suspect" }, [
    { firNumber: "DEMO-298/2026", policeStation: stationB, offence: "Theft of motorcycle (BNS 303)", offenceCategory: "vehicle_theft", modusOperandi: "Breaks handle lock of parked two-wheelers outside hospitals at night", crimeDate: daysAgo(30).slice(0, 10), involvement: "suspect", investigationStatus: "under_investigation" },
  ]);
  await person(rc, c, { fullName: "Demo Convict Salim Shaikh", aliases: ["Salim Sheikh"], gender: "male", dateOfBirth: "1988-04-12", classification: "convicted" }, [
    { firNumber: "DEMO-55/2023", policeStation: c.stationOrCourt ?? stationB, offence: "House-breaking by night (BNS 331)", offenceCategory: "burglary", modusOperandi: "Enters locked flats through bathroom ventilator during festival holidays", crimeDate: "2023-10-24", involvement: "convicted", investigationStatus: "convicted", courtStatus: "Convicted, JMFC (demo)" },
    { firNumber: "DEMO-402/2026", policeStation: stationA, offence: "House-breaking (BNS 331)", offenceCategory: "burglary", modusOperandi: "Ventilator removed to enter locked flat while family away for the festival", crimeDate: daysAgo(20).slice(0, 10), involvement: "suspect", investigationStatus: "under_investigation" },
  ]);

  return { vehicles, persons };
}

/** CLI entry for a real database. Refuses to run twice or without --confirm. */
async function main() {
  if (!process.argv.includes("--confirm")) {
    console.error("This writes synthetic demonstration records (marked DEMO) to the configured database. Re-run with --confirm.");
    process.exit(1);
  }
  const existing = unwrapList(await db.from("vehicle_reports").select("id").ilike("complaint_ref", "%(DEMO)%").limit(1));
  if (existing.length) {
    console.log("Demo records already exist; nothing written.");
    return;
  }
  const police = unwrapList(
    await db.from("users").select("id, email, full_name, role, designation, station_or_court, theme").eq("role", "police").eq("is_active", true).limit(20)
  ) as any[];
  const byStation = new Map<string, any>();
  for (const p of police) if (p.station_or_court && !byStation.has(p.station_or_court)) byStation.set(p.station_or_court, p);
  const officers: SessionUser[] = [...byStation.values()].map((p) => ({
    id: p.id,
    email: p.email,
    fullName: p.full_name,
    role: "police",
    designation: p.designation,
    stationOrCourt: p.station_or_court,
    theme: p.theme ?? "light",
    aadhaarToken: null,
    mustChangePassword: false,
  }));
  const result = await seedSmartDemo(officers);
  console.log(`Seeded ${result.vehicles} vehicle reports and ${result.persons} Third Eye records across ${officers.length} station(s).`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
