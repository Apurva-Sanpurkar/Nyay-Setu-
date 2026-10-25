import { db, unwrapList } from "../../lib/supabase";
import { officerPseudonym, sha256Hex } from "../../lib/crypto";
import { logger } from "../../lib/logger";
import { createAnchor, sendAnchor, type Actor, type AnchorRow } from "../verification/anchors";
import { presentVerification } from "../evidence.service";

/**
 * Anchors a Vehicle Trace or Third Eye record digest on chain.
 *
 * These records do not belong to a single case, so instead of a case's salted
 * key the on-chain "case" field is a key derived from the module and the
 * record's id. Every event of one vehicle report (complaint, discovery, match,
 * handover) therefore shares one key on chain, and the key says nothing about
 * the vehicle, the person or the place. Only the digest is written; the record
 * itself stays encrypted or access-controlled off chain.
 *
 * Same contract call and same verification states as evidence (D-06), so a
 * vehicle handover is "confirmed" by exactly the standard a custody transfer is.
 */
export type SmartModule = "vehicle_trace" | "third_eye";

export function moduleKey(module: SmartModule, recordId: string): string {
  return sha256Hex(`nyaysetu:${module}:${recordId}`);
}

export async function anchorRecord(args: {
  module: SmartModule;
  recordId: string;
  digest: string;
  subjectType: string;
  subjectId: string;
  idempotencyKey: string;
  actor: Actor & { id: string };
}): Promise<{ anchor: AnchorRow; error: string | null }> {
  const key = moduleKey(args.module, args.recordId);
  const { anchor } = await createAnchor({
    purpose: "document",
    contract: "EvidenceChain",
    method: "registerEvidence",
    args: [key, args.digest, 0n, 0n, officerPseudonym(args.actor.id)],
    caseId: null,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    expectedEvent: "EvidenceRegistered",
    expectedDigest: args.digest,
    digestArg: "fileHash",
    expectedArgs: { caseId: key },
    idempotencyKey: args.idempotencyKey,
    createdBy: args.actor.id,
  });
  try {
    const outcome = await sendAnchor(anchor, args.actor);
    return { anchor: outcome.anchor, error: outcome.error?.message ?? null };
  } catch (error) {
    // The record is saved and its anchor stays LOCAL_ONLY, where the sweep picks
    // it up. Losing the officer's report because a node was slow would be worse.
    logger.warn("Could not send a smart-policing anchor; it stays local and will be retried", {
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      error: error instanceof Error ? error.message : error,
    });
    return { anchor, error: error instanceof Error ? error.message : String(error) };
  }
}

/** The latest anchor for each subject, presented for the UI. */
export async function verificationsFor(subjectType: string, subjectIds: string[]) {
  const out = new Map<string, ReturnType<typeof presentVerification> & { digest: string }>();
  if (subjectIds.length === 0) return out;
  const anchors = unwrapList(
    await db.from("anchors").select("*").eq("subject_type", subjectType).in("subject_id", subjectIds).order("created_at", { ascending: true })
  ) as AnchorRow[];
  for (const a of anchors) out.set(a.subject_id, { ...presentVerification(a), digest: a.expected_digest });
  return out;
}

export interface AnchoredDigest {
  digest: string;
  state: string;
}

/** Every digest sent (or queued) for anchoring for one subject, oldest first, with how far it got. */
export async function anchoredDigests(subjectType: string, subjectId: string): Promise<AnchoredDigest[]> {
  const anchors = unwrapList(
    await db.from("anchors").select("expected_digest, state, created_at").eq("subject_type", subjectType).eq("subject_id", subjectId).order("created_at", { ascending: true })
  ) as { expected_digest: string; state: string }[];
  return anchors.map((a) => ({ digest: a.expected_digest, state: a.state }));
}

/**
 * Whether a record is as the application last wrote it.
 *
 *   recomputed   the digest of the row as it reads now
 *   stored       the digest written alongside it
 *   anchored     the digests recorded for the ledger, and how far each got
 *
 * A row edited directly in the database, bypassing the API, fails the first
 * comparison; a stored digest that was edited to hide that fails the second.
 * "Intact" only claims the ledger when the ledger has confirmed the digest.
 */
export function integrityVerdict(recomputed: string, stored: string, anchored: AnchoredDigest[]) {
  const rowMatches = recomputed === stored;
  const anchor = [...anchored].reverse().find((a) => a.digest === stored);
  const confirmed = anchor?.state === "CONFIRMED";
  return {
    intact: rowMatches && Boolean(anchor),
    onChain: rowMatches && confirmed,
    rowMatchesStoredDigest: rowMatches,
    storedDigestWasAnchored: Boolean(anchor),
    anchorState: anchor?.state ?? null,
    recomputedDigest: recomputed,
    storedDigest: stored,
    explanation: !rowMatches
      ? "The record no longer matches the digest written when it was saved. It was changed outside NyaySetu."
      : !anchor
        ? "The record matches its stored digest, but that digest was never recorded for the ledger. Treat it as unverified."
        : confirmed
          ? "The record matches the digest confirmed on the ledger."
          : "The record matches the digest recorded for the ledger, but the ledger has not confirmed it yet. It is tamper-evident here, not yet on chain.",
  };
}

/**
 * Orders a hash-chained timeline by its links rather than by timestamp. Two
 * events written in the same millisecond have equal timestamps, so "the latest"
 * by time is ambiguous; by chain it is not.
 */
export function orderChain<T extends { event_digest: string; previous_digest: string | null }>(rows: T[]): T[] {
  const byPrevious = new Map<string | null, T>();
  for (const row of rows) if (!byPrevious.has(row.previous_digest)) byPrevious.set(row.previous_digest, row);
  const ordered: T[] = [];
  const seen = new Set<string>();
  let next = byPrevious.get(null);
  while (next && !seen.has(next.event_digest)) {
    ordered.push(next);
    seen.add(next.event_digest);
    next = byPrevious.get(next.event_digest);
  }
  // Anything off the chain (which would itself be a finding) is kept, at the end.
  return [...ordered, ...rows.filter((r) => !seen.has(r.event_digest))];
}
