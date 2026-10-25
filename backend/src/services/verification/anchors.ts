import { db, unwrap, unwrapList, unwrapMaybe } from "../../lib/supabase";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { AppError } from "../../lib/errors";
import {
  chain,
  deserialiseArgs,
  serialiseArgs,
  submit,
  type ContractName,
} from "../../lib/chain";
import {
  assertConfirmationProof,
  canTransition,
  decide,
  IllegalTransitionError,
  type ConfirmationProof,
  type Decision,
  type Observation,
  type ReasonCode,
  type VerificationState,
} from "./stateMachine";
import { ethersProbe, toReceiptView, type ChainProbe, type ReceiptView } from "./probe";

/**
 * Anchors: one row per evidence-related chain write, moved through the state
 * machine by this module and nothing else (2.0 · F2).
 */

export type AnchorPurpose =
  | "evidence_registration"
  | "custody_transfer"
  | "integrity_check"
  | "forensic_report"
  | "anomaly_flag"
  | "document";

export interface AnchorRow {
  id: string;
  purpose: AnchorPurpose;
  contract: ContractName;
  method: string;
  args: unknown[];
  case_id: string | null;
  subject_type: string;
  subject_id: string;
  parent_anchor_id: string | null;
  expected_event: string;
  expected_digest: string;
  digest_arg: string;
  expected_args: Record<string, string>;
  chain_record_id: number | null;
  state: VerificationState;
  tx_hash: string | null;
  block_number: number | null;
  block_hash: string | null;
  confirmations: number;
  required_confirmations: number;
  attempts: number;
  submitted_at: string | null;
  confirmed_at: string | null;
  last_checked_at: string | null;
  failure_code: string | null;
  failure_reason: string | null;
  idempotency_key: string | null;
  created_at: string;
}

export interface AnchorSpec {
  purpose: AnchorPurpose;
  contract: ContractName;
  method: string;
  args: unknown[];
  caseId: string | null;
  subjectType: string;
  subjectId: string;
  parentAnchorId?: string | null;
  expectedEvent: string;
  expectedDigest: string;
  digestArg: string;
  expectedArgs?: Record<string, string>;
  idempotencyKey: string;
  createdBy: string | null;
}

export interface Actor {
  id: string | null;
  role: string | null;
}

export const SYSTEM: Actor = { id: null, role: "system" };

/* --------------------------------------------------------- dependencies */

/** Sends a transaction. The default is the keeper's submit queue. */
export type Sender = (
  contract: ContractName,
  method: string,
  args: unknown[],
  meta: { submittedBy: string | null; onSent: (txHash: string) => Promise<void> }
) => Promise<{ txHash: string; receipt: ReceiptView }>;

const realSender: Sender = async (contract, method, args, meta) => {
  const result = await submit(contract, method, args, {
    submittedBy: meta.submittedBy,
    onSent: meta.onSent,
  });
  return { txHash: result.txHash, receipt: toReceiptView(result.receipt) };
};

let deps: { probe: ChainProbe; sender: Sender; ready: () => boolean } = {
  probe: ethersProbe,
  sender: realSender,
  ready: () => chain.isReady,
};

/**
 * Replaces the chain for tests: a fake probe and sender that can be told to fail
 * in each of the ways a real chain fails. Not used outside the test suite.
 */
export function setVerificationDeps(override: Partial<typeof deps> | null): void {
  deps = override
    ? { ...deps, ...override }
    : { probe: ethersProbe, sender: realSender, ready: () => chain.isReady };
}

export function verificationPolicy() {
  return {
    depth: env.confirmationDepth,
    pendingTimeoutMs: env.PENDING_TIMEOUT_MINUTES * 60_000,
    droppedAfterMs: env.DROPPED_AFTER_MINUTES * 60_000,
  };
}

/* ------------------------------------------------------------- reads */

const COLUMNS = "*";

