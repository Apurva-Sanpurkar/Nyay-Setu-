import type { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { conflict } from "../lib/errors";
import { logger } from "../lib/logger";
import { ocrImage, proofProblem } from "../lib/ai";
import type { SessionUser } from "../middleware/auth";
import { recordAction } from "./audit";
import { fetchPlaintext, presentVerification } from "./evidence.service";
import { anchorDocument } from "./verification/documentAnchor";
import { loadAnchor } from "./verification/anchors";

/**
 * Evidence OCR (015): the text in a photographed or scanned item, with proof.
 *
 * The order is what makes the result worth anything in court:
 *
 *   1. the stored ciphertext is decrypted and must still hash to the
 *      registered digest — a damaged or substituted file is never read;
 *   2. the bytes go to the OCR service with that digest, and the service
 *      refuses to read anything else;
 *   3. the proof that comes back is re-checked here — input digest, text
 *      digest, and resultDigest recomputed over the canonical proof — rather
 *      than taken on the service's word;
 *   4. resultDigest is anchored on chain as a document of the item's case.
 *
 * Reading the same file again with the same pipeline gives the same digest, so
 * a repeat is answered with the stored reading instead of a second anchor.
 */

const OCR_KINDS = new Set(["photo", "document", "physical"]);
const IMAGE_TYPES = /^image\/(jpeg|png|webp|tiff|bmp)$/i;

export function canOcr(item: { kind: string; mime_type?: string | null }) {
  return OCR_KINDS.has(item.kind) && IMAGE_TYPES.test(item.mime_type ?? "");
}

function present(row: any, anchor: any) {
  return {
    id: row.id,
    evidenceId: row.evidence_id,
    mode: row.mode,
    lang: row.lang,
    text: row.extracted_text,
    confidence: row.confidence_pct / 100,
    variant: row.variant,
    psm: row.psm,
    improvement: row.improvement ?? null,
    durationMs: row.duration_ms ?? null,
    proof: row.proof,
    resultDigest: row.result_digest,
    createdAt: row.created_at,
    createdBy: row.created_by,
    verification: presentVerification(anchor),
  };
}

export async function runEvidenceOcr(req: Request, user: SessionUser, evidenceId: string, options: { lang?: string } = {}) {
  const { item, plaintext, digest, intact } = await fetchPlaintext(evidenceId);
  if (!canOcr(item)) {
    throw conflict("OCR reads photographs and scanned documents (JPEG, PNG, WebP, TIFF or BMP). This item is not one.");
  }
  if (!intact) {
    await recordAction(req, { action: "evidence.ocr", subject: item.id, caseId: item.case_id, outcome: "refused", detail: { reason: "stored_file_mismatch", digest } });
    throw conflict("The stored file no longer hashes to the registered digest, so it was not read. Raise an integrity check on this item.");
  }

  const lang = options.lang ?? "eng";
  const result = await ocrImage(plaintext, "document", { expectedSha256: item.file_hash, lang });
  const problem = proofProblem(result, item.file_hash);
  if (problem) {
    await recordAction(req, { action: "evidence.ocr", subject: item.id, caseId: item.case_id, outcome: "refused", detail: { reason: "proof_invalid", problem } });
    throw conflict(`The OCR result was discarded: ${problem}`);
  }
  const proof = result.proof;

  const prior = unwrapMaybe(
    await db.from("evidence_ocr").select("*").eq("evidence_id", item.id).eq("result_digest", proof.resultDigest).maybeSingle()
  ) as any;
  if (prior) {
    const anchor = prior.anchor_id ? await loadAnchor(prior.anchor_id).catch(() => null) : null;
    return { reading: present(prior, anchor), replayed: true };
  }

  const inserted = await db
    .from("evidence_ocr")
    .insert({
      evidence_id: item.id,
      case_id: item.case_id,
      mode: "document",
      lang,
      input_sha256: proof.inputSha256,
      preprocessed_sha256: proof.preprocessedSha256,
      text_sha256: proof.textSha256,
      result_digest: proof.resultDigest,
      extracted_text: result.text,
      confidence_pct: Math.max(0, Math.min(100, Math.round(proof.confidencePct))),
      variant: result.variant,
      psm: result.psm,
      engine: proof.engine,
      pipeline: proof.pipeline,
      proof,
      improvement: result.improvement ?? null,
      duration_ms: typeof result.durationMs === "number" ? Math.round(result.durationMs) : null,
      created_by: user.id,
    })
    .select("*")
    .single();
  if (inserted.error?.code === "23505") {
    // A concurrent read of the same file won the race; return its row.
    const winner = unwrap(await db.from("evidence_ocr").select("*").eq("evidence_id", item.id).eq("result_digest", proof.resultDigest).single()) as any;
    return { reading: present(winner, null), replayed: true };
  }
  const row = unwrap(inserted) as any;

  // On chain, so the reading cannot be edited later without the record disagreeing.
  const { anchor, error } = await anchorDocument({
    caseId: item.case_id,
    digest: proof.resultDigest,
    subjectType: "evidence_ocr",
    subjectId: row.id,
    parentAnchorId: item.anchor_id ?? null,
    idempotencyKey: `evidence_ocr:${row.id}`,
    actor: { id: user.id, role: user.role },
  });
  await db.from("evidence_ocr").update({ anchor_id: anchor.id }).eq("id", row.id);
  if (error) logger.warn("OCR reading stored but not yet anchored", { readingId: row.id, error });

  await recordAction(req, {
    action: "evidence.ocr",
    subject: item.id,
    caseId: item.case_id,
    outcome: "ok",
    detail: { readingId: row.id, resultDigest: proof.resultDigest, confidencePct: row.confidence_pct, variant: result.variant, anchorState: anchor.state },
  });

  return { reading: present({ ...row, anchor_id: anchor.id }, anchor), replayed: false };
}

export async function listEvidenceOcr(evidenceId: string) {
  const rows = unwrapList(
    await db.from("evidence_ocr").select("*").eq("evidence_id", evidenceId).order("created_at", { ascending: false })
  ) as any[];
  const anchors = await Promise.all(rows.map((r) => (r.anchor_id ? loadAnchor(r.anchor_id).catch(() => null) : null)));
  return rows.map((row, i) => present(row, anchors[i]));
}
