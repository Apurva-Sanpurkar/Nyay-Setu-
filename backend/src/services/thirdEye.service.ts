import { randomUUID } from "crypto";
import { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { badRequest, conflict, notFound } from "../lib/errors";
import { canonicalHash } from "../lib/crypto";
import { hammingHex, jaccard, keywords, nameSimilarity, round3, shared, stationNorm, textNorm } from "../lib/similarity";
import { recordAction } from "./audit";
import type { SessionUser } from "../middleware/auth";
import { anchorRecord, anchoredDigests, integrityVerdict, orderChain, verificationsFor } from "./smart/recordAnchor";
import { listMedia } from "./smart/media.service";
import { raiseStationAlert } from "./smart/stationAlerts.service";

/**
 * Third Eye: criminal intelligence records and case linking.
 *
 * What it does: keeps a record per person (suspect, accused, convicted) with
 * their case history across stations, and raises LEADS — possible duplicate
 * records, the same photograph uploaded against two records, cases with a
 * similar modus operandi — for an officer to confirm or reject with a reason.
 *
 * What it does not do: recognise faces, compare sketches to photographs, or
 * label anyone. Image matching here is a perceptual hash, which finds the SAME
 * picture (a re-uploaded photo, the same CCTV still), not the same face in two
 * different pictures. Face matching is deliberately absent until a validated
 * method and legal authorisation exist; see docs/SMART_POLICING.md.
 */

export const CLASSIFICATIONS = ["person_of_interest", "suspect", "accused", "convicted"] as const;
export const OFFENCE_CATEGORIES = [
  "theft", "robbery", "burglary", "chain_snatching", "vehicle_theft", "cheating_fraud",
  "cyber_crime", "assault", "murder", "kidnapping", "sexual_offence", "narcotics", "other",
] as const;
export const INVOLVEMENTS = ["suspect", "accused", "convicted", "acquitted", "discharged"] as const;
export const INVESTIGATION_STATUSES = ["under_investigation", "chargesheeted", "on_trial", "convicted", "acquitted", "closed"] as const;
export const ARREST_STATUSES = ["not_arrested", "arrested", "on_bail", "absconding", "in_custody"] as const;

export const DISCLAIMER =
  "Third Eye results are investigative leads, not identifications. A similarity score is not evidence of identity " +
  "or guilt and must not by itself be the basis of an arrest or any other action. Every lead must be verified by " +
  "an authorised investigator through independent inquiry.";

/** Hamming distance at or under which two images are treated as the same picture. */
const SAME_IMAGE_BITS = 10;

export interface PersonInput {
  fullName: string;
  aliases?: string[];
  gender?: "male" | "female" | "transgender" | "unknown" | null;
  dateOfBirth?: string | null;
  ageEstimate?: number | null;
  heightCm?: number | null;
  build?: string | null;
  complexion?: string | null;
  identifyingMarks?: string | null;
  physicalDescription?: string | null;
  classification: (typeof CLASSIFICATIONS)[number];
}

export interface CaseLinkInput {
  firNumber: string;
  caseId?: string | null;
  policeStation: string;
  offence: string;
  offenceCategory: (typeof OFFENCE_CATEGORIES)[number];
  modusOperandi?: string | null;
  crimeDate?: string | null;
  crimeLocation?: string | null;
  involvement: (typeof INVOLVEMENTS)[number];
  investigationStatus: (typeof INVESTIGATION_STATUSES)[number];
  arrestStatus?: (typeof ARREST_STATUSES)[number] | null;
  courtStatus?: string | null;
  investigatingOfficer?: string | null;
}

/* ------------------------------------------------------------- digests */

function personDigest(p: any): string {
  return canonicalHash({
    id: p.id,
    fullName: p.full_name,
    aliases: [...(p.aliases ?? [])].sort(),
    gender: p.gender ?? null,
    dateOfBirth: p.date_of_birth ?? null,
    ageEstimate: p.age_estimate ?? null,
    heightCm: p.height_cm ?? null,
    build: p.build ?? null,
    complexion: p.complexion ?? null,
    identifyingMarks: p.identifying_marks ?? null,
    physicalDescription: p.physical_description ?? null,
    classification: p.classification,
    homeStation: p.home_station,
    recordStatus: p.record_status ?? "active",
  });
}

function linkDigest(l: any): string {
  return canonicalHash({
    id: l.id,
    personId: l.person_id,
    firNumber: l.fir_number,
    caseId: l.case_id ?? null,
    policeStation: l.police_station,
    offence: l.offence,
    offenceCategory: l.offence_category,
    modusOperandi: l.modus_operandi ?? null,
    crimeDate: l.crime_date ?? null,
    crimeLocation: l.crime_location ?? null,
    involvement: l.involvement,
    investigationStatus: l.investigation_status,
    arrestStatus: l.arrest_status ?? null,
    courtStatus: l.court_status ?? null,
    investigatingOfficer: l.investigating_officer ?? null,
  });
}

/* ------------------------------------------------------------ timeline */

async function appendEvent(personId: string, user: SessionUser, kind: string, detail: Record<string, unknown>) {
  const last = orderChain(
    unwrapList(await db.from("ti_events").select("event_digest, previous_digest").eq("person_id", personId)) as { event_digest: string; previous_digest: string | null }[]
  ).at(-1);
  const occurredAt = new Date().toISOString();
  const digest = canonicalHash({ personId, kind, detail, actor: user.id, occurredAt, previous: last?.event_digest ?? null });
  await db.from("ti_events").insert({
    person_id: personId,
    kind,
    detail,
    actor_id: user.id,
    actor_station: user.stationOrCourt,
    occurred_at: occurredAt,
    event_digest: digest,
    previous_digest: last?.event_digest ?? null,
  });
}

async function anchor(user: SessionUser, personId: string, subjectType: string, subjectId: string, digest: string) {
  const { anchor } = await anchorRecord({
    module: "third_eye",
    recordId: personId,
    digest,
    subjectType,
    subjectId,
    idempotencyKey: `${subjectType}:${subjectId}:${digest.slice(2, 18)}`,
    actor: { id: user.id, role: user.role },
  });
  return { state: anchor.state, txHash: anchor.tx_hash };
}

/* --------------------------------------------------------------- leads */

/** Leads are stored with the smaller id first so a pair is only ever one row. */
async function raiseLead(user: SessionUser, kind: "possible_duplicate" | "image_similarity" | "related_cases", subjectType: "person" | "case_link", a: string, b: string, score: number, reasons: string[]) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const existing = unwrapMaybe(await db.from("ti_leads").select("id").eq("kind", kind).eq("subject_a", x).eq("subject_b", y).maybeSingle());
  if (existing) return null;
  return unwrap(
    await db
      .from("ti_leads")
      .insert({ kind, subject_type: subjectType, subject_a: x, subject_b: y, score: round3(score), reasons, status: "pending", raised_by: user.id })
      .select("*")
      .single()
  ) as any;
}