export async function loadAnchor(id: string): Promise<AnchorRow> {
  const row = unwrapMaybe(await db.from("anchors").select(COLUMNS).eq("id", id).maybeSingle()) as AnchorRow | null;
  if (!row) throw new AppError(404, "NOT_FOUND", "Anchor not found.");
  return row;
}

export async function anchorHistory(anchorId: string) {
  return unwrapList(
    await db
      .from("anchor_state_events")
      .select("from_state, to_state, reason_code, reason, actor_role, occurred_at")
      .eq("anchor_id", anchorId)
      .order("occurred_at", { ascending: true })
  );
}

/* ------------------------------------------------------------ create */

/**
 * Creates an anchor in LOCAL_ONLY, or returns the existing one with the same
 * idempotency key. Calling this twice for the same write never produces two.
 */
export async function createAnchor(spec: AnchorSpec): Promise<{ anchor: AnchorRow; created: boolean }> {
  const existing = unwrapMaybe(
    await db.from("anchors").select(COLUMNS).eq("idempotency_key", spec.idempotencyKey).maybeSingle()
  ) as AnchorRow | null;
  if (existing) return { anchor: existing, created: false };

  const inserted = await db
    .from("anchors")
    .insert({
      purpose: spec.purpose,
      contract: spec.contract,
      method: spec.method,
      args: serialiseArgs(spec.args),
      case_id: spec.caseId,
      subject_type: spec.subjectType,
      subject_id: spec.subjectId,
      parent_anchor_id: spec.parentAnchorId ?? null,
      expected_event: spec.expectedEvent,
      expected_digest: spec.expectedDigest.toLowerCase(),
      digest_arg: spec.digestArg,
      expected_args: spec.expectedArgs ?? {},
      state: "LOCAL_ONLY",
      required_confirmations: env.confirmationDepth,
      idempotency_key: spec.idempotencyKey,
      created_by: spec.createdBy,
    })
    .select(COLUMNS)
    .single();

  // Two requests racing on the same key: the loser reads the winner's row.
  if (inserted.error?.code === "23505") {
    const winner = unwrap(
      await db.from("anchors").select(COLUMNS).eq("idempotency_key", spec.idempotencyKey).single()
    ) as AnchorRow;
    return { anchor: winner, created: false };
  }
  const anchor = unwrap(inserted) as AnchorRow;

  await db.from("anchor_state_events").insert({
    anchor_id: anchor.id,
    from_state: null,
    to_state: "LOCAL_ONLY",
    reason_code: "CREATED",
    reason: `${spec.purpose} recorded off chain.`,
    actor_id: spec.createdBy,
    actor_role: null,
  });
  return { anchor, created: true };
}

/* -------------------------------------------------------- transitions */

/**
 * Moves an anchor to a new state. Refuses anything the transition table does
 * not allow, refuses CONFIRMED without proof, and refuses to overwrite a state
 * that changed underneath it (two workers racing). Every success is appended to
 * anchor_state_events; every refusal is logged.
 */
