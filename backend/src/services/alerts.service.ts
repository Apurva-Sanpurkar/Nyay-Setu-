import { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { env } from "../config/env";
import { logger } from "../lib/logger";
import { conflict, forbidden, notFound } from "../lib/errors";
import { chain, explorerUrl, headBlock } from "../lib/chain";
import { recordAction } from "./audit";
import { caseActivity } from "./case.service";
import type { SessionUser, UserRole } from "../middleware/auth";

/**
 * The Justice Audit Trail and discrepancy alerts (2.0 · F4).
 *
 * An alert says that something could not be verified, why, in plain words, and
 * what a person should look at. It never changes a case, a bail order or an
 * item's standing by itself: acknowledging and resolving are human acts, and a
 * resolution must say why. That rule is in the database too
 * (resolution_has_reason).
 */

export type AlertKind =
  | "MISSING_CONFIRMATION"
  | "DELAYED_TX"
  | "HASH_MISMATCH"
  | "INDEXER_LAG"
  | "SYNC_FAILED"
  | "SEAL_BROKEN"
  | "CUSTODY_GAP"
  | "RECORD_CHAIN_DISAGREE"
  | "SIGNATURE_INVALID"
  | "CLOCK_SKEW";

export type Severity = "info" | "warning" | "serious";

export const ALERT_READERS: UserRole[] = ["police", "forensic_lab", "prosecutor", "judge", "defence_lawyer", "court_admin"];
export const ALERT_HANDLERS: UserRole[] = ["police", "forensic_lab", "prosecutor", "judge", "court_admin"];

/** Raises an alert once per dedupe key. A second detection of the same thing is not a second alert. */
export async function raiseAlert(input: {
  caseId: string | null;
  evidenceId?: string | null;
  kind: AlertKind;
  severity: Severity;
  explanation: string;
  dedupeKey: string;
}): Promise<{ created: boolean }> {
  const existing = unwrapMaybe(await db.from("discrepancy_alerts").select("id").eq("dedupe_key", input.dedupeKey).maybeSingle());
  if (existing) return { created: false };
  const inserted = await db.from("discrepancy_alerts").insert({
    case_id: input.caseId,
    evidence_id: input.evidenceId ?? null,
    kind: input.kind,
    severity: input.severity,
    explanation: input.explanation,
    dedupe_key: input.dedupeKey,
    status: "open",
  });
  if (inserted.error?.code === "23505") return { created: false };
  if (inserted.error) throw inserted.error;
  logger.warn("Discrepancy alert raised", { kind: input.kind, caseId: input.caseId, evidenceId: input.evidenceId });
  return { created: true };
}

async function scopeCaseIds(user: SessionUser): Promise<string[] | null> {
  if (user.role === "court_admin") return null;
  return (unwrapList(await db.from("case_assignments").select("case_id").eq("user_id", user.id)) as { case_id: string }[]).map((a) => a.case_id);
}

export async function listAlerts(user: SessionUser, filters: { caseId?: string; status?: string; kind?: string }) {
  if (!ALERT_READERS.includes(user.role)) throw forbidden("Alerts are not available to your role.");
  const scope = await scopeCaseIds(user);
  if (filters.caseId && scope && !scope.includes(filters.caseId)) throw forbidden("You are not assigned to this case.");

  let query = db
    .from("discrepancy_alerts")
    .select("id, case_id, evidence_id, kind, severity, explanation, status, detected_at, acknowledged_at, resolved_at, resolution, cases(case_reference, title)")
    .order("detected_at", { ascending: false })
    .limit(300);
  if (filters.caseId) query = query.eq("case_id", filters.caseId);
  else if (scope) {
    if (scope.length === 0) return [];
    query = query.in("case_id", scope);
  }
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.kind) query = query.eq("kind", filters.kind);
  return unwrapList(await query) as any[];
}

async function loadAlertFor(user: SessionUser, alertId: string) {
  const alert = unwrapMaybe(await db.from("discrepancy_alerts").select("*").eq("id", alertId).maybeSingle()) as any;
  if (!alert) throw notFound("Alert");
  const scope = await scopeCaseIds(user);
  if (scope && (!alert.case_id || !scope.includes(alert.case_id))) throw forbidden("You are not assigned to this alert's case.");
  return alert;
}

