import { Request } from "express";
import { randomUUID } from "crypto";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { badRequest, conflict, notFound, AppError } from "../lib/errors";
import { canonicalHash, sha256Hex } from "../lib/crypto";
import { recordAction } from "./audit";
import { raiseAlert } from "./alerts.service";
import { createAnchor, sendAnchor } from "./verification/anchors";
import { anchorDocument } from "./verification/documentAnchor";
import { digestForChain } from "./capture.service";
import { markIntegrityMismatch, presentVerification, loadEvidence } from "./evidence.service";
import type { SessionUser } from "../middleware/auth";

/**
 * The forensic laboratory (2.0 · F14).
 *
 * An item arriving at the lab is checked twice: its packaging (is the seal
 * intact?) and its bytes (does the laboratory's own re-hash match what the chain
 * holds?). The re-hash is anchored as an integrity check — a transaction that
 * succeeds whether or not it matches — so a mismatch is on chain, not merely
 * refused. A broken seal or a mismatch raises an alert for review; neither
 * decides anything by itself.
 */

export interface IntakeInput {
  sealIntact: boolean;
  sealNotes?: string | null;
  packagingEvidenceIds?: string[];
  conditionNotes?: string | null;
  /** The laboratory's own SHA-256 of the bytes it received. */
  recheckSha256: string;
}

export async function recordIntake(req: Request, user: SessionUser, evidenceId: string, input: IntakeInput) {
  const item = await loadEvidence(evidenceId);
  if (item.current_stage !== "FORENSIC_LAB") {
    throw conflict("Accept custody of the item at the laboratory before recording its intake.");
  }
  if (item.chain_evidence_id === null || item.chain_evidence_id === undefined) {
    throw conflict("This item is not anchored on chain, so a re-check has nothing to compare with.");
  }
  if (!input.sealIntact && !input.sealNotes?.trim()) {
    throw badRequest("Describe the condition of a seal that is not intact.");
  }

  const packaging = input.packagingEvidenceIds ?? [];
  if (packaging.length) {
    const found = unwrapList(await db.from("evidence_items").select("id, case_id").in("id", packaging)) as { id: string; case_id: string }[];
    if (found.length !== packaging.length || found.some((f) => f.case_id !== item.case_id)) {
      throw badRequest("Packaging photographs must be evidence items of the same case.");
    }
  }

  // The re-check: the lab's digest, turned into what the chain holds for this item.
  const chainDigest = digestForChain(item, input.recheckSha256);
  const { anchor } = await createAnchor({
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
    idempotencyKey: `lab-recheck:${item.id}:${randomUUID()}`,
    createdBy: user.id,
  });
  const outcome = await sendAnchor(anchor, { id: user.id, role: user.role });
  if (outcome.error || !outcome.event) {
    throw new AppError(outcome.error?.status ?? 502, "RECHECK_NOT_RECORDED", "The re-check could not be recorded on chain. Nothing was saved; retry.", {
      verification: presentVerification(outcome.anchor),
    });
  }
  const matched = outcome.event.name === "IntegrityVerified";

  await db.from("integrity_checks").insert({
    evidence_id: item.id,
    submitted_hash: chainDigest,
    expected_hash: matched ? chainDigest : String(outcome.event.args.expectedHash ?? item.anchored_digest),
    matched,
    checked_by: user.id,
    checked_by_role: user.role,
    context: "lab_intake_recheck",
    tx_hash: outcome.txHash,
  });

  const intake = unwrap(
    await db
      .from("lab_intakes")
      .insert({
        evidence_id: item.id,
        case_id: item.case_id,
        seal_intact: input.sealIntact,
        seal_notes: input.sealNotes ?? null,
        packaging_evidence_ids: packaging,
        received_by: user.id,
        condition_notes: input.conditionNotes ?? null,
        recheck_digest: input.recheckSha256.toLowerCase(),
        recheck_matched: matched,
        recheck_anchor_id: outcome.anchor.id,
        status: "received",
      })
      .select("*")
      .single()
  ) as any;

  if (!matched) {
    await db.from("evidence_items").update({ mismatch_count: (item.mismatch_count ?? 0) + 1 }).eq("id", item.id);
    await markIntegrityMismatch(item, { id: user.id, role: user.role }, {
      code: "LAB_RECHECK_MISMATCH",
      reason: "The laboratory's re-hash on arrival did not match the anchored digest.",
    });
    await raiseAlert({
      caseId: item.case_id,
      evidenceId: item.id,
      kind: "HASH_MISMATCH",
      severity: "serious",
      explanation: `The laboratory re-hashed ${item.public_ref} on arrival and it did not match the anchored digest. The mismatch is on chain (transaction ${outcome.txHash}).`,
      dedupeKey: `lab-recheck:${intake.id}`,
    });
  }
  if (!input.sealIntact) {
    await raiseAlert({
      caseId: item.case_id,
      evidenceId: item.id,
      kind: "SEAL_BROKEN",
      severity: matched ? "warning" : "serious",
      explanation: `The seal on ${item.public_ref} was not intact on arrival at the laboratory: ${input.sealNotes}. ${matched ? "Its digest still matches." : "Its digest also did not match."}`,
      dedupeKey: `seal:${intake.id}`,
    });
  }

  await recordAction(req, {
    action: "lab.intake",
    subject: item.id,
    caseId: item.case_id,
    outcome: matched && input.sealIntact ? "ok" : "refused",
    detail: { matched, txHash: outcome.txHash, reason: input.sealIntact ? undefined : "seal_broken" },
  });

  return { intake, matched, verification: presentVerification(outcome.anchor), txHash: outcome.txHash };
}