export async function transition(
  anchor: AnchorRow,
  to: VerificationState,
  args: {
    code: ReasonCode | string;
    reason: string;
    actor?: Actor;
    patch?: Partial<AnchorRow>;
    proof?: ConfirmationProof;
  }
): Promise<AnchorRow> {
  const from = anchor.state;
  if (!canTransition(from, to)) {
    const error = new IllegalTransitionError(from, to);
    logger.warn("Refused an illegal verification transition", { anchorId: anchor.id, from, to, code: args.code });
    await db.from("action_log").insert({
      actor_id: args.actor?.id ?? null,
      actor_role: args.actor?.role && args.actor.role !== "system" ? args.actor.role : null,
      action: "verification.illegal_transition",
      subject: anchor.id,
      case_id: anchor.case_id,
      outcome: "refused",
      detail: { from, to, code: args.code },
    });
    throw new AppError(409, "ILLEGAL_TRANSITION", error.message, { from, to });
  }
  if (to === "CONFIRMED") assertConfirmationProof(args.proof);

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    ...(args.patch ?? {}),
    state: to,
    last_checked_at: now,
  };
  if (to === "CONFIRMED") {
    patch.confirmed_at = now;
    patch.failure_code = null;
    patch.failure_reason = null;
  }
  if (to === "SYNC_ERROR" || to === "REVIEW_REQUIRED" || to === "INTEGRITY_MISMATCH") {
    patch.failure_code = args.code;
    patch.failure_reason = args.reason;
  }

  const updated = unwrapList(
    await db.from("anchors").update(patch).eq("id", anchor.id).eq("state", from).select(COLUMNS)
  ) as AnchorRow[];

  if (updated.length === 0) {
    // Someone else moved it first — usually the tracker confirming the same
    // transaction this request was confirming. If they reached the same state,
    // that is agreement, not a conflict.
    const current = await loadAnchor(anchor.id);
    if (current.state === to) return current;
    throw new AppError(409, "STATE_CHANGED", "This record changed state while the update was in progress. Reload and retry.");
  }

  await db.from("anchor_state_events").insert({
    anchor_id: anchor.id,
    from_state: from,
    to_state: to,
    reason_code: args.code,
    reason: args.reason,
    actor_id: args.actor?.id ?? null,
    actor_role: args.actor?.role ?? null,
  });

  logger.info("Verification state changed", { anchorId: anchor.id, purpose: anchor.purpose, from, to, code: args.code });
  return updated[0];
}

/* ---------------------------------------------------------- observing */

function argMatches(actual: unknown, expected: string): boolean {
  return String(actual ?? "").toLowerCase() === String(expected).toLowerCase();
}

/** Builds an Observation for `decide` from what the probe can see. */
export async function observe(anchor: AnchorRow, probe: ChainProbe = deps.probe, known?: ReceiptView | null): Promise<Observation> {
  const ageMs = anchor.submitted_at ? Date.now() - new Date(anchor.submitted_at).getTime() : 0;
  if (!anchor.tx_hash) {
    return { ageMs, receipt: null, txKnown: false, head: null, event: null };
  }

  try {
    const receipt = known ?? (await probe.receipt(anchor.tx_hash));
    const head = await probe.head();
    const txKnown = receipt ? true : await probe.txKnown(anchor.tx_hash);

    let event: Observation["event"] = null;
    if (receipt && receipt.status === 1) {
      const names = anchor.expected_event.split("|");
      const found = probe.events(receipt, anchor.contract, names);
      if (found.length === 0) {
        event = { found: false, digestMatches: false, argsMatch: false, chainRecordId: null };
      } else {
        const first = found[0];
        const digestKeys = anchor.digest_arg.split("|");
        const digest = digestKeys.map((k) => first.args[k]).find((v) => v !== undefined);
        const argsMatch = Object.entries(anchor.expected_args ?? {}).every(([k, v]) => argMatches(first.args[k], v));
        const record = first.args.evidenceId ?? first.args.evidenceID ?? null;
        event = {
          found: true,
          digestMatches: argMatches(digest, anchor.expected_digest),
          argsMatch,
          chainRecordId: record === null || record === undefined ? null : Number(record),
        };
      }
    }

    return {
      ageMs,
      receipt: receipt ? { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash } : null,
      txKnown,
      head,
      event,
    };
  } catch (error) {
    logger.warn("Could not observe an anchor's transaction", {
      anchorId: anchor.id,
      error: error instanceof Error ? error.message : error,
    });
    return { ageMs, receipt: null, txKnown: null, head: null, event: null, rpcFailed: true };
  }
}

