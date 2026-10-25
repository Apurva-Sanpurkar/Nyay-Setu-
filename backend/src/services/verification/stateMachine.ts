/**
 * The verification state machine (2.0 · F2). The ONLY place the legal
 * transitions are written down.
 *
 * These are application states describing how far one chain write has got. They
 * are not contract states and the contracts know nothing about them; see
 * docs/VERIFICATION_STATES.md.
 *
 *   LOCAL_ONLY          recorded off chain, nothing sent yet
 *   SUBMITTED           a transaction hash exists; not yet confirmed
 *   CONFIRMED           receipt succeeded, expected event decoded with the expected
 *                       digest and case, and CONFIRMATION_DEPTH blocks on top
 *   SYNC_ERROR          sending failed, the transaction reverted, or it was dropped
 *   REVIEW_REQUIRED     something a person must look at: pending too long, the
 *                       event missing, a reorg after confirmation
 *   INTEGRITY_MISMATCH  a digest that should have matched did not
 *
 * This module is pure: no database, no network. `decide` turns observed facts
 * about a transaction into the transition (or none) that they justify, which is
 * what makes every failure mode testable without a chain.
 */

export const STATES = [
  "LOCAL_ONLY",
  "SUBMITTED",
  "CONFIRMED",
  "INTEGRITY_MISMATCH",
  "SYNC_ERROR",
  "REVIEW_REQUIRED",
] as const;

export type VerificationState = (typeof STATES)[number];

export const TRANSITIONS: Readonly<Record<VerificationState, readonly VerificationState[]>> = {
  LOCAL_ONLY: ["SUBMITTED", "SYNC_ERROR", "INTEGRITY_MISMATCH"],
  SUBMITTED: ["CONFIRMED", "SYNC_ERROR", "REVIEW_REQUIRED", "INTEGRITY_MISMATCH"],
  // A retry sends again; a failure the tracker cannot explain goes to a person.
  SYNC_ERROR: ["SUBMITTED", "REVIEW_REQUIRED"],
  // Confirmed is not forever: a reorg can remove the block, and a later custody
  // or laboratory re-check can find the item no longer matches.
  CONFIRMED: ["REVIEW_REQUIRED", "INTEGRITY_MISMATCH"],
  // A reviewer can re-check against the chain (which still has to prove
  // everything CONFIRMED requires), resubmit, or record that it is a mismatch.
  REVIEW_REQUIRED: ["SUBMITTED", "CONFIRMED", "INTEGRITY_MISMATCH", "SYNC_ERROR"],
  // Leaving a mismatch needs two people (F19); the caller enforces that.
  INTEGRITY_MISMATCH: ["REVIEW_REQUIRED"],
};

export class IllegalTransitionError extends Error {
  readonly code = "ILLEGAL_TRANSITION";
  constructor(readonly from: VerificationState, readonly to: VerificationState) {
    super(`Illegal verification transition ${from} → ${to}.`);
    this.name = "IllegalTransitionError";
  }
}

export function isState(value: unknown): value is VerificationState {
  return typeof value === "string" && (STATES as readonly string[]).includes(value);
}

export function canTransition(from: VerificationState, to: VerificationState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: VerificationState, to: VerificationState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}

/**
 * What it takes to call something CONFIRMED. Passed alongside a transition to
 * CONFIRMED, and checked here, so no caller can reach that state by asking nicely.
 */
export interface ConfirmationProof {
  receiptStatus: 1;
  eventMatched: true;
  digestMatched: true;
  confirmations: number;
  required: number;
  blockHash: string;
}

export function assertConfirmationProof(proof: ConfirmationProof | undefined): void {
  if (
    !proof ||
    proof.receiptStatus !== 1 ||
    proof.eventMatched !== true ||
    proof.digestMatched !== true ||
    !/^0x[0-9a-f]{64}$/i.test(proof.blockHash ?? "") ||
    !(proof.confirmations >= proof.required && proof.required >= 1)
  ) {
    throw new Error("CONFIRMED requires a successful receipt, the expected event with the expected digest, and enough confirmations.");
  }
}

/* ------------------------------------------------------------ decisions */

/** What was observed about one transaction on one look at the chain. */
export interface Observation {
  /** Milliseconds since the transaction was submitted. */
  ageMs: number;
  /** null when the RPC could not answer at all. */
  receipt: null | {
    status: 0 | 1;
    blockNumber: number;
    blockHash: string;
  };
  /** Whether the node still knows the transaction (mempool or mined). null: could not tell. */
  txKnown: boolean | null;
  head: number | null;
  /** Decoding the expected event from the receipt. */
  event: null | {
    found: boolean;
    digestMatches: boolean;
    /** Every other expected argument (case id, evidence id) matched. */
    argsMatch: boolean;
    chainRecordId: number | null;
  };
  /** True when the RPC call itself failed. Never changes state on its own. */
  rpcFailed?: boolean;
}

export interface Policy {
  depth: number;
  pendingTimeoutMs: number;
  droppedAfterMs: number;
}

export interface StoredFacts {
  state: VerificationState;
  blockHash: string | null;
}