export async function acknowledgeAlert(req: Request, user: SessionUser, alertId: string) {
  const alert = await loadAlertFor(user, alertId);
  if (alert.status !== "open") throw conflict(`This alert is already ${alert.status}.`);
  const row = unwrap(
    await db
      .from("discrepancy_alerts")
      .update({ status: "acknowledged", acknowledged_by: user.id, acknowledged_at: new Date().toISOString() })
      .eq("id", alertId)
      .eq("status", "open")
      .select("*")
      .single()
  );
  await recordAction(req, { action: "alert.acknowledge", subject: alertId, caseId: alert.case_id, detail: { reason: alert.kind } });
  return row;
}

export async function commentOnAlert(req: Request, user: SessionUser, alertId: string, body: string) {
  const alert = await loadAlertFor(user, alertId);
  const row = unwrap(
    await db.from("alert_comments").insert({ alert_id: alertId, author_id: user.id, author_role: user.role, body }).select("*").single()
  );
  await recordAction(req, { action: "alert.comment", subject: alertId, caseId: alert.case_id });
  return row;
}

export async function resolveAlert(req: Request, user: SessionUser, alertId: string, resolution: string) {
  const alert = await loadAlertFor(user, alertId);
  if (alert.status === "resolved") throw conflict("This alert is already resolved.");
  const row = unwrap(
    await db
      .from("discrepancy_alerts")
      .update({
        status: "resolved",
        resolved_by: user.id,
        resolved_at: new Date().toISOString(),
        resolution,
        ...(alert.acknowledged_at ? {} : { acknowledged_by: user.id, acknowledged_at: new Date().toISOString() }),
      })
      .eq("id", alertId)
      .select("*")
      .single()
  );
  await recordAction(req, { action: "alert.resolve", subject: alertId, caseId: alert.case_id, detail: { reason: alert.kind } });
  return row;
}

export async function alertDetail(user: SessionUser, alertId: string) {
  const alert = await loadAlertFor(user, alertId);
  const comments = unwrapList(
    await db.from("alert_comments").select("id, author_role, body, created_at").eq("alert_id", alertId).order("created_at", { ascending: true })
  );
  return { alert, comments };
}

/* ---------------------------------------------------------- detection */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/**
 * One pass of the discrepancy detector. Idempotent: every alert carries a dedupe
 * key, so running it every sweep raises each problem once.
 */