/** Applies a decision: a transition if there is one, otherwise a progress update. */
export async function applyDecision(anchor: AnchorRow, decision: Decision, actor: Actor = SYSTEM): Promise<AnchorRow> {
  const progress: Partial<AnchorRow> = {
    confirmations: decision.confirmations,
    ...(decision.blockNumber !== null ? { block_number: decision.blockNumber } : {}),
    ...(decision.blockHash !== null ? { block_hash: decision.blockHash } : {}),
    ...(decision.chainRecordId !== null ? { chain_record_id: decision.chainRecordId } : {}),
  };

  if (!decision.to) {
    if (decision.code === "RPC_UNAVAILABLE") {
      await db.from("anchors").update({ last_checked_at: new Date().toISOString() }).eq("id", anchor.id);
      return anchor;
    }
    const updated = unwrapList(
      await db
        .from("anchors")
        .update({ ...progress, last_checked_at: new Date().toISOString() })
        .eq("id", anchor.id)
        .select(COLUMNS)
    ) as AnchorRow[];
    return updated[0] ?? anchor;
  }

  const proof: ConfirmationProof | undefined =
    decision.to === "CONFIRMED"
      ? {
          receiptStatus: 1,
          eventMatched: true,
          digestMatched: true,
          confirmations: decision.confirmations,
          required: anchor.required_confirmations,
          blockHash: decision.blockHash ?? "",
        }
      : undefined;

  return transition(anchor, decision.to, {
    code: decision.code,
    reason: decision.reason,
    actor,
    patch: progress,
    proof,
  });
}

/** Looks at the chain once and moves the anchor if what it sees justifies it. */
export async function recheck(anchor: AnchorRow, actor: Actor = SYSTEM, known?: ReceiptView | null): Promise<AnchorRow> {
  const seen = await observe(anchor, deps.probe, known);
  const decision = decide(
    { state: anchor.state, blockHash: anchor.block_hash },
    seen,
    { ...verificationPolicy(), depth: anchor.required_confirmations }
  );
  return applyDecision(anchor, decision, actor);
}

/* ------------------------------------------------------------ sending */

export interface SendOutcome {
  anchor: AnchorRow;
  /** Decoded event, when the receipt contained one of the expected events. */
  event: { name: string; args: Record<string, unknown> } | null;
  txHash: string | null;
  error: AppError | null;
}

function classify(error: unknown): { code: string; reason: string; appError: AppError } {
  const appError =
    error instanceof AppError ? error : new AppError(502, "CHAIN_ERROR", error instanceof Error ? error.message : "Chain call failed.");
  if (appError.code === "UNAVAILABLE") return { code: "RPC_UNAVAILABLE", reason: appError.message, appError };
  if (appError.code === "CHAIN_REVERTED") return { code: "REVERTED", reason: appError.message, appError };
  if (appError.code.startsWith("CHAIN_")) return { code: "CONTRACT_REJECTED", reason: appError.message, appError };
  return { code: "SEND_FAILED", reason: appError.message, appError };
}

/**
 * Sends the anchor's transaction and moves it as far as the receipt allows.
 *
 * Never throws for a chain failure: the anchor goes to SYNC_ERROR with the reason,
 * and the caller decides what to tell the user. The record off chain is already
 * safe, which is the whole point of recording it first.
 */
