import { randomUUID } from "crypto";
import { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { AppError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { canonicalHash, decryptField, encryptField } from "../lib/crypto";
import { comparePlates, distanceMetres, normalisePlate, plateShape, round3, stationNorm, textNorm } from "../lib/similarity";
import { recordAction } from "./audit";
import type { SessionUser } from "../middleware/auth";
import { anchorRecord, anchoredDigests, integrityVerdict, orderChain, verificationsFor } from "./smart/recordAnchor";
import { listMedia } from "./smart/media.service";
import { raiseStationAlert } from "./smart/stationAlerts.service";

/**
 * Vehicle Trace: lost, stolen, found and abandoned vehicles across stations.
 *
 * A report is one officer's account of one vehicle. A "sought" report (missing,
 * stolen) and a "sighted" report (found, abandoned, suspicious) are compared on
 * registration number and characteristics; a likely pair becomes a match that
 * an officer of either station verifies or rejects. Nothing is ever matched,
 * returned or closed automatically.
 */

export const VEHICLE_STATUSES = [
  "MISSING_REPORTED",
  "VEHICLE_FOUND",
  "POTENTIAL_MATCH",
  "VERIFICATION_PENDING",
  "MATCH_VERIFIED",
  "RECOVERY_IN_PROGRESS",
  "OWNER_VERIFICATION_PENDING",
  "VEHICLE_RETURNED",
  "CASE_CLOSED",
] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const REPORT_TYPES = ["missing", "stolen", "found", "abandoned", "suspicious"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const VEHICLE_TYPES = ["two_wheeler", "three_wheeler", "car", "suv", "truck", "bus", "tractor", "bicycle", "other"] as const;

const SOUGHT: ReportType[] = ["missing", "stolen"];
const SIGHTED: ReportType[] = ["found", "abandoned", "suspicious"];
const CLOSED: VehicleStatus[] = ["VEHICLE_RETURNED", "CASE_CLOSED"];

export const isSought = (type: string) => SOUGHT.includes(type as ReportType);

/**
 * Where an officer may move a report by hand. MATCH_VERIFIED is absent on
 * purpose: it is reached only by verifying a match, and POTENTIAL_MATCH only by
 * the matcher.
 */
const MANUAL_TRANSITIONS: Partial<Record<VehicleStatus, VehicleStatus[]>> = {
  MISSING_REPORTED: ["CASE_CLOSED"],
  VEHICLE_FOUND: ["OWNER_VERIFICATION_PENDING", "CASE_CLOSED"],
  POTENTIAL_MATCH: ["VERIFICATION_PENDING"],
  MATCH_VERIFIED: ["RECOVERY_IN_PROGRESS"],
  RECOVERY_IN_PROGRESS: ["OWNER_VERIFICATION_PENDING"],
  OWNER_VERIFICATION_PENDING: ["VEHICLE_RETURNED"],
  VEHICLE_RETURNED: ["CASE_CLOSED"],
};

export function allowedNext(status: VehicleStatus): VehicleStatus[] {
  return MANUAL_TRANSITIONS[status] ?? [];
}

/** The steps that are anchored on chain, beyond the report itself. */
const ANCHORED_STATUSES: VehicleStatus[] = ["MATCH_VERIFIED", "RECOVERY_IN_PROGRESS", "VEHICLE_RETURNED", "CASE_CLOSED"];

/** Statuses that need a written reason, because they end something. */
const NEEDS_REASON: VehicleStatus[] = ["VEHICLE_RETURNED", "CASE_CLOSED"];

export interface ReportInput {
  reportType: ReportType;
  registration?: string | null;
  registrationSource?: "manual" | "anpr" | "anpr_corrected" | "none";
  vehicleType: (typeof VEHICLE_TYPES)[number];
  make?: string | null;
  model?: string | null;
  colour?: string | null;
  chassisLast5?: string | null;
  conditionNotes?: string | null;
  complaintRef?: string | null;
  caseId?: string | null;
  incidentAt?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  locationAccuracyM?: number | null;
  locationSource?: "gps" | "manual" | "none";
  locationText?: string | null;
  ownerContact?: string | null;
  confirmNotDuplicate?: boolean;
}

/** The fields a report's digest covers: what the officer said, not its status. */
function reportDigest(row: any): string {
  return canonicalHash({
    id: row.id,
    reportType: row.report_type,
    registration: row.registration_norm ?? null,
    vehicleType: row.vehicle_type,
    make: row.make ?? null,
    model: row.model ?? null,
    colour: row.colour ?? null,
    chassisLast5: row.chassis_last5 ?? null,
    complaintRef: row.complaint_ref ?? null,
    incidentAt: row.incident_at ? new Date(row.incident_at).toISOString() : null,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    locationText: row.location_text ?? null,
    station: row.station,
    reportedBy: row.reported_by ?? null,
    reportedAt: new Date(row.reported_at).toISOString(),
  });
}

/* ------------------------------------------------------------ timeline */

async function appendEvent(
  reportId: string,
  user: SessionUser,
  event: { kind: "reported" | "observation" | "status" | "match" | "media"; from?: string | null; to?: string | null; note?: string | null },
  anchor = false
) {
  const last = orderChain(
    unwrapList(await db.from("vehicle_events").select("event_digest, previous_digest").eq("report_id", reportId)) as { event_digest: string; previous_digest: string | null }[]
  ).at(-1);
  const occurredAt = new Date().toISOString();
  const digest = canonicalHash({
    reportId,
    kind: event.kind,
    from: event.from ?? null,
    to: event.to ?? null,
    note: event.note ?? null,
    actor: user.id,
    occurredAt,
    previous: last?.event_digest ?? null,
  });
  const row = unwrap(
    await db
      .from("vehicle_events")
      .insert({
        report_id: reportId,
        kind: event.kind,
        from_status: event.from ?? null,
        to_status: event.to ?? null,
        note: event.note ?? null,
        actor_id: user.id,
        actor_station: user.stationOrCourt,
        occurred_at: occurredAt,
        event_digest: digest,
        previous_digest: last?.event_digest ?? null,
        anchored: anchor,
      })
      .select("*")
      .single()
  ) as any;
  if (anchor) {
    await anchorRecord({
      module: "vehicle_trace",
      recordId: reportId,
      digest,
      subjectType: "vehicle_event",
      subjectId: row.id,
      idempotencyKey: `vehicle_event:${row.id}`,
      actor: { id: user.id, role: user.role },
    });
  }
  return row;
}

async function setStatus(report: any, to: VehicleStatus, user: SessionUser, note: string | null) {
  if (report.status === to) return report;
  const updated = unwrap(await db.from("vehicle_reports").update({ status: to }).eq("id", report.id).select("*").single()) as any;
  await appendEvent(report.id, user, { kind: "status", from: report.status, to, note }, ANCHORED_STATUSES.includes(to));
  return updated;
}

/* ------------------------------------------------------------- summary */

function summary(r: any) {
  return {
    id: r.id,
    report_type: r.report_type,
    registration: r.registration_norm,
    vehicle_type: r.vehicle_type,
    make: r.make,
    model: r.model,
    colour: r.colour,
    status: r.status,
    station: r.station,
    complaint_ref: r.complaint_ref,
    location_text: r.location_text,
    latitude: r.latitude,
    longitude: r.longitude,
    reported_at: r.reported_at,
  };
}

export function mapsLink(lat: number | null, lng: number | null): string | null {
  return lat === null || lng === null || lat === undefined || lng === undefined ? null : `https://www.google.com/maps?q=${lat},${lng}`;
}

/* --------------------------------------------------------- duplicates */

/**
 * The same vehicle already reported and still open, on the same side (two
 * "found" reports for one bike are a duplicate; a "stolen" and a "found" are a
 * match). By registration when there is one; otherwise by type and colour
 * within 150 m in the last three days.
 */
export async function findDuplicate(input: { reportType: ReportType; registration: string | null; vehicleType: string; colour?: string | null; latitude?: number | null; longitude?: number | null }) {
  const side = isSought(input.reportType) ? SOUGHT : SIGHTED;
  if (input.registration) {
    const rows = unwrapList(
      await db.from("vehicle_reports").select("*").eq("registration_norm", input.registration).in("report_type", side)
    ) as any[];
    const open = rows.find((r) => !CLOSED.includes(r.status));
    return open ? { report: summary(open), reason: `An open ${open.report_type} report already exists for ${input.registration}.` } : null;
  }
  if (isSought(input.reportType) || input.latitude == null || input.longitude == null) return null;
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();
  const nearby = unwrapList(
    await db.from("vehicle_reports").select("*").in("report_type", SIGHTED).eq("vehicle_type", input.vehicleType).gte("reported_at", since)
  ) as any[];
  const colour = textNorm(input.colour);
  const hit = nearby.find(
    (r) =>
      !CLOSED.includes(r.status) &&
      r.latitude !== null &&
      (!colour || textNorm(r.colour) === colour) &&
      distanceMetres(input.latitude!, input.longitude!, r.latitude, r.longitude) <= 150
  );
  return hit
    ? { report: summary(hit), reason: "A vehicle of the same type and colour was reported within 150 m in the last 72 hours." }
    : null;
}

/* ------------------------------------------------------------ matching */

export interface MatchCandidate {
  sought: any;
  sighted: any;
  type: "exact_registration" | "partial_registration" | "characteristics";
  score: number;
  reasons: string[];
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = textNorm(a);
  return Boolean(na) && na === textNorm(b);
}

/** Scores one sought report against one sighted report. Null when there is nothing to look at. */
export function scorePair(sought: any, sighted: any): MatchCandidate | null {
  const plate = comparePlates(sought.registration_norm, sighted.registration_norm);
  const reasons = [...plate.reasons];
  let attributes = 0;
  let compared = 0;
  const check = (label: string, a: any, b: any, weight = 1) => {
    if (!textNorm(a) || !textNorm(b)) return;
    compared += weight;
    if (sameText(a, b)) {
      attributes += weight;
      reasons.push(`Same ${label} (${a})`);
    } else reasons.push(`Different ${label}: ${a} / ${b}`);
  };
  check("vehicle type", sought.vehicle_type, sighted.vehicle_type);
  check("make", sought.make, sighted.make);
  check("model", sought.model, sighted.model);
  check("colour", sought.colour, sighted.colour);
  check("chassis number ending", sought.chassis_last5, sighted.chassis_last5, 3);
  const attributeScore = compared ? attributes / compared : 0;
  const chassisMatch = sameText(sought.chassis_last5, sighted.chassis_last5);

  if (plate.kind === "exact") {
    const typeClash = textNorm(sought.vehicle_type) !== textNorm(sighted.vehicle_type);
    if (typeClash) reasons.push("The vehicle type differs: check for a cloned or misread plate");
    return { sought, sighted, type: "exact_registration", score: typeClash ? 0.75 : 1, reasons };
  }
  if (plate.kind === "partial") {
    const score = round3(plate.score * 0.7 + attributeScore * 0.3);
    return score >= 0.5 ? { sought, sighted, type: "partial_registration", score, reasons } : null;
  }
  // No usable plate on one side (removed, damaged or unreadable).
  if (chassisMatch) return { sought, sighted, type: "characteristics", score: round3(0.6 + attributeScore * 0.3), reasons };
  const plateMissing = !sought.registration_norm || !sighted.registration_norm;
  if (plateMissing && compared >= 4 && attributeScore === 1) {
    return { sought, sighted, type: "characteristics", score: 0.5, reasons: [...reasons, "No registration number to compare; matched on description only"] };
  }
  return null;
}

/** Compares a report against every open report on the other side. */
export async function findCandidates(report: any): Promise<MatchCandidate[]> {
  const other = isSought(report.report_type) ? SIGHTED : SOUGHT;
  const rows = unwrapList(
    await db.from("vehicle_reports").select("*").in("report_type", other).order("reported_at", { ascending: false }).limit(2000)
  ) as any[];
  const out: MatchCandidate[] = [];
  for (const row of rows) {
    if (row.id === report.id || CLOSED.includes(row.status)) continue;
    const [sought, sighted] = isSought(report.report_type) ? [report, row] : [row, report];
    const candidate = scorePair(sought, sighted);
    if (candidate) out.push(candidate);
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

async function recordMatches(req: Request, user: SessionUser, report: any) {
  const candidates = await findCandidates(report);
  const created: any[] = [];
  for (const c of candidates) {
    const existing = unwrapMaybe(
      await db.from("vehicle_matches").select("id").eq("missing_report_id", c.sought.id).eq("found_report_id", c.sighted.id).maybeSingle()
    );
    if (existing) continue;
    const match = unwrap(
      await db
        .from("vehicle_matches")
        .insert({ missing_report_id: c.sought.id, found_report_id: c.sighted.id, match_type: c.type, score: c.score, reasons: c.reasons, status: "pending" })
        .select("*")
        .single()
    ) as any;
    created.push(match);

    for (const side of [c.sought, c.sighted]) {
      const fresh = unwrap(await db.from("vehicle_reports").select("*").eq("id", side.id).single()) as any;
      if (fresh.status === "MISSING_REPORTED" || fresh.status === "VEHICLE_FOUND") {
        await setStatus(fresh, "POTENTIAL_MATCH", user, `Possible match (${c.type.replace(/_/g, " ")}, score ${c.score}).`);
      }
      await appendEvent(side.id, user, { kind: "match", note: `Possible match with report ${side.id === c.sought.id ? c.sighted.id : c.sought.id}: ${c.reasons[0] ?? ""}` });
    }

    // The station that holds the other report is the one that needs to know.
    const counterpart = report.id === c.sought.id ? c.sighted : c.sought;
    const media = await listMedia("vehicle_trace", [c.sighted.id]);
    const reporter = unwrapMaybe(await db.from("user_directory").select("full_name, designation").eq("id", report.reported_by).maybeSingle()) as any;
    await raiseStationAlert({
      targetStation: counterpart.station,
      kind: "vehicle_match",
      subjectType: "vehicle_match",
      subjectId: match.id,
      title: `${c.type === "exact_registration" ? "Exact" : "Possible"} match: ${c.sought.registration_norm ?? c.sighted.registration_norm ?? "vehicle without a readable plate"}`,
      dedupeKey: `vehicle_match:${match.id}:${counterpart.station_norm}`,
      createdBy: user.id,
      payload: {
        matchId: match.id,
        matchType: c.type,
        score: c.score,
        reasons: c.reasons,
        registration: c.sighted.registration_norm ?? c.sought.registration_norm,
        soughtReportId: c.sought.id,
        sightedReportId: c.sighted.id,
        originalComplaintRef: c.sought.complaint_ref,
        foundAt: c.sighted.reported_at,
        location: c.sighted.location_text,
        latitude: c.sighted.latitude,
        longitude: c.sighted.longitude,
        mapsLink: mapsLink(c.sighted.latitude, c.sighted.longitude),
        photoIds: media.map((m) => m.id),
        reportingStation: report.station,
        reportingOfficer: reporter ? `${reporter.full_name}${reporter.designation ? `, ${reporter.designation}` : ""}` : null,
        verificationStatus: "pending",
      },
    });
  }
  if (created.length) {
    await recordAction(req, { action: "vehicle.match_found", subject: report.id, detail: { matches: created.length } });
  }
  return created;
}

/* -------------------------------------------------------------- create */

export async function createReport(req: Request, user: SessionUser, input: ReportInput) {
  if (!user.stationOrCourt) throw badRequest("Your account has no police station recorded. Ask the registry to set it before filing reports.");
  const registration = normalisePlate(input.registration);
  if (input.registration && !registration) throw badRequest("The registration number must have between 4 and 12 letters or digits.");
  if ((input.latitude == null) !== (input.longitude == null)) throw badRequest("Send both latitude and longitude, or neither.");
  if (!isSought(input.reportType) && input.latitude == null && !input.locationText) {
    throw badRequest("Say where the vehicle was found: allow location access, pick a point on the map, or describe the place.");
  }

  const duplicate = await findDuplicate({ reportType: input.reportType, registration, vehicleType: input.vehicleType, colour: input.colour, latitude: input.latitude, longitude: input.longitude });
  if (duplicate && (registration || !input.confirmNotDuplicate)) {
    await recordAction(req, { action: "vehicle.duplicate_refused", subject: duplicate.report.id, outcome: "refused" });
    throw new AppError(409, "DUPLICATE_REPORT", `${duplicate.reason} Add your observations to it instead.`, { existing: duplicate.report, byRegistration: Boolean(registration) });
  }

  const id = randomUUID();
  const reportedAt = new Date().toISOString();
  const draft = {
    id,
    report_type: input.reportType,
    registration_norm: registration,
    registration_raw: input.registration ?? null,
    registration_source: registration ? (input.registrationSource ?? "manual") : "none",
    vehicle_type: input.vehicleType,
    make: input.make ?? null,
    model: input.model ?? null,
    colour: input.colour ?? null,
    chassis_last5: input.chassisLast5 ? input.chassisLast5.toUpperCase().replace(/[^A-Z0-9]/g, "") || null : null,
    condition_notes: input.conditionNotes ?? null,
    complaint_ref: input.complaintRef ?? null,
    case_id: input.caseId ?? null,
    incident_at: input.incidentAt ? new Date(input.incidentAt).toISOString() : null,
    latitude: input.latitude ?? null,
    longitude: input.longitude ?? null,
    location_accuracy_m: input.locationAccuracyM ?? null,
    location_source: input.latitude != null ? (input.locationSource ?? "manual") : "none",
    location_text: input.locationText ?? null,
    station: user.stationOrCourt,
    station_norm: stationNorm(user.stationOrCourt),
    owner_contact_enc: input.ownerContact ? encryptField(input.ownerContact) : null,
    status: (isSought(input.reportType) ? "MISSING_REPORTED" : "VEHICLE_FOUND") as VehicleStatus,
    reported_by: user.id,
    reported_at: reportedAt,
  };
  const report = unwrap(
    await db.from("vehicle_reports").insert({ ...draft, record_digest: reportDigest(draft) }).select("*").single()
  ) as any;

  await appendEvent(id, user, {
    kind: "reported",
    to: report.status,
    note: isSought(input.reportType) ? `Complaint registered${input.complaintRef ? ` (${input.complaintRef})` : ""}.` : `Vehicle ${input.reportType} reported.`,
  });
  const { anchor } = await anchorRecord({
    module: "vehicle_trace",
    recordId: id,
    digest: report.record_digest,
    subjectType: "vehicle_report",
    subjectId: id,
    idempotencyKey: `vehicle_report:${id}`,
    actor: { id: user.id, role: user.role },
  });
  await recordAction(req, { action: "vehicle.report", subject: id, caseId: report.case_id, detail: { type: input.reportType, state: anchor.state } });

  const matches = await recordMatches(req, user, report);
  const current = unwrap(await db.from("vehicle_reports").select("*").eq("id", id).single()) as any;
  return {
    report: present(current, user),
    plate: plateShape(registration),
    matches,
    verification: { state: anchor.state, txHash: anchor.tx_hash },
  };
}

/** Re-runs matching for one report, for a record created before a counterpart existed. */
export async function rematch(req: Request, user: SessionUser, id: string) {
  const report = unwrapMaybe(await db.from("vehicle_reports").select("*").eq("id", id).maybeSingle()) as any;
  if (!report) throw notFound("Vehicle report");
  if (CLOSED.includes(report.status)) throw conflict("This report is closed.");
  return { matches: await recordMatches(req, user, report) };
}

/* -------------------------------------------------------------- reads */

/** Owner contact only for the stations directly involved. */
function present(r: any, user: SessionUser, involvedStations: string[] = []) {
  const { owner_contact_enc, record_digest, ...rest } = r;
  const mine = stationNorm(user.stationOrCourt);
  const mayReadOwner = user.role === "police" && (r.station_norm === mine || involvedStations.includes(mine));
  let ownerContact: string | null = null;
  if (owner_contact_enc && mayReadOwner) {
    try {
      ownerContact = decryptField(owner_contact_enc);
    } catch {
      ownerContact = null;
    }
  }
  return {
    ...rest,
    record_digest,
    owner_contact: ownerContact,
    owner_contact_withheld: Boolean(owner_contact_enc) && !mayReadOwner,
    maps_link: mapsLink(r.latitude, r.longitude),
    allowed_next: allowedNext(r.status),
  };
}

export interface ReportFilters {
  station?: string;
  status?: string;
  type?: string;
  q?: string;
  from?: string;
  to?: string;
  scope?: "mine" | "all";
}

export async function listReports(user: SessionUser, filters: ReportFilters) {
  let query = db.from("vehicle_reports").select("*").order("reported_at", { ascending: false }).limit(500);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.type) query = query.eq("report_type", filters.type);
  if (filters.from) query = query.gte("reported_at", filters.from);
  if (filters.to) query = query.lte("reported_at", filters.to);
  if (filters.scope === "mine") query = query.eq("station_norm", stationNorm(user.stationOrCourt));
  else if (filters.station) query = query.eq("station_norm", stationNorm(filters.station));
  let rows = unwrapList(await query) as any[];
  if (filters.q) {
    const plate = normalisePlate(filters.q);
    const text = textNorm(filters.q);
    rows = rows.filter(
      (r) =>
        (plate && (r.registration_norm ?? "").includes(plate)) ||
        [r.make, r.model, r.colour, r.complaint_ref, r.location_text].some((v) => textNorm(v).includes(text))
    );
  }
  const media = await listMedia("vehicle_trace", rows.map((r) => r.id));
  const firstPhoto = new Map<string, string>();
  for (const m of media) if (!firstPhoto.has(m.subject_id)) firstPhoto.set(m.subject_id, m.id);
  const states = await verificationsFor("vehicle_report", rows.map((r) => r.id));
  return rows.map((r) => ({ ...present(r, user), photo_id: firstPhoto.get(r.id) ?? null, verification: states.get(r.id) ?? null }));
}

export async function getReport(user: SessionUser, id: string) {
  const report = unwrapMaybe(await db.from("vehicle_reports").select("*").eq("id", id).maybeSingle()) as any;
  if (!report) throw notFound("Vehicle report");

  const events = orderChain(unwrapList(await db.from("vehicle_events").select("*").eq("report_id", id).order("occurred_at", { ascending: true })) as any[]);
  const matchRows = unwrapList(
    await db.from("vehicle_matches").select("*").eq(isSought(report.report_type) ? "missing_report_id" : "found_report_id", id).order("score", { ascending: false })
  ) as any[];
  const media = await listMedia("vehicle_trace", [id]);
  const counterpartIds = matchRows.map((m) => (isSought(report.report_type) ? m.found_report_id : m.missing_report_id));
  const counterparts = counterpartIds.length
    ? (unwrapList(await db.from("vehicle_reports").select("*").in("id", counterpartIds)) as any[])
    : [];
  const byId = new Map(counterparts.map((c) => [c.id, c]));
  const verifiedPartner = matchRows.find((m) => m.status === "verified");
  const involved = verifiedPartner ? [byId.get(isSought(report.report_type) ? verifiedPartner.found_report_id : verifiedPartner.missing_report_id)?.station_norm].filter(Boolean) : [];

  const people = unwrapList(
    await db.from("user_directory").select("id, full_name, designation").in("id", [...new Set([report.reported_by, ...events.map((e) => e.actor_id)].filter(Boolean))])
  ) as any[];
  const names = new Map(people.map((p) => [p.id, p.designation ? `${p.full_name}, ${p.designation}` : p.full_name]));

  const states = await verificationsFor("vehicle_report", [id]);
  const eventStates = await verificationsFor("vehicle_event", events.filter((e) => e.anchored).map((e) => e.id));

  return {
    report: { ...present(report, user, involved as string[]), reported_by_name: names.get(report.reported_by) ?? null },
    events: events.map((e) => ({ ...e, actor_name: names.get(e.actor_id) ?? null, verification: eventStates.get(e.id) ?? null })),
    matches: matchRows.map((m) => ({ ...m, counterpart: byId.get(isSought(report.report_type) ? m.found_report_id : m.missing_report_id) ? summary(byId.get(isSought(report.report_type) ? m.found_report_id : m.missing_report_id)) : null })),
    media,
    verification: states.get(id) ?? null,
    integrity: integrityVerdict(reportDigest(report), report.record_digest, await anchoredDigests("vehicle_report", id)),
  };
}

/* ------------------------------------------------------------- actions */

export async function addObservation(req: Request, user: SessionUser, id: string, note: string) {
  const report = unwrapMaybe(await db.from("vehicle_reports").select("id, case_id").eq("id", id).maybeSingle()) as any;
  if (!report) throw notFound("Vehicle report");
  const event = await appendEvent(id, user, { kind: "observation", note });
  await recordAction(req, { action: "vehicle.observation", subject: id, caseId: report.case_id });
  return event;
}

/** Moves the report, and its verified partner with it: a recovery is one process. */
export async function changeStatus(req: Request, user: SessionUser, id: string, to: VehicleStatus, note: string | null) {
  const report = unwrapMaybe(await db.from("vehicle_reports").select("*").eq("id", id).maybeSingle()) as any;
  if (!report) throw notFound("Vehicle report");
  if (!allowedNext(report.status).includes(to)) {
    await recordAction(req, { action: "vehicle.status_refused", subject: id, outcome: "refused", detail: { from: report.status, to } });
    throw new AppError(409, "ILLEGAL_TRANSITION", `A report that is ${report.status.replace(/_/g, " ").toLowerCase()} cannot move to ${to.replace(/_/g, " ").toLowerCase()}.`, {
      allowed: allowedNext(report.status),
    });
  }
  if (NEEDS_REASON.includes(to) && (!note || note.trim().length < 10)) {
    throw badRequest(to === "VEHICLE_RETURNED" ? "Record who received the vehicle and how ownership was verified (at least 10 characters)." : "Give the reason for closing (at least 10 characters).");
  }

  const matchColumn = isSought(report.report_type) ? "missing_report_id" : "found_report_id";
  const verified = unwrapMaybe(await db.from("vehicle_matches").select("*").eq(matchColumn, id).eq("status", "verified").maybeSingle()) as any;
  const partnerId = verified ? (isSought(report.report_type) ? verified.found_report_id : verified.missing_report_id) : null;
  if (partnerId || to !== "CASE_CLOSED") assertInvolved(user, [report.station_norm, ...(partnerId ? [(unwrap(await db.from("vehicle_reports").select("station_norm").eq("id", partnerId).single()) as any).station_norm] : [])]);

  const updated = await setStatus(report, to, user, note);
  if (partnerId) {
    const partner = unwrap(await db.from("vehicle_reports").select("*").eq("id", partnerId).single()) as any;
    if (partner.status === report.status) await setStatus(partner, to, user, note ? `${note} (moved with linked report)` : "Moved with linked report.");
  }

  if (to === "VEHICLE_RETURNED") {
    const sought = isSought(report.report_type) ? report : partnerId ? unwrap(await db.from("vehicle_reports").select("*").eq("id", partnerId).single()) : null;
    if (sought && (sought as any).station_norm !== stationNorm(user.stationOrCourt)) {
      await raiseStationAlert({
        targetStation: (sought as any).station,
        kind: "vehicle_recovered",
        subjectType: "vehicle_report",
        subjectId: (sought as any).id,
        title: `Vehicle returned: ${(sought as any).registration_norm ?? "vehicle"}`,
        dedupeKey: `vehicle_returned:${(sought as any).id}`,
        createdBy: user.id,
        payload: { reportId: (sought as any).id, registration: (sought as any).registration_norm, complaintRef: (sought as any).complaint_ref, returnedBy: user.stationOrCourt, note },
      });
    }
  }
  await recordAction(req, { action: "vehicle.status", subject: id, caseId: report.case_id, detail: { from: report.status, to, partner: partnerId } });
  return present(updated, user);
}

function assertInvolved(user: SessionUser, stations: string[]) {
  if (!stations.includes(stationNorm(user.stationOrCourt))) {
    throw forbidden("Only officers of the stations holding these reports can move them forward.");
  }
}

export async function decideMatch(req: Request, user: SessionUser, matchId: string, decision: "verified" | "rejected", note: string) {
  const match = unwrapMaybe(await db.from("vehicle_matches").select("*").eq("id", matchId).maybeSingle()) as any;
  if (!match) throw notFound("Match");
  if (match.status !== "pending") throw conflict(`This match was already ${match.status}.`);
  const [sought, sighted] = await Promise.all([
    unwrap(await db.from("vehicle_reports").select("*").eq("id", match.missing_report_id).single()) as any,
    unwrap(await db.from("vehicle_reports").select("*").eq("id", match.found_report_id).single()) as any,
  ]);
  assertInvolved(user, [sought.station_norm, sighted.station_norm]);

  if (decision === "verified") {
    for (const report of [sought, sighted]) {
      if (!["POTENTIAL_MATCH", "VERIFICATION_PENDING"].includes(report.status)) {
        throw conflict(`Report ${report.id} is ${report.status.replace(/_/g, " ").toLowerCase()} and cannot be matched now.`);
      }
    }
  }

  const decidedAt = new Date().toISOString();
  await db.from("vehicle_matches").update({ status: decision, decided_by: user.id, decided_at: decidedAt, decision_note: note }).eq("id", matchId);

  if (decision === "verified") {
    for (const report of [sought, sighted]) await setStatus(report, "MATCH_VERIFIED", user, `Match verified: ${note}`);
    // Anything else either report was paired with is now moot.
    const others = unwrapList(await db.from("vehicle_matches").select("*").eq("status", "pending")) as any[];
    for (const other of others.filter((o) => o.missing_report_id === sought.id || o.found_report_id === sighted.id)) {
      await db.from("vehicle_matches").update({ status: "rejected", decided_by: user.id, decided_at: decidedAt, decision_note: "Superseded: the report was verified against another record." }).eq("id", other.id);
      await revertIfUnmatched(user, other.missing_report_id === sought.id ? other.found_report_id : other.missing_report_id);
    }
  } else {
    await revertIfUnmatched(user, sought.id);
    await revertIfUnmatched(user, sighted.id);
  }

  await db.from("station_alerts").update({ status: "actioned" }).eq("subject_id", matchId);
  await recordAction(req, { action: `vehicle.match_${decision}`, subject: matchId, detail: { sought: sought.id, sighted: sighted.id } });
  return unwrap(await db.from("vehicle_matches").select("*").eq("id", matchId).single());
}

/** Back to the starting status once nothing is left pending or verified for a report. */
async function revertIfUnmatched(user: SessionUser, reportId: string) {
  const report = unwrap(await db.from("vehicle_reports").select("*").eq("id", reportId).single()) as any;
  if (!["POTENTIAL_MATCH", "VERIFICATION_PENDING"].includes(report.status)) return;
  const column = isSought(report.report_type) ? "missing_report_id" : "found_report_id";
  const live = unwrapList(await db.from("vehicle_matches").select("id, status").eq(column, reportId)) as any[];
  if (live.some((m) => m.status !== "rejected")) return;
  await setStatus(report, isSought(report.report_type) ? "MISSING_REPORTED" : "VEHICLE_FOUND", user, "Every possible match was rejected.");
}

/* ---------------------------------------------------------- dashboards */

export async function listMatches(user: SessionUser, status?: string) {
  let query = db.from("vehicle_matches").select("*").order("created_at", { ascending: false }).limit(300);
  if (status) query = query.eq("status", status);
  const matches = unwrapList(await query) as any[];
  const ids = [...new Set(matches.flatMap((m) => [m.missing_report_id, m.found_report_id]))];
  const reports = ids.length ? (unwrapList(await db.from("vehicle_reports").select("*").in("id", ids)) as any[]) : [];
  const byId = new Map(reports.map((r) => [r.id, r]));
  const mine = stationNorm(user.stationOrCourt);
  return matches.map((m) => {
    const sought = byId.get(m.missing_report_id);
    const sighted = byId.get(m.found_report_id);
    return {
      ...m,
      sought: sought ? summary(sought) : null,
      sighted: sighted ? summary(sighted) : null,
      involves_my_station: [sought?.station_norm, sighted?.station_norm].includes(mine),
    };
  });
}

export async function vehicleStats() {
  const rows = unwrapList(await db.from("vehicle_reports").select("report_type, status, station, reported_at, registration_source").limit(5000)) as any[];
  const matches = unwrapList(await db.from("vehicle_matches").select("status, match_type").limit(5000)) as any[];
  const count = <T extends string>(values: T[]) => values.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});
  const sought = rows.filter((r) => isSought(r.report_type));
  const recovered = sought.filter((r) => CLOSED.includes(r.status) || ["RECOVERY_IN_PROGRESS", "OWNER_VERIFICATION_PENDING"].includes(r.status)).length;
  return {
    total: rows.length,
    stillSought: sought.filter((r) => ["MISSING_REPORTED", "POTENTIAL_MATCH", "VERIFICATION_PENDING"].includes(r.status)).length,
    byType: count(rows.map((r) => r.report_type)),
    byStatus: count(rows.map((r) => r.status)),
    byStation: count(rows.map((r) => r.station)),
    anprShare: rows.length ? round3(rows.filter((r) => String(r.registration_source).startsWith("anpr")).length / rows.length) : 0,
    matches: { total: matches.length, byStatus: count(matches.map((m) => m.status)), byType: count(matches.map((m) => m.match_type)) },
    recoveryRate: sought.length ? round3(recovered / sought.length) : 0,
  };
}

/** A quick check before filing: is this plate sought anywhere? */
export async function plateCheck(registration: string) {
  const plate = normalisePlate(registration);
  if (!plate) throw badRequest("Enter at least four letters or digits.");
  const sought = unwrapList(await db.from("vehicle_reports").select("*").in("report_type", SOUGHT).limit(2000)) as any[];
  const hits = sought
    .filter((r) => !CLOSED.includes(r.status))
    .map((r) => ({ report: summary(r), comparison: comparePlates(plate, r.registration_norm) }))
    .filter((h) => h.comparison.kind !== "none")
    .sort((a, b) => b.comparison.score - a.comparison.score)
    .slice(0, 10);
  return { plate, shape: plateShape(plate), hits };
}