export type ReasonCode =
  | "CONFIRMED"
  | "AWAITING_CONFIRMATIONS"
  | "AWAITING_RECEIPT"
  | "REVERTED"
  | "DROPPED"
  | "PENDING_TOO_LONG"
  | "EVENT_MISSING"
  | "EVENT_ARGS_MISMATCH"
  | "EVENT_DIGEST_MISMATCH"
  | "REORGED"
  | "RPC_UNAVAILABLE"
  | "NO_CHANGE";

export interface Decision {
  to: VerificationState | null;
  code: ReasonCode;
  reason: string;
  confirmations: number;
  chainRecordId: number | null;
  blockHash: string | null;
  blockNumber: number | null;
}

const none = (code: ReasonCode, reason: string, extra: Partial<Decision> = {}): Decision => ({
  to: null,
  code,
  reason,
  confirmations: 0,
  chainRecordId: null,
  blockHash: null,
  blockNumber: null,
  ...extra,
});

/**
 * The single rule book for what an observation means. Pure, so it is tested
 * case by case: RPC down, reverted, dropped, pending too long, event missing,
 * wrong digest, not deep enough, deep enough, reorged after confirmation.
 */
export function decide(stored: StoredFacts, seen: Observation, policy: Policy): Decision {
  if (seen.rpcFailed) {
    // An RPC outage says nothing about the transaction. Nothing changes; the
    // next look will try again.
    return none("RPC_UNAVAILABLE", "The chain could not be reached; state unchanged.");
  }

  if (stored.state === "SUBMITTED") {
    if (!seen.receipt) {
      if (seen.txKnown === false && seen.ageMs > policy.droppedAfterMs) {
        return { ...none("DROPPED", "The node no longer knows this transaction; it was dropped."), to: "SYNC_ERROR" };
      }
      if (seen.ageMs > policy.pendingTimeoutMs) {
        return {
          ...none("PENDING_TOO_LONG", `No receipt after ${Math.round(seen.ageMs / 60000)} minutes.`),
          to: "REVIEW_REQUIRED",
        };
      }
      return none("AWAITING_RECEIPT", "Waiting for the transaction to be mined.");
    }

    const base = {
      blockHash: seen.receipt.blockHash,
      blockNumber: seen.receipt.blockNumber,
      confirmations: seen.head === null ? 0 : Math.max(0, seen.head - seen.receipt.blockNumber + 1),
      chainRecordId: seen.event?.chainRecordId ?? null,
    };

    if (seen.receipt.status === 0) {
      return { ...none("REVERTED", "The transaction was mined but reverted; nothing was recorded."), ...base, to: "SYNC_ERROR" };
    }
    if (!seen.event || !seen.event.found) {
      return { ...none("EVENT_MISSING", "The receipt does not contain the expected event."), ...base, to: "REVIEW_REQUIRED" };
    }
    if (!seen.event.digestMatches) {
      return {
        ...none("EVENT_DIGEST_MISMATCH", "The event records a different digest from the one that was sent."),
        ...base,
        to: "INTEGRITY_MISMATCH",
      };
    }
    if (!seen.event.argsMatch) {
      return {
        ...none("EVENT_ARGS_MISMATCH", "The event's case or record does not match what was sent."),
        ...base,
        to: "REVIEW_REQUIRED",
      };
    }
    if (base.confirmations >= policy.depth) {
      return { ...none("CONFIRMED", `Confirmed with ${base.confirmations} blocks.`), ...base, to: "CONFIRMED" };
    }
    return none("AWAITING_CONFIRMATIONS", `${base.confirmations} of ${policy.depth} confirmations.`, base);
  }

  if (stored.state === "CONFIRMED") {
    if (!seen.receipt) {
      return { ...none("REORGED", "The receipt is no longer available; the block may have been reorganised away."), to: "REVIEW_REQUIRED" };
    }
    if (stored.blockHash && seen.receipt.blockHash.toLowerCase() !== stored.blockHash.toLowerCase()) {
      return {
        ...none("REORGED", "The transaction now sits in a different block from the one it was confirmed in."),
        blockHash: seen.receipt.blockHash,
        blockNumber: seen.receipt.blockNumber,
        to: "REVIEW_REQUIRED",
      };
    }
    if (seen.receipt.status === 0) {
      return { ...none("REVERTED", "A confirmed transaction now reports failure."), to: "REVIEW_REQUIRED" };
    }
    return none("NO_CHANGE", "Still confirmed.", {
      confirmations: seen.head === null ? 0 : Math.max(0, seen.head - seen.receipt.blockNumber + 1),
      blockHash: seen.receipt.blockHash,
      blockNumber: seen.receipt.blockNumber,
    });
  }

  return none("NO_CHANGE", `Nothing is tracked automatically in ${stored.state}.`);
}

/** Plain-language label for screens that must never over-claim. */
export const STATE_LABEL: Record<VerificationState, string> = {
  LOCAL_ONLY: "Recorded locally — not yet sent",
  SUBMITTED: "Submitted — awaiting confirmation",
  CONFIRMED: "Confirmed on chain",
  INTEGRITY_MISMATCH: "Integrity mismatch",
  SYNC_ERROR: "Failed to anchor — retry available",
  REVIEW_REQUIRED: "Needs review",
};