export async function sendAnchor(anchor: AnchorRow, actor: Actor): Promise<SendOutcome> {
  if (anchor.state === "SUBMITTED" || anchor.state === "CONFIRMED") {
    // A duplicate submit: the transaction already exists. Do not send another.
    return { anchor, event: null, txHash: anchor.tx_hash, error: null };
  }
  if (!["LOCAL_ONLY", "SYNC_ERROR", "REVIEW_REQUIRED"].includes(anchor.state)) {
    throw new AppError(409, "NOT_SENDABLE", `An anchor in ${anchor.state} cannot be sent.`);
  }

  // A retry of something that was once submitted: if that transaction did land,
  // sending again would put a second record on chain. Look before resending.
  if (anchor.tx_hash && anchor.state !== "LOCAL_ONLY") {
    try {
      const prior = await deps.probe.receipt(anchor.tx_hash);
      if (prior) {
        const moved = await transition(anchor, "SUBMITTED", {
          code: "PRIOR_TX_FOUND",
          reason: "The earlier transaction was mined after all; tracking it instead of resending.",
          actor,
        });
        return { anchor: await recheck(moved, actor, prior), event: null, txHash: anchor.tx_hash, error: null };
      }
    } catch {
      // Cannot tell. Refuse to guess: a duplicate on chain is worse than a delay.
      const error = new AppError(503, "UNAVAILABLE", "Could not check whether the earlier transaction landed. Retry when the chain is reachable.");
      return { anchor, event: null, txHash: anchor.tx_hash, error };
    }
  }

  let current = anchor;
  await db.from("anchors").update({ attempts: anchor.attempts + 1 }).eq("id", anchor.id);
  current = { ...current, attempts: anchor.attempts + 1 };

  if (!deps.ready()) {
    const reason = `Blockchain unavailable: ${chain.reason}`;
    if (current.state !== "SYNC_ERROR") {
      current = await transition(current, "SYNC_ERROR", { code: "RPC_UNAVAILABLE", reason, actor });
    }
    return { anchor: current, event: null, txHash: null, error: new AppError(503, "UNAVAILABLE", reason) };
  }

  try {
    const { txHash, receipt } = await deps.sender(current.contract, current.method, deserialiseArgs(current.args as unknown[]), {
      submittedBy: actor.id,
      onSent: async (hash) => {
        current = await transition(current, "SUBMITTED", {
          code: "SENT",
          reason: "The node accepted the transaction.",
          actor,
          patch: { tx_hash: hash, submitted_at: new Date().toISOString() },
        });
      },
    });

    const names = current.expected_event.split("|");
    const events = deps.probe.events(receipt, current.contract, names);
    current = await recheck(current, actor, receipt);
    return { anchor: current, event: events[0] ?? null, txHash, error: null };
  } catch (error) {
    // Sent but not mined in time: it stays SUBMITTED and the tracker takes over.
    if (error instanceof AppError && error.code === "CHAIN_PENDING") {
      const latest = await loadAnchor(current.id);
      return { anchor: latest, event: null, txHash: latest.tx_hash, error: null };
    }
    const { code, reason, appError } = classify(error);
    // Reload: onSent may have moved it to SUBMITTED before the failure.
    const latest = await loadAnchor(current.id);
    // The tracker may have confirmed it meanwhile; a late local error must not
    // drag a confirmed anchor backwards.
    if (latest.state === "CONFIRMED") return { anchor: latest, event: null, txHash: latest.tx_hash, error: null };
    if (latest.state !== "SYNC_ERROR") {
      current = await transition(latest, "SYNC_ERROR", { code, reason, actor });
    } else {
      await db.from("anchors").update({ failure_code: code, failure_reason: reason }).eq("id", latest.id);
      current = { ...latest, failure_code: code, failure_reason: reason };
    }
    return { anchor: current, event: null, txHash: latest.tx_hash, error: appError };
  }
}

/* ------------------------------------------------------------- tracker */

/**
 * One pass of the tracker: every SUBMITTED anchor, and every anchor confirmed
 * within REORG_WATCH_MINUTES, is looked at once. Run by the scheduler.
 */
export async function trackAnchors(limit = 100): Promise<{ checked: number; changed: number }> {
  if (!deps.ready()) return { checked: 0, changed: 0 };

  const submitted = unwrapList(
    await db.from("anchors").select(COLUMNS).eq("state", "SUBMITTED").order("submitted_at", { ascending: true }).limit(limit)
  ) as AnchorRow[];

  const watchSince = new Date(Date.now() - env.REORG_WATCH_MINUTES * 60_000).toISOString();
  const recent = unwrapList(
    await db.from("anchors").select(COLUMNS).eq("state", "CONFIRMED").gte("confirmed_at", watchSince).limit(limit)
  ) as AnchorRow[];

  let changed = 0;
  for (const anchor of [...submitted, ...recent]) {
    try {
      const after = await recheck(anchor);
      if (after.state !== anchor.state) changed++;
    } catch (error) {
      logger.warn("Tracker could not update an anchor", {
        anchorId: anchor.id,
        error: error instanceof Error ? error.message : error,
      });
    }
  }
  return { checked: submitted.length + recent.length, changed };
}