function ageAt(p: any): number | null {
  if (p.date_of_birth) return Math.floor((Date.now() - new Date(p.date_of_birth).getTime()) / (365.25 * 86400_000));
  return p.age_estimate ?? null;
}

/** Possible duplicates of one person: similar names or aliases, compatible age and gender. */
export function duplicateScore(a: any, b: any): { score: number; reasons: string[] } | null {
  const namesA = [a.full_name, ...(a.aliases ?? [])];
  const namesB = [b.full_name, ...(b.aliases ?? [])];
  let best = 0;
  let pair: [string, string] = ["", ""];
  for (const x of namesA) for (const y of namesB) {
    const s = nameSimilarity(x, y);
    if (s > best) {
      best = s;
      pair = [x, y];
    }
  }
  if (best < 0.8) return null;
  const reasons = [best === 1 ? `Same name or alias: "${pair[0]}"` : `Similar names: "${pair[0]}" / "${pair[1]}" (${Math.round(best * 100)}%)`];
  let score = best * 0.7;

  if (a.date_of_birth && b.date_of_birth) {
    if (a.date_of_birth === b.date_of_birth) {
      score += 0.25;
      reasons.push("Same date of birth");
    } else {
      score -= 0.3;
      reasons.push("Different dates of birth");
    }
  } else {
    const ageA = ageAt(a);
    const ageB = ageAt(b);
    if (ageA !== null && ageB !== null) {
      if (Math.abs(ageA - ageB) <= 5) {
        score += 0.1;
        reasons.push(`Compatible ages (${ageA} / ${ageB})`);
      } else {
        score -= 0.2;
        reasons.push(`Ages differ (${ageA} / ${ageB})`);
      }
    }
  }
  if (a.gender && b.gender && a.gender !== "unknown" && b.gender !== "unknown" && a.gender !== b.gender) {
    score -= 0.4;
    reasons.push("Recorded gender differs");
  }
  const marks = shared(keywords(a.identifying_marks), keywords(b.identifying_marks));
  if (marks.length) {
    score += 0.05;
    reasons.push(`Identifying marks share: ${marks.slice(0, 4).join(", ")}`);
  }
  score = Math.min(1, Math.max(0, score));
  return score >= 0.55 ? { score, reasons } : null;
}

