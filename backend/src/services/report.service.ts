import { db, unwrapList, unwrapMaybe } from "../lib/supabase";
import { describeSections, type StatuteSummary } from "../lib/statute";
import { chain } from "../lib/chain";
import { notFound } from "../lib/errors";
import { env } from "../config/env";
import { listCaseParticipants } from "./assignments.service";
import { canSeeFir, getFirRecord } from "./case.service";
import type { UserRole } from "../middleware/auth";

/**
 * The same dossier, with the FIR number removed for a reader who may not see it.
 * fir_linked stays true, so the document can say an FIR exists without naming it.
 */
export function redactForRole(dossier: CaseDossier, role: UserRole | null): CaseDossier {
  if (role && canSeeFir(role)) return dossier;
  return { ...dossier, case: { ...dossier.case, fir_number: null } };
}

/**
 * Everything a document needs, gathered in one place.
 *
 * Reports are assembled from the database rather than from whatever a screen
 * happened to have loaded, so a charge sheet printed twice is identical both
 * times, and so nothing a UI filtered out can go missing from a filing.
 */

export interface CaseDossier {
  case: {
    id: string;
    case_reference: string;
    /**
     * The FIR number, or null when none is linked or when the copy is for a role
     * that may not read FIR numbers (redactForRole). fir_linked says which.
     */
    fir_number: string | null;
    fir_linked: boolean;
    case_id_hash: string;
    title: string;
    offence_type: string;
    sections: string[];
    police_station: string;
    court_name: string | null;
    status: string;
    summary: string | null;
    registered_at: string;
  };
  statute: StatuteSummary;
  registeredBy: Person | null;
  evidence: EvidenceRow[];
  custody: Record<string, CustodyRow[]>;
  integrity: Record<string, IntegrityRow[]>;
  forensics: ForensicRow[];
  summons: SummonsRow[];
  bail: BailRow | null;
  violations: ViolationRow[];
  participants: Participant[];
  network: { name: string; chainId: number } | null;
  contracts: Record<string, string | undefined> | null;
  generatedAt: string;
}

interface Person {
  full_name: string;
  role: string;
  designation: string | null;
  station_or_court: string | null;
}

interface Participant extends Person {
  access: string;
}

interface EvidenceRow {
  id: string;
  chain_evidence_id: number | null;
  file_name: string;
  file_hash: string;
  mime_type: string | null;
  size_bytes: number | null;
  kind: string;
  current_stage: string;
  collected_at: string;
  gps_lat: number | null;
  gps_lng: number | null;
  ipfs_cid: string | null;
  anomaly_flagged: boolean;
  anomaly_reasons: string[] | null;
  anomaly_score: number | null;
  mismatch_count: number;
  registration_tx_hash: string | null;
  notes: string | null;
  users?: Person | null;
}

interface CustodyRow {
  from_stage: string | null;
  to_stage: string;
  confirmed_hash: string;
  actor_role: string | null;
  occurred_at: string;
  tx_hash: string | null;
  block_number: number | null;
}

interface IntegrityRow {
  submitted_hash: string;
  expected_hash: string;
  matched: boolean;
  checked_by_role: string | null;
  context: string | null;
  tx_hash: string | null;
  created_at: string;
}

interface ForensicRow {
  evidence_id: string;
  report_hash: string;
  conclusion: string;
  detail: string | null;
  tx_hash: string | null;
  created_at: string;
}

interface SummonsRow {
  id: string;
  recipient_name: string;
  status: string;
  issued_at: string;
  expiry_at: string;
  delivered_at: string | null;
  hearing_at: string | null;
  document_hash: string;
  ack_gps_lat: number | null;
  ack_gps_lng: number | null;
  issue_tx_hash: string | null;
  ack_tx_hash: string | null;
}

interface BailRow {
  created_at: string;
  accused_name: string;
  conditions: string[];
  condition_tags: string[];
  centre_lat: number | null;
  centre_lng: number | null;
  radius_metres: number;
  checkin_interval_seconds: number;
  expiry_at: string;
  active: boolean;
  compliance_score: number | null;
  risk_band: string | null;
  risk_score: number | null;
  order_text: string | null;
  surety_name: string | null;
  grant_tx_hash: string | null;
}

interface ViolationRow {
  kind: string;
  reason: string;
  detected_at: string;
  acknowledged_at: string | null;
  tx_hash: string | null;
}

