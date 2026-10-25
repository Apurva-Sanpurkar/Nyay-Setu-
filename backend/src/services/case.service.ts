import { Request } from "express";
import { randomBytes } from "crypto";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { saltedCaseIdHash } from "../lib/crypto";
import { describeSections, parseReference } from "../lib/statute";
import { conflict, fromSupabase, notFound } from "../lib/errors";
import { validateFir, normaliseStation, type FirInput } from "../lib/fir";
import { recordAction } from "./audit";
import type { SessionUser, UserRole } from "../middleware/auth";

/**
 * Case intake (2.0 · F1).
 *
 * A case is identified by its case_reference. The FIR is an optional,
 * separately stored attachment that only four roles may read, and it never
 * reaches the chain: new cases are keyed on chain by a salted hash of the
 * reference (docs/DECISIONS.md D-02).
 */

/** Roles that may read an FIR number. Defence and the accused see "linked", not the number. */
export const FIR_ROLES: UserRole[] = ["police", "prosecutor", "judge", "court_admin"];

export function canSeeFir(role: UserRole): boolean {
  return FIR_ROLES.includes(role);
}

/** Columns safe to select for any assigned role. fir_number and case_salt are never in it. */
export const CASE_COLUMNS =
  "id, case_reference, case_id_hash, case_key_scheme, origin, title, offence_type, sections, " +
  "police_station, court_name, status, registered_at, created_at";

export interface FirView {
  linked: boolean;
  number?: string;
  year?: number;
  date?: string | null;
  policeStation?: string;
  district?: string | null;
  backfilled?: boolean;
}

export async function firMap(caseIds: string[]): Promise<Map<string, any>> {
  if (caseIds.length === 0) return new Map();
  const rows = unwrapList(
    await db
      .from("fir_records")
      .select("case_id, fir_number, fir_year, fir_date, police_station, district, backfilled")
      .in("case_id", caseIds)
  ) as any[];
  return new Map(rows.map((r) => [r.case_id, r]));
}

export function firView(record: any | undefined, role: UserRole): FirView {
  if (!record) return { linked: false };
  if (!canSeeFir(role)) return { linked: true };
  return {
    linked: true,
    number: record.fir_number,
    year: record.fir_year,
    date: record.fir_date ?? null,
    policeStation: record.police_station,
    district: record.district ?? null,
    backfilled: Boolean(record.backfilled),
  };
}

/**
 * The one shape a case leaves the API in. Strips the two columns that must not
 * travel (the 1.0 FIR column and the key salt) whatever the caller selected.
 */
export function presentCase(row: any, role: UserRole, fir?: any): any {
  if (!row) return row;
  const { fir_number: _legacyFir, case_salt: _salt, ...safe } = row;
  return { ...safe, fir: firView(fir, role) };
}

export async function presentCases(rows: any[], role: UserRole): Promise<any[]> {
  // Loaded for every role: even those who may not read the number see whether one is linked.
  const firs = await firMap(rows.map((r) => r.id));
  return rows.map((row) => presentCase(row, role, firs.get(row.id)));
}

export interface CreateCaseInput {
  title: string;
  offenceType: string;
  sections: string[];
  policeStation: string;
  courtName?: string | null;
  summary?: string | null;
  origin: "fir" | "complaint" | "court" | "other";
  fir?: Omit<FirInput, "policeStation"> & { policeStation?: string };
}

async function nextReference(stationOrCourt: string, year: number): Promise<string> {
  const { data, error } = await db.rpc("next_case_reference", { p_station_code: stationOrCourt, p_year: year });
  if (error) throw fromSupabase(error);
  return String(data);
}

async function assertFirUnique(normalised: ReturnType<typeof validateFir>, exceptCaseId?: string) {
  const clash = unwrapMaybe(
    await db
      .from("fir_records")
      .select("case_id")
      .eq("police_station_norm", normalised.police_station_norm)
      .eq("fir_year", normalised.fir_year)
      .eq("fir_number_norm", normalised.fir_number_norm)
      .maybeSingle()
  ) as { case_id: string } | null;
  if (clash && clash.case_id !== exceptCaseId) {
    throw conflict(
      `FIR ${normalised.fir_number} of ${normalised.fir_year} at ${normalised.police_station} is already linked to another case.`
    );
  }
}