export async function setIntakeStatus(req: Request, user: SessionUser, intakeId: string, status: "in_analysis" | "reported" | "returned") {
  const intake = unwrapMaybe(await db.from("lab_intakes").select("*").eq("id", intakeId).maybeSingle()) as any;
  if (!intake) throw notFound("Lab intake");
  const order = ["received", "in_analysis", "reported", "returned"];
  if (order.indexOf(status) <= order.indexOf(intake.status)) throw conflict(`An intake cannot go from ${intake.status} back to ${status}.`);
  const row = unwrap(
    await db.from("lab_intakes").update({ status, status_changed_at: new Date().toISOString() }).eq("id", intakeId).select("*").single()
  );
  await recordAction(req, { action: "lab.status", subject: intakeId, caseId: intake.case_id, detail: { status } });
  return row;
}

export async function recordWorkingCopy(
  req: Request,
  user: SessionUser,
  evidenceId: string,
  input: { copySha256: string; tool: string; toolVersion: string; method: string; notes?: string | null }
) {
  const item = await loadEvidence(evidenceId);
  const row = unwrap(
    await db
      .from("working_copies")
      .insert({
        original_evidence_id: item.id,
        case_id: item.case_id,
        copy_sha256: input.copySha256.toLowerCase(),
        tool: input.tool,
        tool_version: input.toolVersion,
        method: input.method,
        notes: input.notes ?? null,
        operator_id: user.id,
      })
      .select("*")
      .single()
  ) as any;

  // The derivation itself is anchored: original, copy and how one became the other.
  const digest = canonicalHash({
    original: item.anchored_digest,
    copy: row.copy_sha256,
    tool: input.tool,
    toolVersion: input.toolVersion,
    method: input.method,
  });
  const { anchor } = await anchorDocument({
    caseId: item.case_id,
    digest,
    subjectType: "working_copy",
    subjectId: row.id,
    parentAnchorId: item.anchor_id ?? null,
    idempotencyKey: `working-copy:${row.id}`,
    actor: { id: user.id, role: user.role },
  });
  await recordAction(req, { action: "lab.working_copy", subject: item.id, caseId: item.case_id, detail: { state: anchor.state, txHash: anchor.tx_hash } });
  return { workingCopy: row, derivationDigest: digest, verification: presentVerification(anchor) };
}

/**
 * A forensic report. The first is anchored with anchorForensicResult, which the
 * contract allows once per item; every later version (a correction) is anchored
 * as its own document and linked to the one it supersedes. Nothing is edited:
 * the database refuses updates to forensic_reports.
 */