async function duplicateLeads(user: SessionUser, person: any) {
  const others = unwrapList(await db.from("ti_persons").select("*").eq("record_status", "active").limit(5000)) as any[];
  const leads = [];
  for (const other of others) {
    if (other.id === person.id) continue;
    const result = duplicateScore(person, other);
    if (!result) continue;
    const lead = await raiseLead(user, "possible_duplicate", "person", person.id, other.id, result.score, result.reasons);
    if (lead) leads.push(lead);
  }
  return leads;
}

/** Related cases: same offence category with a similar modus operandi. */
export function caseSimilarity(a: any, b: any): { score: number; reasons: string[] } | null {
  if (a.offence_category !== b.offence_category) return null;
  const mo = jaccard(keywords(a.modus_operandi), keywords(b.modus_operandi));
  const common = shared(keywords(a.modus_operandi), keywords(b.modus_operandi));
  const reasons = [`Same offence category: ${a.offence_category.replace(/_/g, " ")}`];
  if (common.length) reasons.push(`Modus operandi shares: ${common.slice(0, 6).join(", ")}`);
  let score = 0.3 + mo * 0.6;
  if (a.person_id === b.person_id) {
    score += 0.2;
    reasons.push("Same person record");
  }
  if (stationNorm(a.police_station) !== stationNorm(b.police_station)) reasons.push(`Different stations: ${a.police_station} / ${b.police_station}`);
  score = Math.min(1, score);
  return mo >= 0.25 || (a.person_id === b.person_id && mo >= 0.1) ? { score, reasons } : null;
}

async function relatedCaseLeads(user: SessionUser, link: any) {
  const others = unwrapList(await db.from("ti_case_links").select("*").eq("offence_category", link.offence_category).limit(5000)) as any[];
  const leads = [];
  for (const other of others) {
    if (other.id === link.id || other.fir_number === link.fir_number) continue;
    const result = caseSimilarity(link, other);
    if (!result) continue;
    const lead = await raiseLead(user, "related_cases", "case_link", link.id, other.id, result.score, result.reasons);
    if (lead) leads.push(lead);
  }
  return leads;
}

/* -------------------------------------------------------------- writes */

export async function createPerson(req: Request, user: SessionUser, input: PersonInput) {
  if (!user.stationOrCourt) throw badRequest("Your account has no police station recorded.");
  const draft = {
    id: randomUUID(),
    full_name: input.fullName,
    name_norm: textNorm(input.fullName),
    aliases: (input.aliases ?? []).filter(Boolean),
    gender: input.gender ?? null,
    date_of_birth: input.dateOfBirth ?? null,
    age_estimate: input.ageEstimate ?? null,
    height_cm: input.heightCm ?? null,
    build: input.build ?? null,
    complexion: input.complexion ?? null,
    identifying_marks: input.identifyingMarks ?? null,
    physical_description: input.physicalDescription ?? null,
    classification: input.classification,
    home_station: user.stationOrCourt,
    record_status: "active",
    created_by: user.id,
  };
  const person = unwrap(await db.from("ti_persons").insert({ ...draft, record_digest: personDigest(draft) }).select("*").single()) as any;
  await appendEvent(person.id, user, "created", { classification: person.classification });
  const verification = await anchor(user, person.id, "ti_person", person.id, person.record_digest);
  const leads = await duplicateLeads(user, person);
  await recordAction(req, { action: "third_eye.person_create", subject: person.id, detail: { classification: person.classification, leads: leads.length } });
  return { person, leads, verification, disclaimer: DISCLAIMER };
}

