import { db, unwrapMaybe } from "../../lib/supabase";
import { AppError, badRequest, notFound } from "../../lib/errors";
import { chain, explorerUrl } from "../../lib/chain";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { PUBLIC_REF_PATTERN } from "../../lib/publicRef";
import { chainReader, type ChainCustodyEvent } from "../verification/reader";
import { loadAnchor } from "../verification/anchors";
import type { VerificationState } from "../verification/stateMachine";
import { digestForChain } from "../capture.service";
import { explainEvidence, digestsEqual, type CaptureManifest } from "../../shared/integrity";
import type { UserRole } from "../../middleware/auth";

/**
 * The Evidence Integrity Passport (2.0 · F3).
 *
 * The public view is built from exactly the fields the privacy rule allows:
 * reference, anchored digest, transaction, block time, verification state, and
 * custody event types with role labels and times. No name, no case title, no
 * FIR, no coordinates, no notes. A test asserts that no other field appears.
 *
 * Postgres is used only to map the reference to an on-chain record id. The
 * digest, registration time and custody trail shown are read from the chain, and
 * if the database disagrees with the chain, the chain's value is shown and the
 * disagreement is flagged.
 */

export const LIMITS_OF_PROOF =
  "A matching fingerprint (SHA-256) proves that a file is bit-for-bit identical to the one whose " +
  "fingerprint was recorded on the blockchain at registration. It does not prove that what the file " +
  "shows is true, that it was lawfully collected, that a scene was genuine or not staged, that a " +
  "location reading was not spoofed, or who is responsible for anything it depicts. Those are " +
  "questions for investigation and for the court.";

const STAGE_LABEL: Record<string, string> = {
  SCENE: "Police (collection)",
  FORENSIC_LAB: "Forensic laboratory",
  PROSECUTOR: "Prosecution",
  COURT: "Court",
};

export type Agreement = "AGREES" | "DISAGREES" | "UNKNOWN";

export interface PublicCustodyEvent {
  type: "REGISTERED" | "CUSTODY_TRANSFER";
  from: string | null;
  to: string;
  at: string;
  source: "chain" | "record";
}

export interface PublicPassport {
  reference: string;
  source: "capture" | "upload";
  anchorMode: "file" | "manifest";
  /** For a capture: the GPS fix is inside the anchored digest. Never the coordinates. */
  locationCommitted: boolean;
  digest: string | null;
  digestSource: "chain" | "record";
  registeredAt: string | null;
  network: { name: string; chainId: number } | null;
  transaction: { hash: string | null; explorer: string | null; block: number | null };
  state: VerificationState;
  /** True only when the state is CONFIRMED and the chain agrees with the record. */
  verified: boolean;
  explanation: { heading: string; text: string };
  agreement: Agreement;
  flags: string[];
  custody: PublicCustodyEvent[];
  limits: string;
  checkedAt: string;
}

const PASSPORT_COLUMNS =
  "id, case_id, public_ref, chain_evidence_id, anchored_digest, file_hash, anchor_mode, source, " +
  "capture_manifest, gps_status, anchor_id, mismatch_count, created_at";

export function assertRef(ref: string): void {
  if (!PUBLIC_REF_PATTERN.test(ref)) throw badRequest("That is not a NyaySetu evidence reference.");
}

export async function loadByRef(ref: string): Promise<any> {
  assertRef(ref);
  const row = unwrapMaybe(
    await db.from("evidence_items").select(PASSPORT_COLUMNS).eq("public_ref", ref).maybeSingle()
  ) as any;
  if (!row) throw notFound("Evidence reference");
  return row;
}

function iso(seconds: number | null): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

function custodyFromChain(events: ChainCustodyEvent[]): PublicCustodyEvent[] {
  return events.map((e) => ({
    type: e.fromStage === null ? "REGISTERED" : "CUSTODY_TRANSFER",
    from: e.fromStage ? STAGE_LABEL[e.fromStage] ?? e.fromStage : null,
    to: STAGE_LABEL[e.toStage] ?? e.toStage,
    at: new Date(e.timestamp * 1000).toISOString(),
    source: "chain",
  }));
}

