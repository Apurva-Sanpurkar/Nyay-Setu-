import { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { notFound, forbidden } from "../lib/errors";
import { recordAction } from "./audit";
import type { SessionUser, UserRole } from "../middleware/auth";

/**
 * Explainable AI with human review (2.0 · F5).
 *
 * Every model output is shown with its reasons, rule findings first, and with
 * the limits of the model stated where the output is shown. A reviewer can agree,
 * contest or dismiss with a recorded reason. Nothing here, and nothing an AI
 * output does, changes a case's status, a bail order or an item's standing.
 */

export const DECISION_SUPPORT_BANNER =
  "Decision support only. This output is a prompt for a person to look, not a finding. It cannot change a case, a bail order or the standing of any evidence.";

/** Taken from what ai-service/README.md and train.py state about the models. */
export const TRAINING_CAVEAT =
  "All three models were trained on declared synthetic distributions (ai-service/src/datasets.py), because real evidence metadata, " +
  "bail outcomes and per-case delay data are not lawfully available. The metrics train.py reports describe those synthetic sets, " +
  "not performance on real cases. The model version encodes this.";

/** The sentence ai-service returns when only the Isolation Forest, and no rule, found something unusual. */
const FOREST_ONLY_REASON = "The combination of size, timing and location is unlike routine intake";
const ROUTINE_REASON = "Consistent with routine evidence intake.";
const NULL_ISLAND_REASON = "Coordinates are null island (0, 0)";

export interface ExplainedReason {
  kind: "rule" | "statistical_outlier" | "context";
  label: string;
  text: string;
  note?: string;
}

/** Orders and labels screening reasons: checkable rule findings first, outliers labelled as such. */
export function explainScreening(output: { anomaly?: boolean; score?: number; reasons?: string[] }, item?: { gps_status?: string | null; gps_lat?: number | null }) {
  const reasons: ExplainedReason[] = [];
  for (const text of output.reasons ?? []) {
    if (text === ROUTINE_REASON) continue;
    if (text.startsWith(FOREST_ONLY_REASON)) {
      reasons.push({
        kind: "statistical_outlier",
        label: "Unexplained statistical outlier",
        text,
        note: "No single checkable rule fired. The model found the combination unusual, and cannot say why.",
      });
    } else if (text.startsWith(NULL_ISLAND_REASON) && item && (item.gps_status === "NO_GPS" || item.gps_lat === null || item.gps_lat === undefined)) {
      reasons.push({
        kind: "context",
        label: "Expected for this item",
        text,
        note: "No location was recorded for this item, so it was screened at (0, 0). This finding reflects that, not a GPS fault.",
      });
    } else {
      reasons.push({ kind: "rule", label: "Rule finding", text });
    }
  }
  const order = { rule: 0, context: 1, statistical_outlier: 2 };
  reasons.sort((a, b) => order[a.kind] - order[b.kind]);
  return {
    flagged: Boolean(output.anomaly),
    score: output.score ?? null,
    reasons,
    limitations:
      "Screening looks only at file size, timestamps, upload delay and position. It cannot see the content of the file, and a clean result is not a finding that the item is genuine.",
  };
}

export function explainBailRisk(output: any) {
  const probabilities = output.probabilities ?? null;
  return {
    estimate: output.band ?? null,
    score: output.score ?? null,
    interval: probabilities
      ? { kind: "band probabilities", values: probabilities as Record<string, number> }
      : null,
    topFactors: (output.factors ?? []).slice(0, 5),
    limitations:
      "The bands are cut at percentiles of a synthetic score. The factors are the inputs that most raised the estimate, not causes, and the model knows nothing about the person beyond them.",
  };
}

export function explainDelay(output: any) {
  return {
    estimate: output.predictedDays ?? null,
    interval: output.confidenceLow !== undefined ? { kind: "days, about 95%", low: output.confidenceLow, high: output.confidenceHigh } : null,
    topFactors: [] as string[],
    limitations:
      "The range comes from the spread of errors on held-out synthetic cases. A wide range is the honest answer; the single number is only its middle.",
  };
}

const READERS: UserRole[] = ["police", "forensic_lab", "prosecutor", "judge", "court_admin"];

export async function caseInsights(user: SessionUser, caseId: string) {
  if (!READERS.includes(user.role)) throw forbidden("AI outputs are not shown to your role.");
  const flags = unwrapList(
    await db
      .from("ai_flags")
      .select("id, model, model_version, subject_type, subject_id, output, payload_hash, anchored_tx_hash, created_at")
      .eq("case_id", caseId)
      .order("created_at", { ascending: false })
      .limit(100)
  ) as any[];
  const reviews = flags.length
    ? (unwrapList(
        await db.from("ai_reviews").select("ai_flag_id, decision, reason, reviewer_role, created_at").in("ai_flag_id", flags.map((f) => f.id))
      ) as any[])
    : [];
  const evidenceIds = flags.filter((f) => f.subject_type === "evidence_item").map((f) => f.subject_id);
  const items = evidenceIds.length
    ? (unwrapList(await db.from("evidence_items").select("id, file_name, public_ref, gps_status, gps_lat").in("id", evidenceIds)) as any[])
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  return {
    banner: DECISION_SUPPORT_BANNER,
    trainingCaveat: TRAINING_CAVEAT,
    outputs: flags.map((flag) => ({
      id: flag.id,
      model: flag.model,
      modelVersion: flag.model_version,
      subject: flag.subject_type === "evidence_item" ? itemById.get(flag.subject_id) ?? null : null,
      createdAt: flag.created_at,
      payloadHash: flag.payload_hash,
      explanation:
        flag.model === "evidence_anomaly"
          ? explainScreening(flag.output, itemById.get(flag.subject_id))
          : flag.model === "bail_risk"
            ? explainBailRisk(flag.output)
            : explainDelay(flag.output),
      reviews: reviews.filter((r) => r.ai_flag_id === flag.id),
    })),
  };
}

export async function reviewOutput(req: Request, user: SessionUser, flagId: string, input: { decision: "agree" | "contest" | "dismiss"; reason: string }) {
  if (!READERS.includes(user.role)) throw forbidden("Your role does not review AI outputs.");
  const flag = unwrapMaybe(await db.from("ai_flags").select("id, case_id").eq("id", flagId).maybeSingle()) as { id: string; case_id: string | null } | null;
  if (!flag) throw notFound("AI output");
  const row = unwrap(
    await db
      .from("ai_reviews")
      .insert({ ai_flag_id: flag.id, case_id: flag.case_id, reviewer_id: user.id, reviewer_role: user.role, decision: input.decision, reason: input.reason })
      .select("*")
      .single()
  );
  await recordAction(req, { action: "ai.review", subject: flag.id, caseId: flag.case_id, detail: { state: input.decision } });
  return row;
}

export async function flagCase(flagId: string): Promise<string | null> {
  const flag = unwrapMaybe(await db.from("ai_flags").select("case_id").eq("id", flagId).maybeSingle()) as { case_id: string | null } | null;
  if (!flag) throw notFound("AI output");
  return flag.case_id;
}