const PERSON_FIELDS: Record<string, string> = {
  fullName: "full_name",
  aliases: "aliases",
  gender: "gender",
  dateOfBirth: "date_of_birth",
  ageEstimate: "age_estimate",
  heightCm: "height_cm",
  build: "build",
  complexion: "complexion",
  identifyingMarks: "identifying_marks",
  physicalDescription: "physical_description",
  classification: "classification",
  recordStatus: "record_status",
};

export async function updatePerson(req: Request, user: SessionUser, id: string, patch: Partial<PersonInput> & { recordStatus?: "active" | "archived" }, reason: string) {
  const person = unwrapMaybe(await db.from("ti_persons").select("*").eq("id", id).maybeSingle()) as any;
  if (!person) throw notFound("Person record");
  const changes: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(PERSON_FIELDS)) {
    const value = (patch as any)[key];
    if (value !== undefined && JSON.stringify(value) !== JSON.stringify(person[column])) changes[column] = value;
  }
  if (Object.keys(changes).length === 0) throw badRequest("Nothing to change.");
  if (changes.full_name) changes.name_norm = textNorm(String(changes.full_name));
  const next = { ...person, ...changes };
  const digest = personDigest(next);
  const updated = unwrap(await db.from("ti_persons").update({ ...changes, record_digest: digest }).eq("id", id).select("*").single()) as any;

  await appendEvent(id, user, "updated", {
    fields: Object.keys(changes).filter((c) => c !== "name_norm"),
    reason,
    ...(changes.classification ? { classification: { from: person.classification, to: changes.classification } } : {}),
  });
  const verification = await anchor(user, id, "ti_person", id, digest);
  const leads = changes.full_name || changes.aliases || changes.date_of_birth ? await duplicateLeads(user, updated) : [];
  await recordAction(req, { action: "third_eye.person_update", subject: id, detail: { fields: Object.keys(changes), reason } });
  return { person: updated, leads, verification };
}

export async function addCaseLink(req: Request, user: SessionUser, personId: string, input: CaseLinkInput) {
  const person = unwrapMaybe(await db.from("ti_persons").select("id").eq("id", personId).maybeSingle());
  if (!person) throw notFound("Person record");
  const duplicate = unwrapMaybe(
    await db.from("ti_case_links").select("id").eq("person_id", personId).eq("fir_number", input.firNumber).eq("station_norm", stationNorm(input.policeStation)).maybeSingle()
  );
  if (duplicate) throw conflict("This FIR is already linked to this person.");

  const draft = {
    id: randomUUID(),
    person_id: personId,
    fir_number: input.firNumber,
    case_id: input.caseId ?? null,
    police_station: input.policeStation,
    station_norm: stationNorm(input.policeStation),
    offence: input.offence,
    offence_category: input.offenceCategory,
    modus_operandi: input.modusOperandi ?? null,
    crime_date: input.crimeDate ?? null,
    crime_location: input.crimeLocation ?? null,
    involvement: input.involvement,
    investigation_status: input.investigationStatus,
    arrest_status: input.arrestStatus ?? null,
    court_status: input.courtStatus ?? null,
    investigating_officer: input.investigatingOfficer ?? null,
    created_by: user.id,
  };
  const link = unwrap(await db.from("ti_case_links").insert({ ...draft, record_digest: linkDigest(draft) }).select("*").single()) as any;
  await appendEvent(personId, user, "case_linked", { firNumber: input.firNumber, station: input.policeStation, involvement: input.involvement });
  const verification = await anchor(user, personId, "ti_case_link", link.id, link.record_digest);
  const leads = await relatedCaseLeads(user, link);
  await recordAction(req, { action: "third_eye.case_link", subject: personId, caseId: input.caseId ?? null, detail: { fir: input.firNumber, leads: leads.length } });
  return { link, leads, verification, disclaimer: DISCLAIMER };
}

