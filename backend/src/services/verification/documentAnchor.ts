import { db, unwrapMaybe } from "../../lib/supabase";
import { notFound } from "../../lib/errors";
import { officerPseudonym } from "../../lib/crypto";
import { createAnchor, sendAnchor, type Actor, type AnchorRow } from "./anchors";

/**
 * Anchors the digest of a document — a malkhana movement, a forensic working
 * copy, a corrected report, a seizure memo — as its own on-chain record
 * (docs/DECISIONS.md D-06). Same contract call as evidence registration, with
 * zeroed coordinates and the case's salted key, so the record binds the digest
 * to the case and to a block time without saying anything else.
 *
 * The anchor moves through the same verification states as evidence, so a
 * movement in the property room is "confirmed" by exactly the same standard as a
 * custody transfer.
 */
export async function anchorDocument(args: {
  caseId: string;
  digest: string;
  subjectType: string;
  subjectId: string;
  parentAnchorId?: string | null;
  idempotencyKey: string;
  actor: Actor & { id: string };
}): Promise<{ anchor: AnchorRow; error: string | null }> {
  const caseRow = unwrapMaybe(await db.from("cases").select("id, case_id_hash").eq("id", args.caseId).maybeSingle()) as
    | { id: string; case_id_hash: string }
    | null;
  if (!caseRow) throw notFound("Case");

  const { anchor } = await createAnchor({
    purpose: "document",
    contract: "EvidenceChain",
    method: "registerEvidence",
    args: [caseRow.case_id_hash, args.digest, 0n, 0n, officerPseudonym(args.actor.id)],
    caseId: caseRow.id,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    parentAnchorId: args.parentAnchorId ?? null,
    expectedEvent: "EvidenceRegistered",
    expectedDigest: args.digest,
    digestArg: "fileHash",
    expectedArgs: { caseId: caseRow.case_id_hash },
    idempotencyKey: args.idempotencyKey,
    createdBy: args.actor.id,
  });
  const outcome = await sendAnchor(anchor, args.actor);
  return { anchor: outcome.anchor, error: outcome.error?.message ?? null };
}