async function custodyFromRecord(evidenceId: string): Promise<PublicCustodyEvent[]> {
  const { data } = await db
    .from("custody_events")
    .select("from_stage, to_stage, occurred_at")
    .eq("evidence_id", evidenceId)
    .order("occurred_at", { ascending: true });
  return (data ?? []).map((e: any) => ({
    type: e.from_stage ? "CUSTODY_TRANSFER" : "REGISTERED",
    from: e.from_stage ? STAGE_LABEL[e.from_stage] ?? e.from_stage : null,
    to: STAGE_LABEL[e.to_stage] ?? e.to_stage,
    at: e.occurred_at,
    source: "record",
  }));
}

/** Builds the public passport. Reads the chain; uses the database only to find the record. */
export async function buildPassport(row: any): Promise<PublicPassport> {
  const anchor = row.anchor_id ? await loadAnchor(row.anchor_id) : null;
  const state: VerificationState = (anchor?.state as VerificationState) ?? "LOCAL_ONLY";
  const flags: string[] = [];
  const reader = chainReader();

  let digest: string | null = null;
  let digestSource: "chain" | "record" = "record";
  let registeredAt: string | null = null;
  let agreement: Agreement = "UNKNOWN";
  let custody: PublicCustodyEvent[] = [];

  const anchored = row.chain_evidence_id !== null && row.chain_evidence_id !== undefined;
  if (!anchored) flags.push("NOT_ANCHORED");

  if (anchored && reader.ready()) {
    try {
      const [onChain, events] = await Promise.all([
        reader.evidence(Number(row.chain_evidence_id)),
        reader.custody(Number(row.chain_evidence_id)),
      ]);
      digest = onChain.fileHash;
      digestSource = "chain";
      registeredAt = iso(onChain.collectedAt);
      custody = custodyFromChain(events);
      agreement = digestsEqual(onChain.fileHash, row.anchored_digest) ? "AGREES" : "DISAGREES";
      if (agreement === "DISAGREES") flags.push("RECORD_DISAGREES_WITH_CHAIN");
      if (onChain.mismatchCount > 0) flags.push("MISMATCH_RECORDED_ON_CHAIN");
    } catch (error) {
      logger.warn("Passport could not read the chain", { ref: row.public_ref, error: error instanceof Error ? error.message : error });
      flags.push("CHAIN_UNREADABLE");
    }
  } else if (anchored) {
    flags.push("CHAIN_UNREADABLE");
  }

  if (digestSource === "record") {
    // Shown, but labelled: this is the database's copy, not an independent read.
    digest = row.anchored_digest ?? null;
    custody = await custodyFromRecord(row.id);
  }

  const verified = state === "CONFIRMED" && agreement === "AGREES";
  const explained = explainEvidence(
    agreement === "DISAGREES" ? "INTEGRITY_MISMATCH" : state,
    "en"
  );

  return {
    reference: row.public_ref,
    source: row.source === "capture" ? "capture" : "upload",
    anchorMode: row.anchor_mode === "manifest" ? "manifest" : "file",
    locationCommitted: row.anchor_mode === "manifest" && row.gps_status !== null && row.gps_status !== "NO_GPS",
    digest,
    digestSource,
    registeredAt,
    network: chain.network,
    transaction: {
      hash: anchor?.tx_hash ?? null,
      explorer: anchor?.tx_hash ? explorerUrl(anchor.tx_hash) : null,
      block: anchor?.block_number ?? null,
    },
    state,
    verified,
    explanation: { heading: explained.title, text: explained.body },
    agreement,
    flags,
    custody,
    limits: LIMITS_OF_PROOF,
    checkedAt: new Date().toISOString(),
  };
}

export async function publicPassport(ref: string): Promise<PublicPassport> {
  return buildPassport(await loadByRef(ref));
}

export interface FileCheck {
  matched: boolean;
  comparedAgainst: "chain";
  anchorMode: "file" | "manifest";
  /** Capture only: whether the file is the one named inside the recorded manifest. */
  fileMatchesRecordedManifest: boolean | null;
  explanation: string;
}