export async function updateCaseLink(req: Request, user: SessionUser, linkId: string, patch: Partial<Pick<CaseLinkInput, "investigationStatus" | "arrestStatus" | "courtStatus" | "involvement" | "investigatingOfficer">>, reason: string) {
  const link = unwrapMaybe(await db.from("ti_case_links").select("*").eq("id", linkId).maybeSingle()) as any;
  if (!link) throw notFound("Case link");
  const columns: Record<string, string> = { investigationStatus: "investigation_status", arrestStatus: "arrest_status", courtStatus: "court_status", involvement: "involvement", investigatingOfficer: "investigating_officer" };
  const changes: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(columns)) {
    const value = (patch as any)[key];
    if (value !== undefined && value !== link[column]) changes[column] = value;
  }
  if (Object.keys(changes).length === 0) throw badRequest("Nothing to change.");
  const digest = linkDigest({ ...link, ...changes });
  const updated = unwrap(await db.from("ti_case_links").update({ ...changes, record_digest: digest }).eq("id", linkId).select("*").single()) as any;
  await appendEvent(link.person_id, user, "updated", { caseLink: linkId, fir: link.fir_number, fields: Object.keys(changes), reason });
  const verification = await anchor(user, link.person_id, "ti_case_link", linkId, digest);
  await recordAction(req, { action: "third_eye.case_link_update", subject: linkId, detail: { fields: Object.keys(changes), reason } });
  return { link: updated, verification };
}

/** After a photo is stored: is the same picture already on another record? */
export async function imageLeadsFor(req: Request, user: SessionUser, personId: string, media: { id: string; perceptual_hash: string | null; kind: string }) {
  await appendEvent(personId, user, "media_added", { mediaId: media.id, kind: media.kind });
  if (!media.perceptual_hash || media.kind === "sketch") return [];
  const others = unwrapList(await db.from("secure_media").select("id, subject_id, kind, perceptual_hash").eq("module", "third_eye").neq("subject_id", personId).limit(10000)) as any[];
  const leads = [];
  for (const other of others) {
    if (!other.perceptual_hash || other.kind === "sketch") continue;
    const distance = hammingHex(media.perceptual_hash, other.perceptual_hash);
    if (distance > SAME_IMAGE_BITS) continue;
    const lead = await raiseLead(user, "image_similarity", "person", personId, other.subject_id, 1 - distance / 64, [
      `Near-identical image (${distance} of 64 bits differ): probably the same photograph or CCTV still uploaded against both records`,
      "This compares pictures, not faces. Different photographs of one person will not match, and it is not a facial identification.",
    ]);
    if (lead) leads.push(lead);
  }
  await recordAction(req, { action: "third_eye.media", subject: personId, detail: { mediaId: media.id, leads: leads.length } });
  return leads;
}

export async function reviewLead(req: Request, user: SessionUser, id: string, decision: "confirmed" | "rejected", note: string) {
  const lead = unwrapMaybe(await db.from("ti_leads").select("*").eq("id", id).maybeSingle()) as any;
  if (!lead) throw notFound("Lead");
  if (lead.status !== "pending") throw conflict(`This lead was already ${lead.status}.`);
  const updated = unwrap(
    await db.from("ti_leads").update({ status: decision, reviewed_by: user.id, reviewed_at: new Date().toISOString(), review_note: note }).eq("id", id).select("*").single()
  ) as any;

  const personIds =
    lead.subject_type === "person"
      ? [lead.subject_a, lead.subject_b]
      : (unwrapList(await db.from("ti_case_links").select("person_id").in("id", [lead.subject_a, lead.subject_b])) as any[]).map((l) => l.person_id);
  for (const personId of [...new Set(personIds)]) await appendEvent(personId, user, "lead_reviewed", { leadId: id, kind: lead.kind, decision, note });

  if (decision === "confirmed" && lead.kind === "related_cases") {
    const links = unwrapList(await db.from("ti_case_links").select("*").in("id", [lead.subject_a, lead.subject_b])) as any[];
    for (const link of links) {
      const other = links.find((l) => l.id !== link.id);
      if (!other || stationNorm(link.police_station) === stationNorm(user.stationOrCourt)) continue;
      await raiseStationAlert({
        targetStation: link.police_station,
        kind: "third_eye_link",
        subjectType: "ti_lead",
        subjectId: id,
        title: `Possible link between FIR ${link.fir_number} and FIR ${other.fir_number} (${other.police_station})`,
        dedupeKey: `ti_lead:${id}:${stationNorm(link.police_station)}`,
        createdBy: user.id,
        payload: { leadId: id, yourFir: link.fir_number, otherFir: other.fir_number, otherStation: other.police_station, reasons: lead.reasons, reviewNote: note, confirmedBy: user.stationOrCourt },
      });
    }
  }
  await recordAction(req, { action: `third_eye.lead_${decision}`, subject: id, detail: { kind: lead.kind } });
  return updated;
}

/* --------------------------------------------------------------- reads */