export async function detectDiscrepancies(): Promise<{ raised: number }> {
  let raised = 0;
  const count = async (input: Parameters<typeof raiseAlert>[0]) => {
    if ((await raiseAlert(input)).created) raised++;
  };

  // Anchors in trouble.
  const troubled = unwrapList(
    await db
      .from("anchors")
      .select("id, case_id, subject_type, subject_id, purpose, state, failure_code, failure_reason, submitted_at, tx_hash")
      .in("state", ["SYNC_ERROR", "REVIEW_REQUIRED", "INTEGRITY_MISMATCH"])
      .limit(500)
  ) as any[];
  for (const a of troubled) {
    const evidenceId = a.subject_type === "evidence_item" ? a.subject_id : null;
    if (a.state === "SYNC_ERROR") {
      await count({
        caseId: a.case_id,
        evidenceId,
        kind: "SYNC_FAILED",
        severity: "warning",
        explanation: `A ${a.purpose.replace(/_/g, " ")} could not be written to the blockchain (${a.failure_code ?? "unknown"}): ${a.failure_reason ?? "no detail"}. The record is safe off chain; it is not verified until it is anchored.`,
        dedupeKey: `sync:${a.id}`,
      });
    } else if (a.state === "REVIEW_REQUIRED") {
      await count({
        caseId: a.case_id,
        evidenceId,
        kind: "MISSING_CONFIRMATION",
        severity: a.failure_code === "REORGED" ? "serious" : "warning",
        explanation: `A ${a.purpose.replace(/_/g, " ")} could not be confirmed automatically (${a.failure_code}): ${a.failure_reason ?? ""}`,
        dedupeKey: `review:${a.id}:${a.failure_code}`,
      });
    } else {
      await count({
        caseId: a.case_id,
        evidenceId,
        kind: "HASH_MISMATCH",
        severity: "serious",
        explanation: `A digest that should have matched did not (${a.failure_code}). ${a.failure_reason ?? ""} This is recorded for review; it is not by itself a finding against anyone.`,
        dedupeKey: `mismatch:${a.id}`,
      });
    }
  }

  // Transactions taking longer than they should.
  const slow = unwrapList(
    await db.from("anchors").select("id, case_id, subject_type, subject_id, purpose, tx_hash").eq("state", "SUBMITTED").lt("submitted_at", minutesAgo(env.DELAYED_TX_MINUTES)).limit(200)
  ) as any[];
  for (const a of slow) {
    await count({
      caseId: a.case_id,
      evidenceId: a.subject_type === "evidence_item" ? a.subject_id : null,
      kind: "DELAYED_TX",
      severity: "info",
      explanation: `A ${a.purpose.replace(/_/g, " ")} was sent more than ${env.DELAYED_TX_MINUTES} minutes ago and is still not confirmed. Transaction ${a.tx_hash}.`,
      dedupeKey: `delayed:${a.id}`,
    });
  }

  // Capture quality the court should see.
  const quality = unwrapList(
    await db
      .from("evidence_items")
      .select("id, case_id, public_ref, signature_status, clock_skew_flagged, clock_skew_seconds")
      .order("created_at", { ascending: false })
      .limit(2000)
  ) as any[];
  for (const e of quality) {
    if (e.signature_status === "invalid") {
      await count({
        caseId: e.case_id,
        evidenceId: e.id,
        kind: "SIGNATURE_INVALID",
        severity: "warning",
        explanation: `Item ${e.public_ref} arrived with a device signature that did not verify. Its digest is anchored either way; the signature shows whether the manifest came from a registered install of the app.`,
        dedupeKey: `signature:${e.id}`,
      });
    }
    if (e.clock_skew_flagged) {
      await count({
        caseId: e.case_id,
        evidenceId: e.id,
        kind: "CLOCK_SKEW",
        severity: "info",
        explanation: `The capturing device's clock for ${e.public_ref} differed from the server's by ${e.clock_skew_seconds ?? "an unknown number of"} seconds. The device time in its manifest should be read with that in mind.`,
        dedupeKey: `skew:${e.id}`,
      });
    }
  }

  // Custody gaps: an item sitting at a stage with no transfer and no malkhana entry for too long.
  const gapBefore = new Date(Date.now() - env.CUSTODY_GAP_HOURS * 3_600_000).toISOString();
  const waiting = unwrapList(
    await db.from("evidence_items").select("id, case_id, public_ref, current_stage, created_at, disposed_at").neq("current_stage", "COURT").lt("created_at", gapBefore).limit(2000)
  ) as any[];
  for (const e of waiting) {
    if (e.disposed_at) continue;
    const lastCustody = unwrapList(
      await db.from("custody_events").select("occurred_at").eq("evidence_id", e.id).order("occurred_at", { ascending: false }).limit(1)
    ) as { occurred_at: string }[];
    const lastMove = unwrapList(
      await db.from("malkhana_movements").select("occurred_at").eq("evidence_id", e.id).order("occurred_at", { ascending: false }).limit(1)
    ) as { occurred_at: string }[];
    const latest = [lastCustody[0]?.occurred_at, lastMove[0]?.occurred_at, e.created_at].filter(Boolean).sort().at(-1)!;
    if (latest < gapBefore) {
      const hours = Math.floor((Date.now() - new Date(latest).getTime()) / 3_600_000);
      await count({
        caseId: e.case_id,
        evidenceId: e.id,
        kind: "CUSTODY_GAP",
        severity: "warning",
        explanation: `Item ${e.public_ref} has been at ${e.current_stage} for ${hours} hours with no custody transfer and no malkhana entry. That may be entirely proper; it is unexplained in the record.`,
        dedupeKey: `gap:${e.id}:${e.current_stage}:${latest}`,
      });
    }
  }

  // The indexer falling behind the chain.
  if (chain.isReady) {
    const head = await headBlock();
    const cursors = unwrapList(await db.from("indexer_state").select("contract, last_block")) as { contract: string; last_block: number }[];
    for (const cursor of cursors) {
      if (head !== null && head - Number(cursor.last_block) > env.INDEXER_LAG_BLOCKS) {
        await count({
          caseId: null,
          kind: "INDEXER_LAG",
          severity: "info",
          explanation: `The event index for ${cursor.contract} is ${head - Number(cursor.last_block)} blocks behind the chain. Timelines may be missing recent chain events; the chain itself is unaffected.`,
          dedupeKey: `indexer:${cursor.contract}:${Math.floor(Date.now() / 3_600_000)}`,
        });
      }
    }
  }

  return { raised };
}

/* ----------------------------------------------------------- timeline */

export type TrustLabel = "VERIFIED_ON_CHAIN" | "DB_ONLY" | "CHAIN_ONLY" | "MISMATCH" | "PENDING";

const ANCHOR_LABEL: Record<string, TrustLabel> = {
  CONFIRMED: "VERIFIED_ON_CHAIN",
  SUBMITTED: "PENDING",
  LOCAL_ONLY: "PENDING",
  SYNC_ERROR: "PENDING",
  REVIEW_REQUIRED: "PENDING",
  INTEGRITY_MISMATCH: "MISMATCH",
};