export async function fileReport(
  req: Request,
  user: SessionUser,
  evidenceId: string,
  input: { conclusion: string; detail?: string | null; analystName: string; tool: string; method: string; supersedesId?: string | null }
) {
  const item = await loadEvidence(evidenceId);
  if (item.current_stage !== "FORENSIC_LAB") throw conflict("A report is filed while the item is in the laboratory's custody.");

  const previous = unwrapList(
    await db.from("forensic_reports").select("id, version").eq("evidence_id", item.id).order("version", { ascending: false })
  ) as { id: string; version: number }[];
  if (previous.length && !input.supersedesId) {
    throw conflict("A report already exists for this item. File a correction that supersedes it, rather than a second original.");
  }
  if (input.supersedesId && previous[0]?.id !== input.supersedesId) {
    throw conflict("A correction must supersede the latest version.");
  }
  const version = (previous[0]?.version ?? 0) + 1;

  const reportHash = sha256Hex(
    JSON.stringify({
      evidenceId: item.id,
      fileHash: item.file_hash,
      version,
      supersedes: input.supersedesId ?? null,
      conclusion: input.conclusion,
      detail: input.detail ?? null,
      analyst: input.analystName,
      tool: input.tool,
      method: input.method,
    })
  );

  let anchorState;
  if (version === 1) {
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
      idempotencyKey: `forensic-report:${item.id}:v1:${reportHash}`,
      createdBy: user.id,
    });
    const outcome = await sendAnchor(anchor, { id: user.id, role: user.role });
    if (outcome.error) throw new AppError(outcome.error.status, "REPORT_NOT_ANCHORED", outcome.error.message);
    anchorState = outcome.anchor;
  } else {
    anchorState = (
      await anchorDocument({
        caseId: item.case_id,
        digest: reportHash,
        subjectType: "forensic_report",
        subjectId: `${item.id}:v${version}`,
        idempotencyKey: `forensic-report:${item.id}:v${version}:${reportHash}`,
        actor: { id: user.id, role: user.role },
      })
    ).anchor;
  }

  const row = unwrap(
    await db
      .from("forensic_reports")
      .insert({
        evidence_id: item.id,
        case_id: item.case_id,
        lab_id: user.id,
        report_hash: reportHash,
        conclusion: input.conclusion,
        detail: input.detail ?? null,
        version,
        supersedes_id: input.supersedesId ?? null,
        analyst_name: input.analystName,
        tool: input.tool,
        method: input.method,
        anchor_id: anchorState.id,
        tx_hash: anchorState.tx_hash,
      })
      .select("*")
      .single()
  );
  await db.from("evidence_items").update({ forensic_report_hash: reportHash }).eq("id", item.id);
  await recordAction(req, { action: "evidence.forensic_report", subject: item.id, caseId: item.case_id, detail: { state: anchorState.state, txHash: anchorState.tx_hash } });
  return { report: row, verification: presentVerification(anchorState) };
}

/** The lab's queue: every item at the laboratory, with intake status and time taken. */
export async function labQueue(user: SessionUser) {
  const caseIds =
    user.role === "court_admin"
      ? null
      : (unwrapList(await db.from("case_assignments").select("case_id").eq("user_id", user.id)) as { case_id: string }[]).map((a) => a.case_id);
  if (caseIds && caseIds.length === 0) return { items: [], turnaround: [] };

  let intakesQuery = db.from("lab_intakes").select("*").order("received_at", { ascending: true }).limit(1000);
  if (caseIds) intakesQuery = intakesQuery.in("case_id", caseIds);
  const intakes = unwrapList(await intakesQuery) as any[];

  let atLab = db.from("evidence_items").select("id, case_id, file_name, public_ref, kind, current_stage, anchor_id, cases(case_reference, title)").in("current_stage", ["SCENE", "FORENSIC_LAB"]);
  if (caseIds) atLab = atLab.in("case_id", caseIds);
  const items = unwrapList(await atLab) as any[];

  const latestIntake = new Map<string, any>();
  for (const i of intakes) latestIntake.set(i.evidence_id, i);

  const queue = items.map((e) => {
    const intake = latestIntake.get(e.id) ?? null;
    const end = intake && (intake.status === "reported" || intake.status === "returned") ? new Date(intake.status_changed_at).getTime() : Date.now();
    return {
      evidence: e,
      queueStatus: e.current_stage === "SCENE" ? "awaiting_custody" : intake ? intake.status : "awaiting_intake",
      intake,
      hoursAtLab: intake ? Math.round(((end - new Date(intake.received_at).getTime()) / 3_600_000) * 10) / 10 : null,
    };
  });

  // Turnaround per case: from intake to report, for every reported item.
  const perCase = new Map<string, number[]>();
  for (const i of intakes) {
    if (i.status !== "reported" && i.status !== "returned") continue;
    const hours = (new Date(i.status_changed_at).getTime() - new Date(i.received_at).getTime()) / 3_600_000;
    perCase.set(i.case_id, [...(perCase.get(i.case_id) ?? []), hours]);
  }
  const turnaround = [...perCase.entries()].map(([caseId, hours]) => ({
    caseId,
    reported: hours.length,
    averageHours: Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10,
  }));
  return { items: queue, turnaround };
}

export async function intakesFor(evidenceId: string) {
  return unwrapList(await db.from("lab_intakes").select("*").eq("evidence_id", evidenceId).order("received_at", { ascending: false }));
}

export async function workingCopiesFor(evidenceId: string) {
  return unwrapList(await db.from("working_copies").select("*").eq("original_evidence_id", evidenceId).order("created_at", { ascending: true }));
}