/**
 * The "verify a file yourself" check. The browser sends only the file's SHA-256;
 * the file never leaves the visitor's device. The comparison is against the
 * chain, never against the database, and it refuses rather than guesses when the
 * chain cannot be read.
 */
export async function checkFileAgainstChain(ref: string, fileSha256: string): Promise<FileCheck> {
  const row = await loadByRef(ref);
  const mode: "file" | "manifest" = row.anchor_mode === "manifest" ? "manifest" : "file";
  if (row.chain_evidence_id === null || row.chain_evidence_id === undefined) {
    throw new AppError(409, "NOT_ANCHORED", "This item is not anchored on the blockchain yet, so there is nothing independent to compare with.");
  }
  const reader = chainReader();
  if (!reader.ready()) {
    throw new AppError(503, "CANNOT_VERIFY_NOW", "The blockchain cannot be read right now. Nothing was compared; try again shortly.");
  }

  let onChainDigest: string;
  try {
    onChainDigest = (await reader.evidence(Number(row.chain_evidence_id))).fileHash;
  } catch {
    throw new AppError(503, "CANNOT_VERIFY_NOW", "The blockchain cannot be read right now. Nothing was compared; try again shortly.");
  }

  const candidate = digestForChain(row, fileSha256);
  const matched = digestsEqual(candidate, onChainDigest);
  const manifest = row.capture_manifest as CaptureManifest | null;
  const fileMatchesRecordedManifest = mode === "manifest" && manifest ? digestsEqual(manifest.file.sha256, fileSha256) : null;

  return {
    matched,
    comparedAgainst: "chain",
    anchorMode: mode,
    fileMatchesRecordedManifest,
    explanation: matched
      ? "This file is identical to the one registered. Its fingerprint, as recorded on the blockchain, matches."
      : "This file does not match. It is not the registered file, or it has been changed since — even one altered byte changes the fingerprint.",
  };
}

/* ------------------------------------------------------- authorised view */

/** Roles assigned to a case that may see capture metadata, including where it was taken. */
export function canSeeCaptureDetail(role: UserRole): boolean {
  return role !== "accused";
}

export async function authorisedPassport(evidenceId: string, role: UserRole) {
  const row = unwrapMaybe(
    await db
      .from("evidence_items")
      .select(
        PASSPORT_COLUMNS +
          ", capture_purpose, gps_lat, gps_lng, gps_accuracy_m, gps_mocked, device_id, app_version, device_time, " +
          "server_received_at, clock_skew_seconds, clock_skew_flagged, signature_status, duration_ms, manifest_hash, kind, mime_type, size_bytes, " +
          "witnesses, search_checklist"
      )
      .eq("id", evidenceId)
      .maybeSingle()
  ) as any;
  if (!row) throw notFound("Evidence item");

  const passport = await buildPassport(row);
  if (!canSeeCaptureDetail(role)) return { passport, capture: null };

  return {
    passport,
    capture: {
      source: row.source,
      purpose: row.capture_purpose,
      kind: row.kind,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      fileSha256: row.file_hash,
      manifestHash: row.manifest_hash,
      deviceTime: row.device_time,
      serverReceivedAt: row.server_received_at,
      clockSkewSeconds: row.clock_skew_seconds,
      clockSkewFlagged: row.clock_skew_flagged,
      gps: {
        status: row.gps_status,
        accuracyMetres: row.gps_accuracy_m === null ? null : Number(row.gps_accuracy_m),
        mocked: row.gps_mocked,
        lat: row.gps_lat === null ? null : Number(row.gps_lat),
        lng: row.gps_lng === null ? null : Number(row.gps_lng),
      },
      signatureStatus: row.signature_status,
      durationMs: row.duration_ms,
      deviceId: row.device_id,
      appVersion: row.app_version,
      manifest: row.capture_manifest ?? null,
      witnesses: row.witnesses ?? [],
      searchChecklist: row.search_checklist ?? null,
    },
  };
}

export function verifyUrl(ref: string): string {
  return `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/verify/${ref}`;
}
