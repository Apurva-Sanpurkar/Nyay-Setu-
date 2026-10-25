import { Request } from "express";
import { randomUUID } from "crypto";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { sha256Hex, keccakOfString, officerPseudonym } from "../lib/crypto";
import { storeEncrypted, loadDecrypted } from "../lib/storage";
import { toMicroDegrees, fromMicroDegrees, explorerUrl } from "../lib/chain";
import { chainReader } from "./verification/reader";
import { conflict, notFound, AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { env } from "../config/env";
import { screenEvidence, recordPrediction } from "../lib/ai";
import { recordAction } from "./audit";
import { SessionUser } from "../middleware/auth";
import {
  createAnchor,
  loadAnchor,
  sendAnchor,
  transition,
  type AnchorRow,
  type Actor,
} from "./verification/anchors";
import { STATE_LABEL, type VerificationState } from "./verification/stateMachine";
import { checkCapture, digestForChain, type SignatureEnvelope } from "./capture.service";
import { newPublicRef } from "../lib/publicRef";

/**
 * SaakshyaSetu service layer.
 *
 * Two ordering rules carry the weight of this file:
 *
 * 1. The digest is produced on the officer's device, and everything downstream is
 *    checked against it. The server recomputes it over the bytes it received and
 *    refuses the upload if the two disagree.
 *
 * 2. Everything is recorded off chain BEFORE anything is sent on chain, and every
 *    chain write is an anchor moved through the verification state machine
 *    (services/verification). A chain failure therefore leaves a visible record in
 *    SYNC_ERROR with a retry, never a lost item and never a false "verified".
 */

export const STAGES = ["SCENE", "FORENSIC_LAB", "PROSECUTOR", "COURT"] as const;
export type Stage = (typeof STAGES)[number];

const NEXT_STAGE: Record<Stage, Stage | null> = {
  SCENE: "FORENSIC_LAB",
  FORENSIC_LAB: "PROSECUTOR",
  PROSECUTOR: "COURT",
  COURT: null,
};

/** Which role is entitled to receive custody at each stage. */
const STAGE_ROLE: Record<Stage, string> = {
  SCENE: "police",
  FORENSIC_LAB: "forensic_lab",
  PROSECUTOR: "prosecutor",
  COURT: "judge",
};

/** keccak256 of the stage label, matching EvidenceChain's STAGE_* constants. */
function stageTag(stage: Stage): string {
  return keccakOfString(stage);
}

function actorOf(user: SessionUser): Actor {
  return { id: user.id, role: user.role };
}

/* ------------------------------------------------------------ presentation */

/** The verification block every evidence response carries. Never over-claims. */
export function presentVerification(anchor: Partial<AnchorRow> | null | undefined) {
  if (!anchor || !anchor.state) {
    return {
      state: "LOCAL_ONLY" as VerificationState,
      label: STATE_LABEL.LOCAL_ONLY,
      verified: false,
      txHash: null,
      explorer: null,
      blockNumber: null,
      confirmations: 0,
      requiredConfirmations: env.confirmationDepth,
      failureCode: null,
      failureReason: null,
      submittedAt: null,
      confirmedAt: null,
      lastCheckedAt: null,
    };
  }
  const state = anchor.state as VerificationState;
  return {
    anchorId: anchor.id ?? null,
    state,
    label: STATE_LABEL[state],
    // The only state in which anything may be shown as verified.
    verified: state === "CONFIRMED",
    txHash: anchor.tx_hash ?? null,
    explorer: anchor.tx_hash ? explorerUrl(anchor.tx_hash) : null,
    blockNumber: anchor.block_number ?? null,
    confirmations: anchor.confirmations ?? 0,
    requiredConfirmations: anchor.required_confirmations ?? env.confirmationDepth,
    failureCode: anchor.failure_code ?? null,
    failureReason: anchor.failure_reason ?? null,
    submittedAt: anchor.submitted_at ?? null,
    confirmedAt: anchor.confirmed_at ?? null,
    lastCheckedAt: anchor.last_checked_at ?? null,
  };
}

/** Columns of evidence_items that may leave the API. The encryption envelope never does. */
export function stripEnvelope(item: any) {
  if (!item) return item;
  // The capture manifest holds raw coordinates: it is served only by the
  // dedicated, access-checked passport and manifest routes.
  const { encryption_iv, encryption_tag, encryption_key_id, idempotency_key, capture_manifest, manifest_signature, witnesses, ...safe } = item;
  return safe;
}

/* ------------------------------------------------------------ registration */

export interface RegisterInput {
  caseId: string;
  clientHash: string;
  fileName: string;
  mimeType: string;
  kind: "photo" | "video" | "document" | "audio" | "physical";
  buffer: Buffer;
  gpsLat: number | null;
  gpsLng: number | null;
  collectedAt: string;
  /** "capture" requires a manifest; "upload" is a file chosen from storage. */
  source?: "upload" | "capture";
  manifest?: unknown;
  signature?: SignatureEnvelope | null;
  /** The device clock when the request was sent, for skew detection. */
  deviceClockAtSendMs?: number | null;
  /** Search and seizure (F12): who was present, and the minimum checklist. Off chain. */
  witnesses?: { name: string; description?: string }[] | null;
  searchChecklist?: Record<string, boolean> | null;
  deviceReportedMtime?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
}

/** Coordinates for registerEvidence: real micro-degrees only when explicitly enabled (D-03). */
function chainCoordinates(lat: number | null, lng: number | null): [bigint, bigint] {
  if (!env.ANCHOR_RAW_COORDS_ON_CHAIN || lat === null || lng === null) return [0n, 0n];
  return [toMicroDegrees(lat, "latitude"), toMicroDegrees(lng, "longitude")];
}

async function replayRegistration(row: any, user: SessionUser) {
  if (row.officer_id !== user.id) {
    throw conflict("That idempotency key was already used by someone else. Generate a new one per item.");
  }
  const anchor = row.anchor_id ? await loadAnchor(row.anchor_id) : null;
  return {
    evidence: stripEnvelope(row),
    verification: presentVerification(anchor),
    screening: { available: row.anomaly_score !== null, anomaly: row.anomaly_flagged, score: row.anomaly_score ?? 0, reasons: row.anomaly_reasons ?? [] },
    anomalyFlagHash: row.anomaly_flag_hash ?? null,
    chain: {
      txHash: anchor?.tx_hash ?? null,
      blockNumber: anchor?.block_number ?? null,
      explorer: anchor?.tx_hash ? explorerUrl(anchor.tx_hash) : null,
      chainEvidenceId: row.chain_evidence_id ?? null,
    },
    replayed: true,
  };
}

/** Copies the chain id and transaction from a registration anchor onto the evidence row. */
export async function linkRegistration(evidenceId: string, anchor: AnchorRow): Promise<void> {
  if (anchor.purpose !== "evidence_registration") return;
  const patch: Record<string, unknown> = {};
  if (anchor.chain_record_id !== null && anchor.chain_record_id !== undefined) patch.chain_evidence_id = anchor.chain_record_id;
  if (anchor.tx_hash) patch.registration_tx_hash = anchor.tx_hash;
  if (Object.keys(patch).length === 0) return;
  await db.from("evidence_items").update(patch).eq("id", evidenceId);

  // The genesis custody record learns its transaction too.
  if (anchor.tx_hash) {
    await db
      .from("custody_events")
      .update({ tx_hash: anchor.tx_hash, block_number: anchor.block_number ?? null })
      .eq("evidence_id", evidenceId)
      .is("from_stage", null)
      .is("tx_hash", null);
  }
}

export async function registerEvidence(req: Request, user: SessionUser, input: RegisterInput) {
  if (input.idempotencyKey) {
    const prior = unwrapMaybe(
      await db.from("evidence_items").select("*").eq("idempotency_key", input.idempotencyKey).maybeSingle()
    ) as any;
    if (prior) return replayRegistration(prior, user);
  }

  const caseRow = unwrapMaybe(
    await db.from("cases").select("id, case_reference, case_id_hash, police_station").eq("id", input.caseId).maybeSingle()
  ) as { id: string; case_reference: string; case_id_hash: string; police_station: string } | null;
  if (!caseRow) throw notFound("Case");

  // 1 -- Confirm the client's digest describes the bytes we actually received.
  const serverHash = sha256Hex(input.buffer);
  if (serverHash !== input.clientHash) {
    await recordAction(req, {
      action: "evidence.register",
      caseId: caseRow.id,
      outcome: "refused",
      detail: { reason: "client_hash_mismatch", clientHash: input.clientHash, serverHash },
    });
    throw conflict(
      "The digest computed on your device does not match the file that arrived. " +
        "The upload was refused rather than registering a hash that does not describe the file.",
      { clientHash: input.clientHash, serverHash }
    );
  }

  // 1b -- A live capture: the manifest must describe exactly these bytes, this
  //       case and this officer. Its digest, not the file's, goes on chain.
  const source = input.source ?? "upload";
  if (source === "capture" && !input.manifest) {
    throw conflict("A live capture must carry its capture manifest. Use source=upload for an existing file.");
  }
  const capture =
    source === "capture"
      ? await checkCapture({
          manifest: input.manifest,
          signature: input.signature ?? null,
          serverFileHash: serverHash,
          fileBytes: input.buffer.length,
          caseReference: caseRow.case_reference,
          userId: user.id,
          deviceClockAtSendMs: input.deviceClockAtSendMs ?? null,
        })
      : null;
  if (capture && capture.manifest.source !== "capture") {
    throw conflict("The manifest says this file was uploaded, not captured live.");
  }
  const gpsLat = capture ? capture.gps.lat : input.gpsLat;
  const gpsLng = capture ? capture.gps.lng : input.gpsLng;
  const anchoredDigest = capture ? capture.manifestHash : serverHash;

  // 2 -- Anomaly screening, before anything is anchored.
  const uploadDelaySeconds = Math.max(0, Math.round((Date.now() - new Date(input.collectedAt).getTime()) / 1000));
  const screeningInput = {
    fileSizeBytes: input.buffer.length,
    mimeType: input.mimeType,
    claimedCollectedAt: input.collectedAt,
    deviceReportedMtime: input.deviceReportedMtime ?? null,
    // The model needs a position; an item without one is screened at the
    // jurisdiction centroid, and the missing fix is reported separately.
    gpsLat: gpsLat ?? 0,
    gpsLng: gpsLng ?? 0,
    uploadDelaySeconds,
  };
  const screening = await screenEvidence(screeningInput);

  // 3 -- Encrypt and store. Only ciphertext leaves the process.
  const blob = await storeEncrypted(input.buffer, serverHash.slice(2, 18));

  // 4 -- Persist off chain first: a chain failure leaves a visible record, not a lost file.
  const inserted = await db
    .from("evidence_items")
    .insert({
      case_id: caseRow.id,
      file_hash: serverHash,
      file_name: input.fileName,
      mime_type: input.mimeType,
      size_bytes: input.buffer.length,
      kind: input.kind,
      ipfs_cid: blob.cid,
      encryption_iv: blob.iv,
      encryption_tag: blob.tag,
      encryption_key_id: blob.keyId,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      collected_at: capture ? capture.deviceTime : input.collectedAt,
      device_reported_mtime: input.deviceReportedMtime ?? null,
      current_stage: "SCENE",
      officer_id: user.id,
      officer_aadhaar_token: officerPseudonym(user.id),
      anomaly_score: screening.available ? screening.score : null,
      anomaly_flagged: screening.anomaly,
      anomaly_reasons: screening.reasons,
      notes: input.notes ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      public_ref: newPublicRef(),
      source,
      anchor_mode: capture ? "manifest" : "file",
      anchored_digest: anchoredDigest,
      capture_purpose: capture?.purpose ?? "general",
      capture_manifest: capture?.manifest ?? null,
      manifest_hash: capture?.manifestHash ?? null,
      manifest_signature: input.signature ?? null,
      signature_status: capture?.signatureStatus ?? "none",
      gps_status: capture ? capture.gps.status : gpsLat === null ? "NO_GPS" : null,
      gps_accuracy_m: capture?.gps.accuracyMetres ?? null,
      gps_mocked: capture?.gps.mocked ?? null,
      device_id: capture?.deviceId ?? null,
      app_version: capture?.appVersion ?? null,
      device_time: capture?.deviceTime ?? null,
      server_received_at: new Date().toISOString(),
      clock_skew_seconds: capture?.skewSeconds ?? null,
      clock_skew_flagged: capture?.skewFlagged ?? false,
      duration_ms: capture?.durationMs ?? null,
      witnesses: input.witnesses ?? null,
      search_checklist: input.searchChecklist ?? null,
    })
    .select("*")
    .single();

  if (inserted.error?.code === "23505" && input.idempotencyKey) {
    // Two copies of the same request raced; the other one won.
    const winner = unwrap(
      await db.from("evidence_items").select("*").eq("idempotency_key", input.idempotencyKey).single()
    );
    return replayRegistration(winner, user);
  }
  const row = unwrap(inserted) as any;

  // 5 -- The anchor, then the genesis custody record (its tx is filled in once known).
  const [lat, lng] = chainCoordinates(gpsLat, gpsLng);
  const pseudonym = officerPseudonym(user.id);
  const { anchor: created } = await createAnchor({
    purpose: "evidence_registration",
    contract: "EvidenceChain",
    method: "registerEvidence",
    args: [caseRow.case_id_hash, anchoredDigest, lat, lng, pseudonym],
    caseId: caseRow.id,
    subjectType: "evidence_item",
    subjectId: row.id,
    expectedEvent: "EvidenceRegistered",
    expectedDigest: anchoredDigest,
    digestArg: "fileHash",
    expectedArgs: { caseId: caseRow.case_id_hash },
    idempotencyKey: `evidence:${row.id}:registration`,
    createdBy: user.id,
  });
  await db.from("evidence_items").update({ anchor_id: created.id }).eq("id", row.id);

  await db.from("custody_events").insert({
    evidence_id: row.id,
    from_stage: null,
    to_stage: "SCENE",
    confirmed_hash: anchoredDigest,
    actor_id: user.id,
    actor_role: user.role,
    occurred_at: new Date().toISOString(),
    tx_hash: null,
    block_number: null,
  });

  // 6 -- Anchor on chain. A failure here is reported, not thrown.
  const outcome = await sendAnchor(created, actorOf(user));
  await linkRegistration(row.id, outcome.anchor);
  const chainEvidenceId = outcome.anchor.chain_record_id ?? null;

  // 7 -- Anchor the AI verdict, write-once on chain, if the item itself is on chain.
  let anomalyFlagHash: string | null = null;
  if (screening.available && chainEvidenceId !== null) {
    anomalyFlagHash = await recordPrediction({
      model: "evidence_anomaly",
      modelVersion: screening.modelVersion,
      subjectType: "evidence_item",
      subjectId: row.id,
      caseId: caseRow.id,
      input: screeningInput,
      output: { anomaly: screening.anomaly, score: screening.score, reasons: screening.reasons },
    });

    const { anchor: flagAnchor } = await createAnchor({
      purpose: "anomaly_flag",
      contract: "EvidenceChain",
      method: "anchorAnomalyFlag",
      args: [chainEvidenceId, anomalyFlagHash],
      caseId: caseRow.id,
      subjectType: "evidence_item",
      subjectId: row.id,
      parentAnchorId: outcome.anchor.id,
      expectedEvent: "AnomalyFlagAnchored",
      expectedDigest: anomalyFlagHash,
      digestArg: "flagHash",
      expectedArgs: { evidenceId: String(chainEvidenceId) },
      idempotencyKey: `evidence:${row.id}:anomaly_flag`,
      createdBy: user.id,
    });
    const flagged = await sendAnchor(flagAnchor, actorOf(user));
    if (!flagged.error) {
      await db.from("evidence_items").update({ anomaly_flag_hash: anomalyFlagHash }).eq("id", row.id);
    } else {
      logger.warn("Could not anchor the anomaly verdict", { evidenceId: row.id, error: flagged.error.message });
    }
  }

  await recordAction(req, {
    action: "evidence.register",
    subject: row.id,
    caseId: caseRow.id,
    outcome: outcome.error ? "failed" : "ok",
    detail: {
      chainEvidenceId,
      txHash: outcome.txHash,
      state: outcome.anchor.state,
      anomalyFlagged: screening.anomaly,
      ipfsBackend: blob.backend,
      source,
      ...(capture ? { gpsStatus: capture.gps.status, signature: capture.signatureStatus, skewFlagged: capture.skewFlagged } : {}),
      ...(outcome.error ? { reason: outcome.anchor.failure_code } : {}),
    },
  });

  return {
    evidence: stripEnvelope({
      ...row,
      anchor_id: outcome.anchor.id,
      chain_evidence_id: chainEvidenceId,
      registration_tx_hash: outcome.anchor.tx_hash,
    }),
    verification: presentVerification(outcome.anchor),
    screening,
    anomalyFlagHash,
    chain: {
      txHash: outcome.anchor.tx_hash,
      blockNumber: outcome.anchor.block_number,
      explorer: outcome.anchor.tx_hash ? explorerUrl(outcome.anchor.tx_hash) : null,
      chainEvidenceId,
    },
    replayed: false,
  };
}

/**
 * Resends a registration that failed, or that a reviewer has cleared for resending.
 * sendAnchor refuses to resend when the earlier transaction may still have landed.
 */
export async function retryRegistration(req: Request, user: SessionUser, evidenceId: string) {
  const item = await loadEvidence(evidenceId);
  if (!item.anchor_id) throw conflict("This item has no registration anchor to retry.");
  const anchor = await loadAnchor(item.anchor_id);

  if (anchor.state === "CONFIRMED" || anchor.state === "SUBMITTED") {
    return { verification: presentVerification(anchor), resent: false };
  }
  if (anchor.state === "INTEGRITY_MISMATCH") {
    throw conflict("An item with an integrity mismatch is not resent. It needs review by two people.");
  }

  const outcome = await sendAnchor(anchor, actorOf(user));
  await linkRegistration(item.id, outcome.anchor);

  await recordAction(req, {
    action: "evidence.retry_anchor",
    subject: item.id,
    caseId: item.case_id,
    outcome: outcome.error ? "failed" : "ok",
    detail: { state: outcome.anchor.state, txHash: outcome.txHash },
  });

  return { verification: presentVerification(outcome.anchor), resent: !outcome.error, error: outcome.error?.message ?? null };
}

/** Marks the registration anchor as an integrity mismatch, whatever state it was in. */
export async function markIntegrityMismatch(
  item: any,
  actor: Actor,
  args: { code: string; reason: string }
): Promise<AnchorRow | null> {
  if (!item.anchor_id) return null;
  const anchor = await loadAnchor(item.anchor_id);
  if (anchor.state === "INTEGRITY_MISMATCH") return anchor;
  let current = anchor;
  // LOCAL_ONLY and SYNC_ERROR have no direct edge to a mismatch on chain; they
  // pass through review so the history shows how it got there.
  if (current.state === "SYNC_ERROR") {
    current = await transition(current, "REVIEW_REQUIRED", { code: args.code, reason: args.reason, actor });
  }
  return transition(current, "INTEGRITY_MISMATCH", { code: args.code, reason: args.reason, actor });
}

/* ---------------------------------------------------------------- custody */

/**
 * Anchors an integrity check and, if the CHAIN says it matched, moves custody on.
 *
 * The decision comes from the event reportIntegrityCheck emitted —
 * IntegrityVerified or IntegrityMismatch — not from comparing against the
 * database. If the database row had been altered to agree with a tampered file,
 * a database comparison would agree with the alteration; the chain would not.
 *
 * The check is anchored either way. On a mismatch, transferCustody is never
 * sent: it would revert, and a reverted transaction records nothing. The refusal
 * is on chain because the integrity check, a successful transaction, says so.
 */
export async function transferCustody(
  req: Request,
  user: SessionUser,
  evidenceId: string,
  submittedHash: string,
  attemptKey: string = randomUUID()
) {
  const item = await loadEvidence(evidenceId);
  const fromStage = item.current_stage as Stage;
  const toStage = NEXT_STAGE[fromStage];

  if (!toStage) throw conflict("This item has already reached the court. Custody cannot move further.");
  if (STAGE_ROLE[toStage] !== user.role) {
    throw conflict(`Custody at ${toStage} is received by ${STAGE_ROLE[toStage]}. You are signed in as ${user.role}.`);
  }
  if (item.chain_evidence_id === null || item.chain_evidence_id === undefined) {
    throw conflict("This item is not anchored on chain yet. Retry its registration before transferring custody.");
  }

  const actor = actorOf(user);
  // The receiver hashes the FILE they hold. For a live capture the chain holds
  // the manifest's digest, so the server substitutes the receiver's file digest
  // into the stored manifest and sends that (DECISIONS D-04).
  const chainDigest = digestForChain(item, submittedHash);
  const { anchor: checkAnchor } = await createAnchor({
    purpose: "integrity_check",
    contract: "EvidenceChain",
    method: "reportIntegrityCheck",
    args: [item.chain_evidence_id, chainDigest],
    caseId: item.case_id,
    subjectType: "evidence_item",
    subjectId: item.id,
    parentAnchorId: item.anchor_id ?? null,
    expectedEvent: "IntegrityVerified|IntegrityMismatch",
    expectedDigest: chainDigest,
    digestArg: "checkHash|submittedHash",
    expectedArgs: { evidenceId: String(item.chain_evidence_id) },
    idempotencyKey: `custody-check:${item.id}:${attemptKey}`,
    createdBy: user.id,
  });

  const checked = await sendAnchor(checkAnchor, actor);
  if (checked.error || !checked.event) {
    await recordAction(req, {
      action: "evidence.custody_transfer",
      subject: item.id,
      caseId: item.case_id,
      outcome: "failed",
      detail: { reason: "integrity_check_not_recorded", state: checked.anchor.state },
    });
    throw new AppError(
      checked.error?.status ?? 502,
      "INTEGRITY_CHECK_NOT_RECORDED",
      "The integrity check could not be recorded on chain, so custody was not moved. Nothing has changed; retry when the chain is reachable.",
      { verification: presentVerification(checked.anchor) }
    );
  }

  const matched = checked.event.name === "IntegrityVerified";
  const expectedOnChain = String(checked.event.args.expectedHash ?? item.anchored_digest ?? item.file_hash);

  await db.from("integrity_checks").insert({
    evidence_id: item.id,
    submitted_hash: chainDigest,
    expected_hash: matched ? chainDigest : expectedOnChain,
    matched,
    checked_by: user.id,
    checked_by_role: user.role,
    context: `custody_transfer:${fromStage}->${toStage}`,
    tx_hash: checked.txHash,
  });

  if (!matched) {
    await db.from("evidence_items").update({ mismatch_count: (item.mismatch_count ?? 0) + 1 }).eq("id", item.id);
    await markIntegrityMismatch(item, actor, {
      code: "CUSTODY_HASH_MISMATCH",
      reason: `The digest presented at ${fromStage} → ${toStage} did not match the registered one.`,
    });

    await recordAction(req, {
      action: "evidence.custody_transfer",
      subject: item.id,
      caseId: item.case_id,
      outcome: "refused",
      detail: { reason: "hash_mismatch", matched: false, txHash: checked.txHash },
    });

    throw new AppError(
      409,
      "HASH_MISMATCH",
      "The hash of the file you hold does not match the registered evidence. Custody was refused. " +
        "The mismatch is recorded on chain by the integrity-check transaction, which succeeded; " +
        "no custody transfer was attempted.",
      {
        expectedHash: expectedOnChain,
        submittedHash,
        anchoredAt: checked.txHash,
        explorer: checked.txHash ? explorerUrl(checked.txHash) : null,
      }
    );
  }

  const { anchor: transferAnchor } = await createAnchor({
    purpose: "custody_transfer",
    contract: "EvidenceChain",
    method: "transferCustody",
    args: [item.chain_evidence_id, stageTag(fromStage), stageTag(toStage), chainDigest],
    caseId: item.case_id,
    subjectType: "evidence_item",
    subjectId: item.id,
    parentAnchorId: item.anchor_id ?? null,
    expectedEvent: "CustodyTransferred",
    expectedDigest: chainDigest,
    digestArg: "confirmedHash",
    expectedArgs: { evidenceId: String(item.chain_evidence_id) },
    idempotencyKey: `custody-transfer:${item.id}:${attemptKey}`,
    createdBy: user.id,
  });

  const moved = await sendAnchor(transferAnchor, actor);
  if (moved.error) {
    await recordAction(req, {
      action: "evidence.custody_transfer",
      subject: item.id,
      caseId: item.case_id,
      outcome: "failed",
      detail: { reason: moved.anchor.failure_code, state: moved.anchor.state, fromStage, toStage },
    });
    throw new AppError(moved.error.status, "CUSTODY_NOT_ANCHORED", `The digest matched, but the transfer did not reach the chain: ${moved.error.message} Custody has not moved; retry.`, {
      verification: presentVerification(moved.anchor),
    });
  }

  await db.from("custody_events").insert({
    evidence_id: item.id,
    from_stage: fromStage,
    to_stage: toStage,
    confirmed_hash: chainDigest,
    actor_id: user.id,
    actor_role: user.role,
    occurred_at: new Date().toISOString(),
    tx_hash: moved.txHash,
    block_number: moved.anchor.block_number,
  });

  await db.from("evidence_items").update({ current_stage: toStage }).eq("id", item.id);

  await recordAction(req, {
    action: "evidence.custody_transfer",
    subject: item.id,
    caseId: item.case_id,
    detail: { fromStage, toStage, txHash: moved.txHash, state: moved.anchor.state },
  });

  return {
    fromStage,
    toStage,
    verification: presentVerification(moved.anchor),
    chain: {
      txHash: moved.txHash,
      blockNumber: moved.anchor.block_number,
      explorer: moved.txHash ? explorerUrl(moved.txHash) : null,
    },
  };
}

/* ------------------------------------------------- independent verification */

/**
 * Independent verification, the defence-side flow.
 *
 * Reads the answer from the chain rather than from evidence_items.file_hash: if
 * the prosecution's database were altered, a comparison against it would agree
 * with the alteration. The database is used only to find which id to ask about.
 *
 * A mismatch here is NOT treated as evidence of tampering with the item: anyone
 * assigned can submit any file, and a different file is simply a different
 * file. Only a custodian's or laboratory's re-check moves the item's state.
 */
export async function verifyAgainstChain(
  req: Request,
  user: SessionUser,
  evidenceId: string,
  submittedHash: string,
  anchor: boolean
) {
  const item = await loadEvidence(evidenceId);
  if (item.chain_evidence_id === null || item.chain_evidence_id === undefined) {
    throw conflict("This item is not anchored on chain, so there is nothing independent to verify against.");
  }

  const reader = chainReader();
  if (!reader.ready()) {
    throw new AppError(503, "UNAVAILABLE", "The blockchain cannot be read right now, so nothing can be verified independently. Retry shortly.");
  }
  const onChain = await reader.evidence(Number(item.chain_evidence_id));
  const chainHash: string = onChain.fileHash;
  // For a capture, the visitor's FILE digest is turned into the manifest digest
  // the chain holds, using the manifest on record. A tampered manifest cannot
  // produce a false match without a SHA-256 pre-image.
  const candidate = digestForChain(item, submittedHash);
  const matched = chainHash === candidate;

  // Does the off-chain record still agree with the chain? A disagreement here is
  // a database tampering finding in its own right.
  const databaseAgreesWithChain = String(item.anchored_digest ?? item.file_hash).toLowerCase() === chainHash;

  let txHash: string | null = null;
  let verification: ReturnType<typeof presentVerification> | null = null;
  if (anchor) {
    const { anchor: checkAnchor } = await createAnchor({
      purpose: "integrity_check",
      contract: "EvidenceChain",
      method: "reportIntegrityCheck",
      args: [item.chain_evidence_id, candidate],
      caseId: item.case_id,
      subjectType: "evidence_item",
      subjectId: item.id,
      parentAnchorId: item.anchor_id ?? null,
      expectedEvent: "IntegrityVerified|IntegrityMismatch",
      expectedDigest: candidate,
      digestArg: "checkHash|submittedHash",
      expectedArgs: { evidenceId: String(item.chain_evidence_id) },
      idempotencyKey: `independent-check:${item.id}:${randomUUID()}`,
      createdBy: user.id,
    });
    const outcome = await sendAnchor(checkAnchor, actorOf(user));
    txHash = outcome.txHash;
    verification = presentVerification(outcome.anchor);
  }

  await db.from("integrity_checks").insert({
    evidence_id: item.id,
    submitted_hash: candidate,
    expected_hash: chainHash,
    matched,
    checked_by: user.id,
    checked_by_role: user.role,
    context: "independent_verification",
    tx_hash: txHash,
  });

  await recordAction(req, {
    action: "evidence.independent_verify",
    subject: item.id,
    caseId: item.case_id,
    outcome: matched ? "ok" : "refused",
    detail: { matched, databaseAgreesWithChain, txHash },
  });

  return {
    matched,
    databaseAgreesWithChain,
    submittedHash,
    anchorMode: item.anchor_mode ?? "file",
    comparedDigest: candidate,
    onChainHash: chainHash,
    onChain: {
      caseId: onChain.caseId,
      collectedAt: onChain.collectedAt,
      // (0, 0) means the coordinates were kept off chain (DECISIONS D-03).
      gpsLat: fromMicroDegrees(onChain.gpsLatE6),
      gpsLng: fromMicroDegrees(onChain.gpsLngE6),
      coordinatesOnChain: onChain.gpsLatE6 !== 0 || onChain.gpsLngE6 !== 0,
      currentStage: onChain.currentStage,
      mismatchCount: onChain.mismatchCount,
      forensicReportHash: onChain.forensicReportHash,
      anomalyFlagHash: onChain.anomalyFlagHash,
      registrar: onChain.registrar,
    },
    anchoredTxHash: txHash,
    anchoring: verification,
    explorer: txHash ? explorerUrl(txHash) : null,
  };
}

/** Custody timeline, read from the chain and annotated with off-chain names. */
export async function custodyTimeline(evidenceId: string) {
  const item = await loadEvidence(evidenceId);

  const offChain = unwrapList(
    await db
      .from("custody_events")
      .select("id, from_stage, to_stage, confirmed_hash, actor_id, actor_role, occurred_at, tx_hash, block_number")
      .eq("evidence_id", item.id)
      .order("occurred_at", { ascending: true })
  ) as any[];

  let onChain: any[] = [];
  let chainReadable = false;
  const reader = chainReader();
  if (item.chain_evidence_id !== null && item.chain_evidence_id !== undefined && reader.ready()) {
    try {
      const raw = await reader.custody(Number(item.chain_evidence_id));
      onChain = raw.map((e) => ({
        fromRole: e.fromStage,
        toRole: e.toStage,
        confirmedHash: e.confirmedHash,
        timestamp: e.timestamp,
      }));
      chainReadable = true;
    } catch (error) {
      logger.warn("Could not read the on-chain custody trail", { evidenceId, error });
    }
  }

  return {
    evidence: item,
    offChain,
    onChain,
    chainReadable,
    // The UI turns a false here into a red banner: the two trails must agree.
    consistent: !chainReadable || onChain.length === offChain.length,
  };
}

/* ------------------------------------------------------------- forensics */

export async function anchorForensicReport(
  req: Request,
  user: SessionUser,
  evidenceId: string,
  conclusion: string,
  detail: string | null
) {
  const item = await loadEvidence(evidenceId);
  if (item.chain_evidence_id === null || item.chain_evidence_id === undefined) {
    throw conflict("This item is not anchored on chain yet.");
  }
  if (item.current_stage !== "FORENSIC_LAB") {
    throw conflict("A report can only be anchored while the item is in the lab's custody.");
  }

  const reportHash = sha256Hex(JSON.stringify({ evidenceId: item.id, fileHash: item.file_hash, conclusion, detail }));

  const { anchor } = await createAnchor({
    purpose: "forensic_report",
    contract: "EvidenceChain",
    method: "anchorForensicResult",
    args: [item.chain_evidence_id, reportHash],
    caseId: item.case_id,
    subjectType: "evidence_item",
    subjectId: item.id,
    parentAnchorId: item.anchor_id ?? null,
    expectedEvent: "ForensicResultAnchored",
    expectedDigest: reportHash,
    digestArg: "reportHash",
    expectedArgs: { evidenceId: String(item.chain_evidence_id) },
    idempotencyKey: `forensic-report:${item.id}:${reportHash}`,
    createdBy: user.id,
  });

  const outcome = await sendAnchor(anchor, actorOf(user));
  if (outcome.error) {
    throw new AppError(outcome.error.status, "REPORT_NOT_ANCHORED", outcome.error.message, {
      verification: presentVerification(outcome.anchor),
    });
  }

  const row = unwrap(
    await db
      .from("forensic_reports")
      .insert({
        evidence_id: item.id,
        case_id: item.case_id,
        lab_id: user.id,
        report_hash: reportHash,
        conclusion,
        detail,
        tx_hash: outcome.txHash,
      })
      .select("*")
      .single()
  );

  await db.from("evidence_items").update({ forensic_report_hash: reportHash }).eq("id", item.id);

  await recordAction(req, {
    action: "evidence.forensic_report",
    subject: item.id,
    caseId: item.case_id,
    detail: { txHash: outcome.txHash, state: outcome.anchor.state },
  });

  return {
    report: row,
    verification: presentVerification(outcome.anchor),
    chain: { txHash: outcome.txHash, explorer: outcome.txHash ? explorerUrl(outcome.txHash) : null },
  };
}

/** Decrypts and streams the original bytes back to an entitled role. */
export async function fetchPlaintext(evidenceId: string) {
  const item = await loadEvidence(evidenceId);
  if (!item.ipfs_cid || !item.encryption_iv || !item.encryption_tag) {
    throw notFound("Stored file for this evidence item");
  }

  const plaintext = await loadDecrypted(item.ipfs_cid, item.encryption_iv, item.encryption_tag);

  // The bytes we just decrypted must still hash to the registered digest.
  const digest = sha256Hex(plaintext);
  return { item, plaintext, digest, intact: digest === item.file_hash };
}

export async function loadEvidence(evidenceId: string) {
  const item = unwrapMaybe(await db.from("evidence_items").select("*").eq("id", evidenceId).maybeSingle()) as any;
  if (!item) throw notFound("Evidence item");
  return item;
}

const LIST_COLUMNS =
  "id, case_id, chain_evidence_id, file_hash, anchored_digest, anchor_mode, source, public_ref, capture_purpose, " +
  "gps_status, gps_accuracy_m, signature_status, clock_skew_flagged, device_time, duration_ms, " +
  "file_name, mime_type, size_bytes, kind, current_stage, " +
  "collected_at, gps_lat, gps_lng, anomaly_flagged, anomaly_score, anomaly_reasons, anomaly_flag_hash, " +
  "forensic_report_hash, mismatch_count, registration_tx_hash, created_at, anchor_id, " +
  "anchors(id, state, tx_hash, block_number, confirmations, required_confirmations, failure_code, failure_reason, submitted_at, confirmed_at, last_checked_at)";

/** Attaches the presented verification block and drops the raw embed. */
function withVerification(row: any) {
  const { anchors, ...rest } = row;
  return { ...rest, verification: presentVerification(anchors) };
}

export async function listCaseEvidence(caseId: string) {
  const rows = unwrapList(
    await db.from("evidence_items").select(LIST_COLUMNS).eq("case_id", caseId).order("collected_at", { ascending: false })
  ) as any[];
  return rows.map(withVerification);
}

export async function verificationFor(item: any) {
  return presentVerification(item.anchor_id ? await loadAnchor(item.anchor_id) : null);
}

/** Items waiting for this role to accept custody. */
export async function inboxFor(role: SessionUser["role"], userId: string) {
  const stage = (Object.entries(STAGE_ROLE).find(([, r]) => r === role) ?? [])[0] as Stage | undefined;
  if (!stage) return [];
  const previous = (Object.entries(NEXT_STAGE).find(([, next]) => next === stage) ?? [])[0] as Stage | undefined;
  if (!previous) return [];

  const assigned = unwrapList(await db.from("case_assignments").select("case_id").eq("user_id", userId)) as {
    case_id: string;
  }[];
  if (assigned.length === 0) return [];

  const rows = unwrapList(
    await db
      .from("evidence_items")
      .select(
        "id, case_id, chain_evidence_id, file_hash, file_name, kind, current_stage, collected_at, " +
          "anomaly_flagged, anomaly_score, anchor_id, cases(case_reference, title), " +
          "anchors(id, state, tx_hash, block_number, confirmations, required_confirmations, failure_code, failure_reason, submitted_at, confirmed_at, last_checked_at)"
      )
      .eq("current_stage", previous)
      .in(
        "case_id",
        assigned.map((a) => a.case_id)
      )
      .order("collected_at", { ascending: true })
  ) as any[];
  return rows.map(withVerification);
}

/**
 * Copies chain ids onto evidence rows whose registration anchor learned them
 * after the request that created it had finished — through the tracker, or a
 * retry from another session.
 */
export async function relinkRegistrations(limit = 200): Promise<number> {
  const rows = unwrapList(
    await db.from("evidence_items").select("id, anchor_id, chain_evidence_id").is("chain_evidence_id", null).limit(limit)
  ) as { id: string; anchor_id: string | null }[];

  let linked = 0;
  for (const row of rows) {
    if (!row.anchor_id) continue;
    const anchor = await loadAnchor(row.anchor_id);
    if (anchor.chain_record_id !== null && anchor.chain_record_id !== undefined) {
      await linkRegistration(row.id, anchor);
      linked++;
    }
  }
  return linked;
}

/**
 * Verification states across every case the user is assigned to (the registry:
 * every case), plus the items that need someone's attention. Feeds the police
 * and prosecution dashboards (F15).
 */
export async function verificationSummary(user: SessionUser) {
  let caseIds: string[] | null = null;
  if (user.role !== "court_admin") {
    caseIds = (unwrapList(await db.from("case_assignments").select("case_id").eq("user_id", user.id)) as { case_id: string }[]).map(
      (a) => a.case_id
    );
    if (caseIds.length === 0) return { counts: emptyCounts(), attention: [], total: 0 };
  }

  let query = db
    .from("evidence_items")
    .select(
      "id, case_id, file_name, kind, source, current_stage, collected_at, public_ref, mismatch_count, anchor_id, cases(case_reference, title), " +
        "anchors(id, state, tx_hash, block_number, confirmations, required_confirmations, failure_code, failure_reason, submitted_at, confirmed_at, last_checked_at)"
    )
    .order("collected_at", { ascending: false })
    .limit(500);
  if (caseIds) query = query.in("case_id", caseIds);
  const rows = (unwrapList(await query) as any[]).map(withVerification);

  const counts = emptyCounts();
  for (const row of rows) counts[row.verification.state as VerificationState] += 1;
  const attention = rows
    .filter((row) => ["SYNC_ERROR", "REVIEW_REQUIRED", "INTEGRITY_MISMATCH"].includes(row.verification.state))
    .slice(0, 25);
  return { counts, attention, total: rows.length, recent: rows.slice(0, 8) };
}

function emptyCounts(): Record<VerificationState, number> {
  return { LOCAL_ONLY: 0, SUBMITTED: 0, CONFIRMED: 0, INTEGRITY_MISMATCH: 0, SYNC_ERROR: 0, REVIEW_REQUIRED: 0 };
}