export async function createCase(req: Request, user: SessionUser, input: CreateCaseInput) {
  const now = new Date();
  const year = now.getUTCFullYear();

  const fir = input.fir
    ? validateFir({ ...input.fir, policeStation: input.fir.policeStation ?? input.policeStation }, now)
    : null;
  if (input.origin === "fir" && !fir) {
    throw conflict("A case whose origin is an FIR needs the FIR number and year. Choose another origin if there is no FIR yet.");
  }
  if (fir) await assertFirUnique(fir);

  const reference = await nextReference(normaliseStation(input.policeStation) || "UNASSIGNED", year);
  const salt = randomBytes(32).toString("hex");
  const caseIdHash = saltedCaseIdHash(reference, salt);

  const normalisedSections = (input.sections ?? []).map((raw) => parseReference(raw).canonical);

  const created = unwrap(
    await db
      .from("cases")
      .insert({
        case_reference: reference,
        case_id_hash: caseIdHash,
        case_key_scheme: "salted_v2",
        case_salt: salt,
        origin: input.origin,
        fir_number: null,
        title: input.title,
        offence_type: input.offenceType,
        sections: normalisedSections,
        police_station: input.policeStation,
        court_name: input.courtName ?? null,
        summary: input.summary ?? null,
        status: "registered",
        registered_by: user.id,
      })
      .select(CASE_COLUMNS)
      .single()
  ) as any;

  // The registering officer gets write access immediately; without it the very
  // next call would be refused by their own case-access check.
  await db.from("case_assignments").insert({
    case_id: created.id,
    user_id: user.id,
    access: "write",
    assigned_by: user.id,
  });

  let firRow: any = null;
  if (fir) {
    firRow = unwrap(
      await db
        .from("fir_records")
        .insert({ case_id: created.id, ...fir, recorded_by: user.id })
        .select("case_id, fir_number, fir_year, fir_date, police_station, district, backfilled")
        .single()
    );
  }

  const statute = describeSections(normalisedSections);
  await recordAction(req, {
    action: "case.register",
    subject: created.id,
    caseId: created.id,
    detail: {
      caseReference: reference,
      origin: input.origin,
      firLinked: Boolean(fir),
      keyScheme: "salted_v2",
      sectionsRecognised: statute.recognised,
      statutorySeverity: statute.severity,
    },
  });

  return { case: presentCase(created, user.role, firRow), statute };
}

export async function getFirRecord(caseId: string) {
  return unwrapMaybe(
    await db
      .from("fir_records")
      .select("case_id, fir_number, fir_year, fir_date, police_station, district, backfilled, created_at, updated_at")
      .eq("case_id", caseId)
      .maybeSingle()
  ) as any | null;
}

/** Links or corrects the FIR on an existing case. Every change is logged. */
export async function linkFir(req: Request, user: SessionUser, caseId: string, input: FirInput) {
  const row = unwrapMaybe(await db.from("cases").select("id, police_station").eq("id", caseId).maybeSingle()) as any;
  if (!row) throw notFound("Case");

  const fir = validateFir(input);
  await assertFirUnique(fir, caseId);

  const existing = await getFirRecord(caseId);
  const saved = existing
    ? unwrap(
        await db
          .from("fir_records")
          .update({ ...fir, backfilled: false, recorded_by: user.id })
          .eq("case_id", caseId)
          .select("case_id, fir_number, fir_year, fir_date, police_station, district, backfilled")
          .single()
      )
    : unwrap(
        await db
          .from("fir_records")
          .insert({ case_id: caseId, ...fir, recorded_by: user.id })
          .select("case_id, fir_number, fir_year, fir_date, police_station, district, backfilled")
          .single()
      );

  // The number itself is not written to the action log: the log is readable by
  // the actor, and the FIR row already carries its own audit trail.
  await recordAction(req, {
    action: existing ? "case.fir_corrected" : "case.fir_linked",
    subject: caseId,
    caseId,
    detail: { firYear: fir.fir_year, station: fir.police_station_norm, replaced: Boolean(existing) },
  });

  return firView(saved, user.role);
}

/* ------------------------------------------------------------------ timeline */

const ACTION_LABEL: Record<string, string> = {
  "case.register": "Case registered",
  "case.assign": "Participant given access",
  "case.unassign": "Participant access removed",
  "case.status_change": "Case status changed",
  "case.fir_linked": "FIR linked",
  "case.fir_corrected": "FIR details corrected",
  "evidence.register": "Evidence registered",
  "evidence.custody_transfer": "Custody transfer",
  "evidence.independent_verify": "Independent verification",
  "evidence.forensic_report": "Forensic report anchored",
  "evidence.retry_anchor": "Anchoring retried",
  "summons.issue": "Summons issued",
  "summons.acknowledge": "Summons acknowledged",
  "bail.grant": "Bail granted",
  "bail.checkin": "Bail check-in",
  "bail.violation": "Bail violation reported",
  "report.final_report": "Final report generated",
};

/**
 * Keys that may appear in a timeline entry's detail. Anything else — an FIR
 * number, a name, coordinates — is dropped, because the timeline is shown to
 * every role assigned to the case, defence included.
 */
const SAFE_DETAIL_KEYS = new Set([
  "txHash",
  "status",
  "fromStage",
  "toStage",
  "matched",
  "reason",
  "origin",
  "firLinked",
  "keyScheme",
  "chainEvidenceId",
  "state",
  "anomalyFlagged",
  "access",
  "role",
  "outcomeCode",
]);

function safeDetail(detail: any): Record<string, unknown> {
  if (!detail || typeof detail !== "object") return {};
  return Object.fromEntries(Object.entries(detail).filter(([k]) => SAFE_DETAIL_KEYS.has(k)));
}

export async function caseActivity(caseId: string, limit = 300) {
  const rows = unwrapList(
    await db
      .from("action_log")
      .select("id, actor_role, action, subject, outcome, detail, occurred_at")
      .eq("case_id", caseId)
      .order("occurred_at", { ascending: true })
      .limit(limit)
  ) as any[];

  return rows.map((row) => ({
    id: String(row.id),
    at: row.occurred_at,
    action: row.action,
    label: ACTION_LABEL[row.action] ?? row.action,
    actorRole: row.actor_role,
    outcome: row.outcome,
    subject: row.subject,
    detail: safeDetail(row.detail),
  }));
}
