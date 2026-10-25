import { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { conflict, forbidden, notFound } from "../lib/errors";
import { recordAction } from "./audit";
import type { SessionUser, UserRole } from "../middleware/auth";
import type { VerificationState } from "./verification/stateMachine";

/**
 * The court-facing workflows of 2.0:
 *   F15 prosecution overview
 *   F16 defence access requests and objections
 *   F17 court events, summons service attempts, bail compliance by severity
 *   F18 the accused's reason for a missed check-in
 */

async function assignedCaseIds(user: SessionUser): Promise<string[] | null> {
  if (user.role === "court_admin") return null;
  return (unwrapList(await db.from("case_assignments").select("case_id").eq("user_id", user.id)) as { case_id: string }[]).map((a) => a.case_id);
}

async function isAssigned(userId: string, caseId: string): Promise<boolean> {
  return Boolean(unwrapMaybe(await db.from("case_assignments").select("id").eq("case_id", caseId).eq("user_id", userId).maybeSingle()));
}

/* ------------------------------------------------------------- F15 */

/** Per case: how many items are verified, pending or flagged, and what is open. */
export async function prosecutionOverview(user: SessionUser) {
  const scope = await assignedCaseIds(user);
  if (scope && scope.length === 0) return { cases: [] };

  let casesQuery = db.from("cases").select("id, case_reference, title, status, court_name").order("registered_at", { ascending: false }).limit(200);
  if (scope) casesQuery = casesQuery.in("id", scope);
  const cases = unwrapList(await casesQuery) as any[];
  if (!cases.length) return { cases: [] };
  const ids = cases.map((c) => c.id);

  const [evidence, alerts] = await Promise.all([
    unwrapList(await db.from("evidence_items").select("id, case_id, current_stage, anchors(state)").in("case_id", ids)) as any[],
    unwrapList(await db.from("discrepancy_alerts").select("case_id, kind, status").in("case_id", ids).neq("status", "resolved")) as any[],
  ]);

  return {
    cases: cases.map((c) => {
      const items = evidence.filter((e) => e.case_id === c.id);
      const states = items.map((e) => (e.anchors?.state ?? "LOCAL_ONLY") as VerificationState);
      const open = alerts.filter((a) => a.case_id === c.id);
      return {
        ...c,
        evidence: items.length,
        verified: states.filter((s) => s === "CONFIRMED").length,
        pending: states.filter((s) => s === "SUBMITTED" || s === "LOCAL_ONLY" || s === "SYNC_ERROR" || s === "REVIEW_REQUIRED").length,
        flagged: states.filter((s) => s === "INTEGRITY_MISMATCH").length,
        atCourt: items.filter((e) => e.current_stage === "COURT").length,
        openAlerts: open.length,
        custodyGaps: open.filter((a) => a.kind === "CUSTODY_GAP").length,
      };
    }),
  };
}

/* ------------------------------------------------------------- F16 */

export async function requestAccess(req: Request, user: SessionUser, input: { caseReference: string; reason: string }) {
  if (user.role !== "defence_lawyer") throw forbidden("Only defence counsel request access this way.");
  const caseRow = unwrapMaybe(
    await db.from("cases").select("id, case_reference").eq("case_reference", input.caseReference.trim().toUpperCase()).maybeSingle()
  ) as { id: string; case_reference: string } | null;
  // The same answer whether the case does not exist or exists: a request is
  // logged either way, and nobody learns which references are real.
  if (!caseRow) {
    await recordAction(req, { action: "access.request", outcome: "refused", detail: { reason: "unknown_reference" } });
    throw notFound("Case reference");
  }
  if (await isAssigned(user.id, caseRow.id)) throw conflict("You already have access to this case.");
  const pending = unwrapList(await db.from("access_requests").select("id").eq("case_id", caseRow.id).eq("requester_id", user.id).eq("status", "pending"));
  if (pending.length) throw conflict("You already have a request waiting for the court.");

  const row = unwrap(
    await db.from("access_requests").insert({ case_id: caseRow.id, requester_id: user.id, reason: input.reason, status: "pending" }).select("*").single()
  );
  await recordAction(req, { action: "access.request", subject: (row as any).id, caseId: caseRow.id });
  return row;
}

export async function listAccessRequests(user: SessionUser, status?: string) {
  let query = db
    .from("access_requests")
    .select("id, case_id, requester_id, reason, status, decision_reason, decided_at, created_at, cases(case_reference, title)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (status) query = query.eq("status", status);
  if (user.role === "defence_lawyer") query = query.eq("requester_id", user.id);
  else {
    const scope = await assignedCaseIds(user);
    if (scope) {
      if (!scope.length) return [];
      query = query.in("case_id", scope);
    }
  }
  const rows = unwrapList(await query) as any[];
  const people = rows.length
    ? (unwrapList(await db.from("users").select("id, full_name").in("id", [...new Set(rows.map((r) => r.requester_id))])) as any[])
    : [];
  const names = new Map(people.map((p) => [p.id, p.full_name]));
  return rows.map((r) => ({ ...r, requester_name: names.get(r.requester_id) ?? null }));
}

export async function decideAccess(req: Request, user: SessionUser, requestId: string, input: { grant: boolean; reason: string }) {
  const request = unwrapMaybe(await db.from("access_requests").select("*").eq("id", requestId).maybeSingle()) as any;
  if (!request) throw notFound("Access request");
  if (user.role === "judge" && !(await isAssigned(user.id, request.case_id))) throw forbidden("You are not assigned to this case.");
  if (request.status !== "pending") throw conflict(`This request is already ${request.status}.`);

  const row = unwrap(
    await db
      .from("access_requests")
      .update({ status: input.grant ? "granted" : "refused", decided_by: user.id, decision_reason: input.reason, decided_at: new Date().toISOString() })
      .eq("id", requestId)
      .select("*")
      .single()
  );
  if (input.grant) {
    // Exactly what the court grants: read access to this case, never write.
    await db
      .from("case_assignments")
      .upsert({ case_id: request.case_id, user_id: request.requester_id, access: "read", assigned_by: user.id }, { onConflict: "case_id,user_id" });
  }
  await recordAction(req, { action: input.grant ? "access.grant" : "access.refuse", subject: requestId, caseId: request.case_id });
  return row;
}

export async function withdrawAccess(req: Request, user: SessionUser, requestId: string) {
  const request = unwrapMaybe(await db.from("access_requests").select("*").eq("id", requestId).maybeSingle()) as any;
  if (!request || request.requester_id !== user.id) throw notFound("Access request");
  if (request.status !== "pending") throw conflict(`This request is already ${request.status}.`);
  await db.from("access_requests").update({ status: "withdrawn" }).eq("id", requestId);
  await recordAction(req, { action: "access.withdraw", subject: requestId, caseId: request.case_id });
}

export async function fileObjection(req: Request, user: SessionUser, input: { caseId: string; evidenceId?: string | null; grounds: string }) {
  if (input.evidenceId) {
    const item = unwrapMaybe(await db.from("evidence_items").select("case_id").eq("id", input.evidenceId).maybeSingle()) as { case_id: string } | null;
    if (!item || item.case_id !== input.caseId) throw notFound("Evidence item in this case");
  }
  const row = unwrap(
    await db
      .from("objections")
      .insert({ case_id: input.caseId, evidence_id: input.evidenceId ?? null, filed_by: user.id, grounds: input.grounds, status: "open" })
      .select("*")
      .single()
  );
  await recordAction(req, { action: "objection.file", subject: (row as any).id, caseId: input.caseId });
  return row;
}

export async function ruleOnObjection(req: Request, user: SessionUser, objectionId: string, input: { outcome: "upheld" | "dismissed"; ruling: string }) {
  const objection = unwrapMaybe(await db.from("objections").select("*").eq("id", objectionId).maybeSingle()) as any;
  if (!objection) throw notFound("Objection");
  if (user.role === "judge" && !(await isAssigned(user.id, objection.case_id))) throw forbidden("You are not assigned to this case.");
  if (objection.status !== "open") throw conflict(`This objection is already ${objection.status}.`);
  const row = unwrap(
    await db
      .from("objections")
      .update({ status: input.outcome, ruling: input.ruling, ruled_by: user.id, ruled_at: new Date().toISOString() })
      .eq("id", objectionId)
      .select("*")
      .single()
  );
  await recordAction(req, { action: `objection.${input.outcome}`, subject: objectionId, caseId: objection.case_id });
  return row;
}

export async function objectionsFor(caseId: string) {
  return unwrapList(await db.from("objections").select("*").eq("case_id", caseId).order("created_at", { ascending: false }));
}

/* ------------------------------------------------------------- F17 */

export async function addCourtEvent(
  req: Request,
  user: SessionUser,
  input: { caseId: string; kind: string; title: string; body?: string | null; scheduledFor?: string | null; linkedType?: string | null; linkedId?: string | null }
) {
  const row = unwrap(
    await db
      .from("court_events")
      .insert({
        case_id: input.caseId,
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        scheduled_for: input.scheduledFor ?? null,
        linked_type: input.linkedType ?? null,
        linked_id: input.linkedId ?? null,
        created_by: user.id,
      })
      .select("*")
      .single()
  );
  await recordAction(req, { action: `court.${input.kind}`, subject: (row as any).id, caseId: input.caseId });
  return row;
}

/** Court events for a case. The accused sees hearing dates, not orders and directions in draft form. */
export async function courtEventsFor(caseId: string, role: UserRole) {
  let query = db.from("court_events").select("*").eq("case_id", caseId).order("created_at", { ascending: true });
  if (role === "accused") query = query.eq("kind", "hearing");
  return unwrapList(await query);
}

export async function upcomingHearings(user: SessionUser) {
  const scope = await assignedCaseIds(user);
  if (scope && !scope.length) return [];
  let query = db
    .from("court_events")
    .select("id, case_id, kind, title, scheduled_for, cases(case_reference, title)")
    .eq("kind", "hearing")
    .gte("scheduled_for", new Date(Date.now() - 86_400_000).toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(100);
  if (scope) query = query.in("case_id", scope);
  return unwrapList(await query);
}

export async function addSummonsAttempt(
  req: Request,
  user: SessionUser,
  summonsId: string,
  input: { method: string; outcome: string; notes?: string | null; attemptedAt?: string | null }
) {
  const summons = unwrapMaybe(await db.from("summons").select("id, case_id").eq("id", summonsId).maybeSingle()) as any;
  if (!summons) throw notFound("Summons");
  const row = unwrap(
    await db
      .from("summons_service_attempts")
      .insert({
        summons_id: summonsId,
        method: input.method,
        outcome: input.outcome,
        notes: input.notes ?? null,
        attempted_at: input.attemptedAt ?? new Date().toISOString(),
        recorded_by: user.id,
      })
      .select("*")
      .single()
  );
  await recordAction(req, { action: "summons.attempt", subject: summonsId, caseId: summons.case_id, detail: { outcome: input.outcome } });
  return row;
}

export async function summonsService(caseId: string) {
  const summons = unwrapList(
    await db.from("summons").select("id, recipient_name, status, issued_at, expiry_at, delivered_at, ack_tx_hash, issue_tx_hash").eq("case_id", caseId).order("issued_at", { ascending: false })
  ) as any[];
  if (!summons.length) return [];
  const attempts = unwrapList(
    await db.from("summons_service_attempts").select("*").in("summons_id", summons.map((s) => s.id)).order("attempted_at", { ascending: true })
  ) as any[];
  return summons.map((s) => {
    const own = attempts.filter((a) => a.summons_id === s.id);
    const expired = s.status === "PENDING" && new Date(s.expiry_at).getTime() < Date.now();
    return { ...s, effectiveStatus: expired ? "FAILED" : s.status, attempts: own };
  });
}

/* ---------------- bail compliance, ranked by severity (F17) ---------------- */

const SEVERITY_RANK = { critical: 4, serious: 3, moderate: 2, minor: 1 } as const;
type Severity = keyof typeof SEVERITY_RANK;

export interface RankedViolation {
  id: string;
  caseId: string;
  kind: string;
  reason: string;
  detectedAt: string;
  severity: Severity;
  why: string;
  explanation: { reason: string; category: string; submittedAt: string } | null;
  courtFinding: string | null;
  acknowledged: boolean;
}

/**
 * Severity, decided so that a weak GPS reading is never treated like a breach:
 * a check-in outside the fence by less than its own accuracy radius is "minor —
 * possible GPS drift"; a missed check-in with a reason given is "moderate"; only
 * a court finding of absconding is "critical". Nothing here is a finding; it is
 * an order for the court to read in.
 */
export function classifyViolation(input: {
  kind: string;
  distanceMetres: number | null;
  radiusMetres: number;
  accuracyMetres: number | null;
  hasExplanation: boolean;
  missedInLast30Days: number;
  courtFinding: string | null;
}): { severity: Severity; why: string } {
  if (input.courtFinding === "absconding") return { severity: "critical", why: "The court has recorded a finding of absconding." };
  if (input.courtFinding === "no_violation" || input.courtFinding === "gps_drift" || input.courtFinding === "technical") {
    return { severity: "minor", why: `The court found: ${input.courtFinding.replace("_", " ")}.` };
  }
  if (input.kind === "GEO_FENCE_BREACH") {
    if (input.distanceMetres === null) return { severity: "moderate", why: "Outside the fence; the distance was not recorded." };
    const beyond = input.distanceMetres - input.radiusMetres;
    if (input.accuracyMetres !== null && beyond <= input.accuracyMetres) {
      return { severity: "minor", why: `Outside the fence by ${Math.round(beyond)} m, within the fix's ±${Math.round(input.accuracyMetres)} m accuracy: possible GPS drift.` };
    }
    if (input.accuracyMetres === null && beyond <= 100) {
      return { severity: "minor", why: `Outside the fence by ${Math.round(beyond)} m; the fix's accuracy was not recorded.` };
    }
    if (beyond <= input.radiusMetres) return { severity: "moderate", why: `Outside the fence by ${Math.round(beyond)} m.` };
    return { severity: "serious", why: `Outside the fence by ${Math.round(beyond)} m, more than the fence's own radius.` };
  }
  if (input.kind === "MISSED_CHECK_IN") {
    if (input.hasExplanation) return { severity: "moderate", why: "A check-in was missed; the accused has given a reason." };
    if (input.missedInLast30Days >= 3) return { severity: "serious", why: `${input.missedInLast30Days} check-ins missed in 30 days, with no reason given. Not a finding of absconding.` };
    return { severity: "moderate", why: "A check-in was missed and no reason has been given yet." };
  }
  return { severity: "moderate", why: "Reported violation." };
}

export async function bailCompliance(user: SessionUser) {
  const scope = await assignedCaseIds(user);
  if (scope && !scope.length) return { violations: [] as RankedViolation[] };
  let vq = db.from("violations").select("*").order("detected_at", { ascending: false }).limit(500);
  if (scope) vq = vq.in("case_id", scope);
  const violations = unwrapList(await vq) as any[];
  if (!violations.length) return { violations: [] as RankedViolation[] };

  const bailIds = [...new Set(violations.map((v) => v.bail_id).filter(Boolean))];
  const [bails, checkins, explanations] = await Promise.all([
    unwrapList(await db.from("bail_conditions").select("id, radius_metres").in("id", bailIds)) as any[],
    unwrapList(await db.from("checkins").select("bail_id, tx_hash, distance_metres, accuracy_metres").in("bail_id", bailIds)) as any[],
    unwrapList(await db.from("checkin_explanations").select("*").in("bail_id", bailIds)) as any[],
  ]);
  const radius = new Map(bails.map((b) => [b.id, Number(b.radius_metres)]));
  const since = Date.now() - 30 * 86_400_000;

  const ranked: RankedViolation[] = violations.map((v) => {
    const checkin = checkins.find((c) => c.tx_hash && c.tx_hash === v.tx_hash);
    const explanation = explanations.find((e) => e.violation_id === v.id) ?? null;
    const missed = violations.filter((o) => o.bail_id === v.bail_id && o.kind === "MISSED_CHECK_IN" && new Date(o.detected_at).getTime() > since).length;
    const { severity, why } = classifyViolation({
      kind: v.kind,
      distanceMetres: checkin?.distance_metres ?? null,
      radiusMetres: radius.get(v.bail_id) ?? 0,
      accuracyMetres: checkin?.accuracy_metres === null || checkin?.accuracy_metres === undefined ? null : Number(checkin.accuracy_metres),
      hasExplanation: Boolean(explanation),
      missedInLast30Days: missed,
      courtFinding: v.court_finding ?? null,
    });
    return {
      id: v.id,
      caseId: v.case_id,
      kind: v.kind,
      reason: v.reason,
      detectedAt: v.detected_at,
      severity,
      why,
      explanation: explanation ? { reason: explanation.reason, category: explanation.category, submittedAt: explanation.submitted_at } : null,
      courtFinding: v.court_finding ?? null,
      acknowledged: Boolean(v.acknowledged_at),
    };
  });
  ranked.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.detectedAt.localeCompare(a.detectedAt));
  return { violations: ranked };
}

export async function recordFinding(req: Request, user: SessionUser, violationId: string, finding: string) {
  const v = unwrapMaybe(await db.from("violations").select("id, case_id").eq("id", violationId).maybeSingle()) as any;
  if (!v) throw notFound("Violation");
  if (user.role === "judge" && !(await isAssigned(user.id, v.case_id))) throw forbidden("You are not assigned to this case.");
  const row = unwrap(await db.from("violations").update({ court_finding: finding }).eq("id", violationId).select("*").single());
  await recordAction(req, { action: "bail.finding", subject: violationId, caseId: v.case_id, detail: { outcomeCode: finding } });
  return row;
}

/* ------------------------------------------------------------- F18 */

export async function explainMissedCheckIn(
  req: Request,
  user: SessionUser,
  input: { bailId: string; violationId?: string | null; category: string; reason: string }
) {
  const bail = unwrapMaybe(await db.from("bail_conditions").select("id, case_id, accused_user_id").eq("id", input.bailId).maybeSingle()) as any;
  if (!bail || bail.accused_user_id !== user.id) throw notFound("Bail order");
  if (input.violationId) {
    const v = unwrapMaybe(await db.from("violations").select("bail_id").eq("id", input.violationId).maybeSingle()) as any;
    if (!v || v.bail_id !== bail.id) throw notFound("Missed check-in");
    const existing = unwrapList(await db.from("checkin_explanations").select("id").eq("violation_id", input.violationId));
    if (existing.length) throw conflict("A reason has already been given for this check-in.");
  }
  const row = unwrap(
    await db
      .from("checkin_explanations")
      .insert({ bail_id: bail.id, case_id: bail.case_id, violation_id: input.violationId ?? null, category: input.category, reason: input.reason, submitted_by: user.id })
      .select("*")
      .single()
  );
  await recordAction(req, { action: "bail.explanation", subject: bail.id, caseId: bail.case_id, detail: { reason: input.category } });
  return row;
}

export async function myObligations(user: SessionUser) {
  const bails = unwrapList(
    await db.from("bail_conditions").select("id, case_id, checkin_interval_seconds, created_at, active, cases(case_reference)").eq("accused_user_id", user.id)
  ) as any[];
  const result = [];
  for (const bail of bails) {
    const last = unwrapList(await db.from("checkins").select("occurred_at, within_fence").eq("bail_id", bail.id).order("occurred_at", { ascending: false }).limit(1)) as any[];
    const missed = unwrapList(
      await db.from("violations").select("id, detected_at, kind").eq("bail_id", bail.id).eq("kind", "MISSED_CHECK_IN").order("detected_at", { ascending: false }).limit(10)
    ) as any[];
    const explained = unwrapList(await db.from("checkin_explanations").select("violation_id").eq("bail_id", bail.id)) as any[];
    const done = new Set(explained.map((e) => e.violation_id));
    const dueMs = new Date(last[0]?.occurred_at ?? bail.created_at).getTime() + bail.checkin_interval_seconds * 1000;
    result.push({
      bailId: bail.id,
      caseReference: bail.cases?.case_reference ?? null,
      active: bail.active,
      nextDueAt: new Date(dueMs).toISOString(),
      overdue: dueMs < Date.now(),
      lastCheckIn: last[0] ?? null,
      missed: missed.map((m) => ({ ...m, explained: done.has(m.id) })),
    });
  }
  const summons = unwrapList(
    await db.from("summons").select("id, status, expiry_at, hearing_at, cases(case_reference)").eq("recipient_user_id", user.id).order("issued_at", { ascending: false })
  ) as any[];
  return { bail: result, summons };
}