export interface SearchInput {
  purpose: string;
  name?: string;
  fir?: string;
  offenceCategory?: string;
  station?: string;
  modusOperandi?: string;
  marks?: string;
  classification?: string;
}

/**
 * Searches person records. Every search states its purpose, which is written
 * to the audit trail with the criteria: a database of suspects is only
 * defensible if its every use can be accounted for.
 */
export async function search(req: Request, input: SearchInput) {
  const persons = unwrapList(await db.from("ti_persons").select("*").eq("record_status", "active").limit(5000)) as any[];
  const links = unwrapList(await db.from("ti_case_links").select("*").limit(10000)) as any[];
  const linksByPerson = new Map<string, any[]>();
  for (const l of links) linksByPerson.set(l.person_id, [...(linksByPerson.get(l.person_id) ?? []), l]);

  const moQuery = keywords(input.modusOperandi);
  const marksQuery = keywords(input.marks);
  const results = [];
  for (const p of persons) {
    if (input.classification && p.classification !== input.classification) continue;
    const pl = linksByPerson.get(p.id) ?? [];
    const reasons: string[] = [];
    let score = 0;
    let criteria = 0;

    if (input.name) {
      criteria++;
      const best = Math.max(...[p.full_name, ...(p.aliases ?? [])].map((n: string) => nameSimilarity(n, input.name!)));
      const contains = [p.full_name, ...(p.aliases ?? [])].some((n: string) => textNorm(n).includes(textNorm(input.name)));
      const s = contains ? Math.max(best, 0.85) : best;
      if (s < 0.6) continue;
      score += s;
      reasons.push(`Name ${Math.round(s * 100)}% similar`);
    }
    if (input.fir) {
      criteria++;
      const hit = pl.find((l) => textNorm(l.fir_number).includes(textNorm(input.fir)));
      if (!hit) continue;
      score += 1;
      reasons.push(`Linked to FIR ${hit.fir_number}`);
    }
    if (input.offenceCategory) {
      criteria++;
      const hits = pl.filter((l) => l.offence_category === input.offenceCategory);
      if (!hits.length) continue;
      score += 1;
      reasons.push(`${hits.length} case(s) of ${input.offenceCategory.replace(/_/g, " ")}`);
    }
    if (input.station) {
      criteria++;
      const target = stationNorm(input.station);
      const hits = pl.filter((l) => l.station_norm.includes(target));
      if (!hits.length && !stationNorm(p.home_station).includes(target)) continue;
      score += 1;
      reasons.push(`Associated with ${input.station}`);
    }
    if (moQuery.size) {
      criteria++;
      const best = Math.max(0, ...pl.map((l) => jaccard(moQuery, keywords(l.modus_operandi))));
      if (best < 0.15) continue;
      score += best;
      const words = new Set(pl.flatMap((l) => shared(moQuery, keywords(l.modus_operandi))));
      reasons.push(`Modus operandi shares: ${[...words].slice(0, 5).join(", ")}`);
    }
    if (marksQuery.size) {
      criteria++;
      const words = shared(marksQuery, keywords(`${p.identifying_marks ?? ""} ${p.physical_description ?? ""}`));
      if (!words.length) continue;
      score += words.length / marksQuery.size;
      reasons.push(`Description shares: ${words.join(", ")}`);
    }
    if (criteria === 0 && !input.classification) continue;
    results.push({
      person: p,
      score: round3(criteria ? score / criteria : 1),
      reasons,
      caseCount: pl.length,
      stations: [...new Set(pl.map((l) => l.police_station))],
    });
  }
  results.sort((a, b) => b.score - a.score);
  const photos = await listMedia("third_eye", results.slice(0, 50).map((r) => r.person.id));
  const firstPhoto = new Map<string, string>();
  for (const m of photos) if (m.kind !== "sketch" && !firstPhoto.has(m.subject_id)) firstPhoto.set(m.subject_id, m.id);

  await recordAction(req, {
    action: "third_eye.search",
    detail: { purpose: input.purpose, criteria: { ...input, purpose: undefined }, results: results.length },
  });
  return { results: results.slice(0, 50).map((r) => ({ ...r, photo_id: firstPhoto.get(r.person.id) ?? null })), disclaimer: DISCLAIMER };
}