/** Everything about one case, for any document that reports on it. */
export async function loadDossier(caseId: string): Promise<CaseDossier> {
  const caseRow = unwrapMaybe(
    await db
      .from("cases")
      .select(
        "id, case_reference, fir_number, case_id_hash, title, offence_type, sections, police_station, " +
          "court_name, status, summary, registered_at, registered_by"
      )
      .eq("id", caseId)
      .maybeSingle()
  ) as (CaseDossier["case"] & { registered_by: string | null }) | null;

  if (!caseRow) throw notFound("Case");

  // 2.0 cases keep their FIR in fir_records; 1.0 cases also have it on the row.
  const firRecord = await getFirRecord(caseId);
  caseRow.fir_number = firRecord?.fir_number ?? caseRow.fir_number ?? null;
  caseRow.fir_linked = Boolean(caseRow.fir_number);

  const evidence = unwrapList(
    await db
      .from("evidence_items")
      .select(
        "id, chain_evidence_id, file_name, file_hash, mime_type, size_bytes, kind, current_stage, " +
          "collected_at, gps_lat, gps_lng, ipfs_cid, anomaly_flagged, anomaly_reasons, anomaly_score, " +
          "mismatch_count, registration_tx_hash, notes, officer_id"
      )
      .eq("case_id", caseId)
      .order("collected_at", { ascending: true })
  ) as unknown as (EvidenceRow & { officer_id: string | null })[];

  const evidenceIds = evidence.map((e) => e.id);

  // Officers are looked up through the directory view, which exposes names and
  // roles without reaching the table that holds Aadhaar tokens.
  const officerIds = [
    ...new Set([caseRow.registered_by, ...evidence.map((e) => e.officer_id)].filter(Boolean)),
  ] as string[];

  const people = officerIds.length
    ? (unwrapList(
        await db
          .from("user_directory")
          .select("id, full_name, role, designation, station_or_court")
          .in("id", officerIds)
      ) as (Person & { id: string })[])
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));

  const [custodyRows, integrityRows, forensics, summons, bail, violations, participants] =
    await Promise.all([
      evidenceIds.length
        ? db
            .from("custody_events")
            .select(
              "evidence_id, from_stage, to_stage, confirmed_hash, actor_role, occurred_at, tx_hash, block_number"
            )
            .in("evidence_id", evidenceIds)
            .order("occurred_at", { ascending: true })
            .then((r) => (r.data ?? []) as (CustodyRow & { evidence_id: string })[])
        : Promise.resolve([]),
      evidenceIds.length
        ? db
            .from("integrity_checks")
            .select(
              "evidence_id, submitted_hash, expected_hash, matched, checked_by_role, context, tx_hash, created_at"
            )
            .in("evidence_id", evidenceIds)
            .order("created_at", { ascending: true })
            .then((r) => (r.data ?? []) as (IntegrityRow & { evidence_id: string })[])
        : Promise.resolve([]),
      db
        .from("forensic_reports")
        .select("evidence_id, report_hash, conclusion, detail, tx_hash, created_at")
        .eq("case_id", caseId)
        .order("created_at", { ascending: true })
        .then((r) => (r.data ?? []) as ForensicRow[]),
      db
        .from("summons")
        .select(
          "id, recipient_name, status, issued_at, expiry_at, delivered_at, hearing_at, " +
            "document_hash, ack_gps_lat, ack_gps_lng, issue_tx_hash, ack_tx_hash"
        )
        .eq("case_id", caseId)
        .order("issued_at", { ascending: true })
        .then((r) => (r.data ?? []) as unknown as SummonsRow[]),
      db
        .from("bail_conditions")
        .select(
          "created_at, accused_name, conditions, condition_tags, centre_lat, centre_lng, radius_metres, " +
            "checkin_interval_seconds, expiry_at, active, compliance_score, risk_band, risk_score, " +
            "order_text, surety_name, grant_tx_hash"
        )
        .eq("case_id", caseId)
        .maybeSingle()
        .then((r) => (r.data ?? null) as BailRow | null),
      db
        .from("violations")
        .select("kind, reason, detected_at, acknowledged_at, tx_hash")
        .eq("case_id", caseId)
        .order("detected_at", { ascending: true })
        .then((r) => (r.data ?? []) as ViolationRow[]),
      // Was an embed, which PostgREST refused as ambiguous — and the refusal was
      // swallowed by the `.then` below, so this list came back EMPTY and the Final
      // Report's "persons having access" table printed nothing. A court document
      // that lists nobody is worse than one that fails to render.
      listCaseParticipants(caseId),
    ]);

  const custody: Record<string, CustodyRow[]> = {};
  for (const row of custodyRows) {
    (custody[row.evidence_id] ??= []).push(row);
  }

  const integrity: Record<string, IntegrityRow[]> = {};
  for (const row of integrityRows) {
    (integrity[row.evidence_id] ??= []).push(row);
  }

  return {
    case: caseRow,
    statute: describeSections(caseRow.sections ?? []),
    registeredBy: caseRow.registered_by ? (byId.get(caseRow.registered_by) ?? null) : null,
    evidence: evidence.map((e) => ({ ...e, users: e.officer_id ? (byId.get(e.officer_id) ?? null) : null })),
    custody,
    integrity,
    forensics,
    summons,
    bail,
    violations,
    participants,
    network: chain.isReady ? chain.network : null,
    contracts: chain.isReady ? chain.addresses : null,
    generatedAt: new Date().toISOString(),
  };
}

/** The gateway a recipient would fetch a pinned ciphertext from. */
export function gatewayFor(cid: string | null): string | null {
  if (!cid) return null;
  if (cid.startsWith("local-")) return null;
  return `${env.PINATA_GATEWAY.replace(/\/$/, "")}/ipfs/${cid}`;
}