const PURPOSE_LABEL: Record<string, string> = {
  evidence_registration: "Evidence registered on chain",
  custody_transfer: "Custody transfer anchored",
  integrity_check: "Integrity check anchored",
  forensic_report: "Forensic report anchored",
  anomaly_flag: "Screening verdict anchored",
  document: "Document digest anchored",
};

/**
 * One timeline for a case, every entry labelled by how well it is established:
 * verified on chain, recorded only in the database, seen only on chain,
 * contradicted, or still pending. Plus the list of what could not be verified,
 * shown instead of a blanket green badge.
 */
export async function auditTimeline(caseId: string, role: UserRole) {
  const [activity, anchors, courtEvents] = await Promise.all([
    caseActivity(caseId, 500),
    unwrapList(
      await db
        .from("anchors")
        .select("id, purpose, subject_type, subject_id, state, tx_hash, block_number, chain_record_id, failure_code, failure_reason, created_at, confirmed_at, submitted_at")
        .eq("case_id", caseId)
        .order("created_at", { ascending: true })
    ) as any[],
    role === "accused"
      ? Promise.resolve([] as any[])
      : (unwrapList(await db.from("court_events").select("id, kind, title, scheduled_for, created_at").eq("case_id", caseId)) as any[]),
  ]);

  const txs = anchors.map((a) => a.tx_hash).filter(Boolean) as string[];
  const indexed = txs.length
    ? new Set((unwrapList(await db.from("chain_events").select("tx_hash").in("tx_hash", txs)) as { tx_hash: string }[]).map((e) => e.tx_hash))
    : new Set<string>();

  const entries: any[] = [];

  for (const a of anchors) {
    entries.push({
      id: `anchor:${a.id}`,
      at: a.confirmed_at ?? a.submitted_at ?? a.created_at,
      source: "chain",
      label: PURPOSE_LABEL[a.purpose] ?? a.purpose,
      trust: ANCHOR_LABEL[a.state] ?? "PENDING",
      state: a.state,
      txHash: a.tx_hash,
      explorer: a.tx_hash ? explorerUrl(a.tx_hash) : null,
      indexed: a.tx_hash ? indexed.has(a.tx_hash) : false,
      detail: a.failure_reason ?? null,
    });
  }

  const anchoredTxs = new Set(txs);
  for (const e of activity) {
    const tx = typeof e.detail.txHash === "string" ? e.detail.txHash : null;
    if (tx && anchoredTxs.has(tx)) continue; // already represented by its anchor
    entries.push({
      id: `action:${e.id}`,
      at: e.at,
      source: "database",
      label: e.label,
      trust: "DB_ONLY" as TrustLabel,
      outcome: e.outcome,
      actorRole: e.actorRole,
      detail: null,
    });
  }

  for (const c of courtEvents) {
    entries.push({
      id: `court:${c.id}`,
      at: c.scheduled_for ?? c.created_at,
      source: "database",
      label: `${c.kind[0].toUpperCase()}${c.kind.slice(1)}: ${c.title}`,
      trust: "DB_ONLY" as TrustLabel,
      detail: null,
    });
  }

  // Chain events for this case's records that the database has no anchor for.
  const recordIds = anchors.map((a) => a.chain_record_id).filter((v) => v !== null && v !== undefined).map(String);
  if (recordIds.length) {
    const chainEvents = unwrapList(
      await db.from("chain_events").select("tx_hash, event_name, block_number, args, created_at").eq("contract", "EvidenceChain").limit(2000)
    ) as any[];
    for (const ev of chainEvents) {
      if (!recordIds.includes(String(ev.args?.evidenceId)) || anchoredTxs.has(ev.tx_hash)) continue;
      entries.push({
        id: `chain:${ev.tx_hash}:${ev.event_name}`,
        at: ev.created_at,
        source: "chain",
        label: `${ev.event_name} (not in the database)`,
        trust: "CHAIN_ONLY" as TrustLabel,
        txHash: ev.tx_hash,
        explorer: explorerUrl(ev.tx_hash),
        detail: null,
      });
    }
  }

  entries.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const notVerified = entries.filter((e) => e.trust !== "VERIFIED_ON_CHAIN" && e.source === "chain");
  const counts = entries.reduce<Record<string, number>>((acc, e) => ((acc[e.trust] = (acc[e.trust] ?? 0) + 1), acc), {});
  return { entries, notVerified, counts };
}