/** Image search: compares the probe's perceptual hash with stored photos. The probe itself is not kept. */
export async function searchByImage(req: Request, perceptualHash: string, purpose: string) {
  const media = unwrapList(await db.from("secure_media").select("id, subject_id, kind, perceptual_hash").eq("module", "third_eye").limit(10000)) as any[];
  const best = new Map<string, { distance: number; mediaId: string }>();
  for (const m of media) {
    if (!m.perceptual_hash || m.kind === "sketch") continue;
    const distance = hammingHex(perceptualHash, m.perceptual_hash);
    if (distance > SAME_IMAGE_BITS) continue;
    const current = best.get(m.subject_id);
    if (!current || distance < current.distance) best.set(m.subject_id, { distance, mediaId: m.id });
  }
  const ids = [...best.keys()];
  const persons = ids.length ? (unwrapList(await db.from("ti_persons").select("*").in("id", ids)) as any[]) : [];
  await recordAction(req, { action: "third_eye.image_search", detail: { purpose, results: persons.length } });
  return {
    results: persons
      .map((p) => {
        const hit = best.get(p.id)!;
        return {
          person: p,
          score: round3(1 - hit.distance / 64),
          reasons: [`Near-identical image (${hit.distance} of 64 bits differ). This finds the same picture, not the same face.`],
          photo_id: hit.mediaId,
        };
      })
      .sort((a, b) => b.score - a.score),
    disclaimer: DISCLAIMER,
  };
}

export async function getPerson(req: Request, id: string, purpose: string | null) {
  const person = unwrapMaybe(await db.from("ti_persons").select("*").eq("id", id).maybeSingle()) as any;
  if (!person) throw notFound("Person record");
  const links = unwrapList(await db.from("ti_case_links").select("*").eq("person_id", id).order("crime_date", { ascending: false })) as any[];
  const events = orderChain(unwrapList(await db.from("ti_events").select("*").eq("person_id", id).order("occurred_at", { ascending: true })) as any[]);
  const media = await listMedia("third_eye", [id]);

  const linkIds = links.map((l) => l.id);
  const leadRows = [
    ...(unwrapList(await db.from("ti_leads").select("*").eq("subject_a", id)) as any[]),
    ...(unwrapList(await db.from("ti_leads").select("*").eq("subject_b", id)) as any[]),
    ...(linkIds.length ? (unwrapList(await db.from("ti_leads").select("*").in("subject_a", linkIds)) as any[]) : []),
    ...(linkIds.length ? (unwrapList(await db.from("ti_leads").select("*").in("subject_b", linkIds)) as any[]) : []),
  ];
  const leads = await describeLeads([...new Map(leadRows.map((l) => [l.id, l])).values()]);

  const actors = [...new Set(events.map((e) => e.actor_id).filter(Boolean))];
  const people = actors.length ? (unwrapList(await db.from("user_directory").select("id, full_name, designation").in("id", actors)) as any[]) : [];
  const names = new Map(people.map((p) => [p.id, p.designation ? `${p.full_name}, ${p.designation}` : p.full_name]));

  const states = await verificationsFor("ti_person", [id]);
  const linkStates = await verificationsFor("ti_case_link", linkIds);
  const linkIntegrity = await Promise.all(
    links.map(async (l) => [l.id, integrityVerdict(linkDigest(l), l.record_digest, await anchoredDigests("ti_case_link", l.id))] as const)
  );
  const integrityById = new Map(linkIntegrity);

  await recordAction(req, { action: "third_eye.view", subject: id, detail: { purpose } });
  return {
    person,
    caseLinks: links.map((l) => ({ ...l, verification: linkStates.get(l.id) ?? null, integrity: integrityById.get(l.id) })),
    media,
    leads,
    events: events.map((e) => ({ ...e, actor_name: names.get(e.actor_id) ?? null })),
    verification: states.get(id) ?? null,
    integrity: integrityVerdict(personDigest(person), person.record_digest, await anchoredDigests("ti_person", id)),
    disclaimer: DISCLAIMER,
  };
}

/** Puts names on both sides of each lead so a reviewer can see what is being compared. */
async function describeLeads(leads: any[]) {
  if (!leads.length) return [];
  const personIds = leads.filter((l) => l.subject_type === "person").flatMap((l) => [l.subject_a, l.subject_b]);
  const linkIds = leads.filter((l) => l.subject_type === "case_link").flatMap((l) => [l.subject_a, l.subject_b]);
  const links = linkIds.length ? (unwrapList(await db.from("ti_case_links").select("*").in("id", linkIds)) as any[]) : [];
  const persons = unwrapList(await db.from("ti_persons").select("id, full_name, classification, home_station").in("id", [...new Set([...personIds, ...links.map((l) => l.person_id)])])) as any[];
  const personById = new Map(persons.map((p) => [p.id, p]));
  const linkById = new Map(links.map((l) => [l.id, l]));
  const side = (lead: any, id: string) => {
    if (lead.subject_type === "person") return { person: personById.get(id) ?? null, caseLink: null };
    const link = linkById.get(id);
    return {
      person: link ? personById.get(link.person_id) ?? null : null,
      caseLink: link
        ? { id: link.id, fir_number: link.fir_number, police_station: link.police_station, offence: link.offence, crime_date: link.crime_date, modus_operandi: link.modus_operandi }
        : null,
    };
  };
  return leads
    .sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1) || b.score - a.score)
    .map((l) => ({ ...l, a: side(l, l.subject_a), b: side(l, l.subject_b) }));
}

export async function listLeads(status?: string) {
  let query = db.from("ti_leads").select("*").order("created_at", { ascending: false }).limit(300);
  if (status) query = query.eq("status", status);
  return describeLeads(unwrapList(await query) as any[]);
}

/** People with cases at more than one station or more than one case: the cross-case view. */
export async function repeatOffenders() {
  const persons = unwrapList(await db.from("ti_persons").select("*").eq("record_status", "active").limit(5000)) as any[];
  const links = unwrapList(await db.from("ti_case_links").select("*").limit(10000)) as any[];
  const byPerson = new Map<string, any[]>();
  for (const l of links) byPerson.set(l.person_id, [...(byPerson.get(l.person_id) ?? []), l]);
  return persons
    .map((p) => {
      const pl = byPerson.get(p.id) ?? [];
      return {
        person: p,
        caseCount: pl.length,
        stations: [...new Set(pl.map((l) => l.police_station))],
        categories: [...new Set(pl.map((l) => l.offence_category))],
        open: pl.filter((l) => ["under_investigation", "chargesheeted", "on_trial"].includes(l.investigation_status)).length,
        latest: pl.map((l) => l.crime_date).filter(Boolean).sort().at(-1) ?? null,
      };
    })
    .filter((r) => r.caseCount >= 2)
    .sort((a, b) => b.stations.length - a.stations.length || b.caseCount - a.caseCount);
}

/** Cases that share an offence category and modus operandi across stations, whether or not anyone is linked. */
export async function crossCaseLinks() {
  return listLeads().then((leads) => leads.filter((l) => l.kind === "related_cases"));
}

export async function thirdEyeStats() {
  const persons = unwrapList(await db.from("ti_persons").select("classification, record_status").limit(10000)) as any[];
  const links = unwrapList(await db.from("ti_case_links").select("offence_category, investigation_status, station_norm").limit(10000)) as any[];
  const leads = unwrapList(await db.from("ti_leads").select("kind, status").limit(10000)) as any[];
  const count = (values: string[]) => values.reduce<Record<string, number>>((acc, v) => ((acc[v] = (acc[v] ?? 0) + 1), acc), {});
  return {
    persons: persons.length,
    byClassification: count(persons.map((p) => p.classification)),
    caseLinks: links.length,
    byCategory: count(links.map((l) => l.offence_category)),
    stations: new Set(links.map((l) => l.station_norm)).size,
    leads: { total: leads.length, byStatus: count(leads.map((l) => l.status)), byKind: count(leads.map((l) => l.kind)) },
  };
}

/** Officer activity on Third Eye, from the audit trail. */
export async function activityLog(limit = 200) {
  const rows = unwrapList(
    await db.from("action_log").select("id, actor_id, actor_role, action, subject, outcome, detail, created_at").ilike("action", "third_eye.%").order("created_at", { ascending: false }).limit(limit)
  ) as any[];
  const actors = [...new Set(rows.map((r) => r.actor_id).filter(Boolean))];
  const people = actors.length ? (unwrapList(await db.from("user_directory").select("id, full_name, station_or_court").in("id", actors)) as any[]) : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, actor_name: byId.get(r.actor_id)?.full_name ?? null, actor_station: byId.get(r.actor_id)?.station_or_court ?? null }));
}
