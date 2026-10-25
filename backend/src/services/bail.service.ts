import { Request } from "express";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { keccakOfString, deviceFingerprint } from "../lib/crypto";
import { submit, read, eventArgs, toMicroDegrees, explorerUrl, chain } from "../lib/chain";
import { badRequest, conflict, notFound, forbidden } from "../lib/errors";
import { logger } from "../lib/logger";
import { otpProvider } from "../otp";
import { predictBailRisk, recordPrediction } from "../lib/ai";
import { recordAction } from "./audit";
import { otpFailureMessage } from "./summons.service";
import { SessionUser } from "../middleware/auth";

/**
 * JaminSetu service layer.
 *
 * Conditions are stored on chain in the order the judge chose them, and
 * checkCompliance() returns one violation flag per condition at the same index.
 * That index alignment is why the tags are a fixed catalogue rather than free
 * text: a UI cannot label a flag correctly if it does not know which condition
 * position it belongs to.
 */

export const CONDITION_CATALOGUE = [
  {
    tag: "GEO_RESTRICTION",
    label: "Remain within the permitted radius of the declared residence",
    monitored: "on-chain",
  },
  {
    tag: "PERIODIC_CHECKIN",
    label: "Report a check-in at every interval with Aadhaar OTP and GPS",
    monitored: "on-chain",
  },
  {
    tag: "NO_CONTACT",
    label: "No contact with the complainant or any listed witness",
    monitored: "court-reported",
  },
  {
    tag: "SURRENDER_PASSPORT",
    label: "Surrender the passport to the court registry",
    monitored: "court-reported",
  },
  {
    tag: "NO_REOFFENCE",
    label: "Commit no further offence while on bail",
    monitored: "court-reported",
  },
] as const;

export type ConditionTag = (typeof CONDITION_CATALOGUE)[number]["tag"];

const TAG_BY_NAME = new Map(CONDITION_CATALOGUE.map((c) => [c.tag, c]));

/** Narrows the caller's Aadhaar token once, so the call sites stay readable. */
function requireAadhaarToken(user: SessionUser): string {
  if (!user.aadhaarToken) {
    throw badRequest(
      "Your account has no Aadhaar token on file. Ask the court administrator to complete your record."
    );
  }
  return user.aadhaarToken;
}

export interface GrantInput {
  caseId: string;
  accusedUserId?: string | null;
  accusedName: string;
  accusedAadhaarToken: string;
  conditionTags: ConditionTag[];
  centreLat: number;
  centreLng: number;
  radiusMetres: number;
  checkinIntervalSeconds: number;
  expiryAt: string;
  orderText?: string | null;
  suretyName?: string | null;
  suretyUserId?: string | null;
  riskFactors?: {
    offenceType: string;
    priorConvictions: number;
    ageYears: number;
    previousBailViolations: number;
    checkInConsistency: number;
    movementRadiusKm: number;
    employmentStable: boolean;
  } | null;
}

export async function grantBail(req: Request, user: SessionUser, input: GrantInput) {
  const caseRow = unwrapMaybe(
    await db.from("cases").select("id, case_reference, case_id_hash").eq("id", input.caseId).maybeSingle()
  ) as { id: string; case_reference: string; case_id_hash: string } | null;
  if (!caseRow) throw notFound("Case");

  const existing = unwrapMaybe(
    await db.from("bail_conditions").select("id").eq("case_id", caseRow.id).maybeSingle()
  ) as { id: string } | null;
  if (existing) throw conflict("Bail has already been granted for this case.");

  if (input.conditionTags.length === 0) throw badRequest("At least one condition is required.");
  const unknown = input.conditionTags.filter((t) => !TAG_BY_NAME.has(t));
  if (unknown.length > 0) throw badRequest(`Unknown condition tags: ${unknown.join(", ")}`);
  if (new Date(input.expiryAt).getTime() <= Date.now()) {
    throw badRequest("The bail expiry date must be in the future.");
  }

  const labels = input.conditionTags.map((t) => TAG_BY_NAME.get(t)!.label);
  const tagHashes = input.conditionTags.map((t) => keccakOfString(t));

  // Risk assessment, shown to the judge and stored with the order.
  let risk = null as Awaited<ReturnType<typeof predictBailRisk>> | null;
  let riskHash: string | null = null;
  if (input.riskFactors) {
    risk = await predictBailRisk(input.riskFactors);
    if (risk.available) {
      riskHash = await recordPrediction({
        model: "bail_risk",
        modelVersion: risk.modelVersion,
        subjectType: "case",
        subjectId: caseRow.id,
        caseId: caseRow.id,
        input: input.riskFactors,
        output: { band: risk.band, score: risk.score, factors: risk.factors },
      });
    }
  }

  const row = unwrap(
    await db
      .from("bail_conditions")
      .insert({
        case_id: caseRow.id,
        accused_user_id: input.accusedUserId ?? null,
        accused_name: input.accusedName,
        accused_aadhaar_token: input.accusedAadhaarToken,
        conditions: labels,
        condition_tags: tagHashes,
        order_text: input.orderText ?? null,
        centre_lat: input.centreLat,
        centre_lng: input.centreLng,
        radius_metres: input.radiusMetres,
        checkin_interval_seconds: input.checkinIntervalSeconds,
        expiry_at: input.expiryAt,
        granted_by: user.id,
        surety_name: input.suretyName ?? null,
        surety_user_id: input.suretyUserId ?? null,
        risk_band: risk?.available ? risk.band : null,
        risk_score: risk?.available ? risk.score : null,
        compliance_score: 100,
        active: true,
      })
      .select("*")
      .single()
  ) as any;

  const grantResult = await submit(
    "BailChain",
    "setBailConditions",
    [
      caseRow.case_id_hash,
      input.accusedAadhaarToken,
      tagHashes,
      BigInt(Math.floor(new Date(input.expiryAt).getTime() / 1000)),
    ],
    { submittedBy: user.id, payload: { bailRowId: row.id, caseReference: caseRow.case_reference } }
  );

  await submit(
    "BailChain",
    "configureMonitoring",
    [
      caseRow.case_id_hash,
      toMicroDegrees(input.centreLat, "latitude"),
      toMicroDegrees(input.centreLng, "longitude"),
      BigInt(input.radiusMetres),
      BigInt(input.checkinIntervalSeconds),
    ],
    { submittedBy: user.id, payload: { bailRowId: row.id } }
  );

  await db.from("bail_conditions").update({ grant_tx_hash: grantResult.txHash }).eq("id", row.id);

  await recordAction(req, {
    action: "bail.grant",
    subject: row.id,
    caseId: caseRow.id,
    detail: {
      conditions: input.conditionTags,
      radiusMetres: input.radiusMetres,
      riskBand: risk?.band ?? null,
      txHash: grantResult.txHash,
    },
  });

  return {
    bail: { ...row, grant_tx_hash: grantResult.txHash },
    risk,
    riskHash,
    chain: {
      txHash: grantResult.txHash,
      blockNumber: grantResult.blockNumber,
      explorer: explorerUrl(grantResult.txHash),
    },
  };
}

export async function requestCheckInOtp(req: Request, user: SessionUser, caseId: string) {
  const bail = await loadBailByCase(caseId);
  const aadhaarToken = requireAadhaarToken(user);

  if (bail.accused_aadhaar_token !== aadhaarToken) {
    throw forbidden("This bail order does not belong to you.");
  }
  if (!bail.active) throw conflict("This bail order is closed.");

  const dispatch = await otpProvider.sendOtp({
    subjectToken: aadhaarToken,
    purpose: "bail_checkin",
    referenceId: bail.id,
    destinationHint: "registered mobile",
  });

  await recordAction(req, {
    action: "bail.checkin_otp",
    subject: bail.id,
    caseId: bail.case_id,
    detail: { challengeId: dispatch.challengeId },
  });

  return dispatch;
}

/**
 * Records a check-in. The contract decides whether it is a breach, not this
 * code: geo-fence arithmetic and the overdue test both run on chain, so the
 * verdict is reproducible by anyone reading the chain.
 */
export async function checkIn(
  req: Request,
  user: SessionUser,
  input: {
    caseId: string;
    challengeId: string;
    otp: string;
    gpsLat: number;
    gpsLng: number;
    deviceId?: string | null;
    platform?: string | null;
    accuracyMetres?: number | null;
  }
) {
  const bail = await loadBailByCase(input.caseId);
  const aadhaarToken = requireAadhaarToken(user);
  const caseRow = unwrapMaybe(
    await db.from("cases").select("case_id_hash").eq("id", bail.case_id).maybeSingle()
  ) as { case_id_hash: string } | null;
  if (!caseRow) throw notFound("Case");

  if (bail.accused_aadhaar_token !== aadhaarToken) {
    throw forbidden("This bail order does not belong to you.");
  }
  if (!bail.active) throw conflict("This bail order is closed.");

  const verification = await otpProvider.verifyOtp({
    challengeId: input.challengeId,
    otp: input.otp,
    subjectToken: aadhaarToken,
    purpose: "bail_checkin",
    referenceId: bail.id,
  });

  if (!verification.verified) {
    await recordAction(req, {
      action: "bail.checkin",
      subject: bail.id,
      caseId: bail.case_id,
      outcome: "refused",
      detail: { reason: verification.reason },
    });
    throw badRequest(otpFailureMessage(verification.reason), {
      reason: verification.reason,
      attemptsRemaining: verification.attemptsRemaining,
    });
  }

  const result = await submit(
    "BailChain",
    "weeklyCheckIn",
    [
      caseRow.case_id_hash,
      aadhaarToken,
      toMicroDegrees(input.gpsLat, "latitude"),
      toMicroDegrees(input.gpsLng, "longitude"),
    ],
    { submittedBy: user.id, payload: { bailRowId: bail.id } }
  );

  const recorded = eventArgs(result.receipt, "BailChain", "CheckInRecorded");
  const distanceMetres = recorded?.distanceMetres !== undefined ? Number(recorded.distanceMetres) : null;
  const withinFence = recorded?.withinFence !== undefined ? Boolean(recorded.withinFence) : true;

  await db.from("checkins").insert({
    case_id: bail.case_id,
    bail_id: bail.id,
    accused_aadhaar_token: aadhaarToken,
    gps_lat: input.gpsLat,
    gps_lng: input.gpsLng,
    distance_metres: distanceMetres,
    within_fence: withinFence,
    accuracy_metres: input.accuracyMetres ?? null,
    occurred_at: new Date().toISOString(),
    device_fingerprint: deviceFingerprint({
      userAgent: req.get("user-agent") ?? undefined,
      platform: input.platform ?? undefined,
      deviceId: input.deviceId ?? undefined,
    }),
    tx_hash: result.txHash,
    block_number: result.blockNumber,
  });

  // A single transaction can emit more than one ViolationDetected: arriving late
  // and from the wrong place at once.
  const violations = await persistViolations(bail, result.receipt, result.txHash, result.blockNumber);
  const compliance = await refreshCompliance(bail.id, caseRow.case_id_hash);

  await recordAction(req, {
    action: "bail.checkin",
    subject: bail.id,
    caseId: bail.case_id,
    detail: { withinFence, distanceMetres, violations: violations.map((v) => v.reason), txHash: result.txHash },
  });

  return {
    withinFence,
    distanceMetres,
    violations,
    compliance,
    chain: {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      explorer: explorerUrl(result.txHash),
    },
  };
}

/** Compliance read straight off the chain, then cached for list views. */
export async function refreshCompliance(bailId: string, caseIdHash: string) {
  if (!chain.isReady) return null;

  try {
    const [score, flags] = (await read<[bigint, boolean[]]>("BailChain", "checkCompliance", [caseIdHash])) as any;
    const overdue = await read<boolean>("BailChain", "isOverdue", [caseIdHash]);
    const nextDue = Number(await read<bigint>("BailChain", "nextCheckInDue", [caseIdHash]));

    const numericScore = Number(score);
    await db.from("bail_conditions").update({ compliance_score: numericScore }).eq("id", bailId);

    return {
      score: numericScore,
      flags: Array.from(flags as boolean[]),
      overdue: Boolean(overdue),
      secondsUntilNextCheckIn: nextDue,
    };
  } catch (error) {
    logger.warn("Could not read compliance from chain", { bailId, error });
    return null;
  }
}

export async function complianceFor(caseId: string) {
  const bail = await loadBailByCase(caseId);
  const caseRow = unwrapMaybe(
    await db.from("cases").select("case_id_hash, case_reference, title").eq("id", bail.case_id).maybeSingle()
  ) as { case_id_hash: string; case_reference: string; title: string } | null;
  if (!caseRow) throw notFound("Case");

  const compliance = await refreshCompliance(bail.id, caseRow.case_id_hash);

  const checkins = unwrapList(
    await db
      .from("checkins")
      .select("id, gps_lat, gps_lng, distance_metres, within_fence, occurred_at, tx_hash")
      .eq("bail_id", bail.id)
      .order("occurred_at", { ascending: false })
      .limit(50)
  ) as any[];

  const violations = unwrapList(
    await db
      .from("violations")
      .select("id, kind, reason, detected_at, acknowledged_at, acknowledged_by, tx_hash")
      .eq("bail_id", bail.id)
      .order("detected_at", { ascending: false })
  ) as any[];

  // Pair each stored condition label with the flag at the same index.
  const conditionStates = (bail.conditions as string[]).map((label, index) => ({
    label,
    tagHash: (bail.condition_tags as string[])[index],
    violated: compliance ? Boolean(compliance.flags[index]) : false,
  }));

  return { bail, case: caseRow, compliance, conditionStates, checkins, violations };
}

/** The court's live board: every active order with its current score. */
export async function complianceDashboard() {
  const rows = unwrapList(
    await db
      .from("bail_conditions")
      .select(
        "id, case_id, accused_name, conditions, compliance_score, risk_band, risk_score, radius_metres, " +
          "checkin_interval_seconds, expiry_at, active, cases(case_reference, title, case_id_hash)"
      )
      .eq("active", true)
      .order("compliance_score", { ascending: true })
  ) as any[];

  const out = [];
  for (const row of rows) {
    const caseIdHash = row.cases?.case_id_hash;
    const live = caseIdHash ? await refreshCompliance(row.id, caseIdHash) : null;

    const openViolations = unwrapList(
      await db
        .from("violations")
        .select("id")
        .eq("bail_id", row.id)
        .is("acknowledged_at", null)
    ) as any[];

    out.push({
      ...row,
      live,
      openViolations: openViolations.length,
      // What the dashboard colours green or red.
      state: !live ? "unknown" : live.score >= 85 && !live.overdue ? "compliant" : "breach",
    });
  }
  return out;
}

/** Sweep job: writes down every overdue check-in and alerts the court. */
export async function sweepMissedCheckIns(): Promise<{ flagged: number; cases: string[] }> {
  if (!chain.isReady) return { flagged: 0, cases: [] };

  const active = unwrapList(
    await db
      .from("bail_conditions")
      .select("id, case_id, accused_name, cases(case_id_hash, case_reference)")
      .eq("active", true)
      .gt("expiry_at", new Date().toISOString())
      .limit(100)
  ) as any[];

  const flagged: string[] = [];

  for (const row of active) {
    const caseIdHash = row.cases?.case_id_hash;
    if (!caseIdHash) continue;

    try {
      const overdue = await read<boolean>("BailChain", "isOverdue", [caseIdHash]);
      if (!overdue) continue;

      const result = await submit("BailChain", "flagMissedCheckIn", [caseIdHash], {
        payload: { bailRowId: row.id, sweep: true },
      });

      await persistViolations(row, result.receipt, result.txHash, result.blockNumber);
      await refreshCompliance(row.id, caseIdHash);
      flagged.push(row.cases.case_reference);
      logger.info("Missed check-in flagged", { caseReference: row.cases.case_reference, accused: row.accused_name });
    } catch (error) {
      // NotOverdue can be raised by a race with a late check-in; that is fine.
      logger.debug("Sweep skipped a bail order", {
        bailId: row.id,
        reason: error instanceof Error ? error.message : error,
      });
    }
  }

  return { flagged: flagged.length, cases: flagged };
}

export async function reportViolation(
  req: Request,
  user: SessionUser,
  caseId: string,
  reason: string
) {
  const bail = await loadBailByCase(caseId);
  const caseRow = unwrapMaybe(
    await db.from("cases").select("case_id_hash").eq("id", bail.case_id).maybeSingle()
  ) as { case_id_hash: string } | null;
  if (!caseRow) throw notFound("Case");

  const result = await submit("BailChain", "reportViolation", [caseRow.case_id_hash, reason], {
    submittedBy: user.id,
    payload: { bailRowId: bail.id },
  });

  await persistViolations(bail, result.receipt, result.txHash, result.blockNumber);
  const compliance = await refreshCompliance(bail.id, caseRow.case_id_hash);

  await recordAction(req, {
    action: "bail.report_violation",
    subject: bail.id,
    caseId: bail.case_id,
    detail: { reason, txHash: result.txHash },
  });

  return { compliance, chain: { txHash: result.txHash, explorer: explorerUrl(result.txHash) } };
}

export async function acknowledgeViolation(req: Request, user: SessionUser, violationId: string) {
  const row = unwrapMaybe(
    await db.from("violations").select("id, case_id, reason").eq("id", violationId).maybeSingle()
  ) as { id: string; case_id: string; reason: string } | null;
  if (!row) throw notFound("Violation");

  await db
    .from("violations")
    .update({ acknowledged_by: user.id, acknowledged_at: new Date().toISOString() })
    .eq("id", violationId);

  await recordAction(req, {
    action: "bail.acknowledge_violation",
    subject: violationId,
    caseId: row.case_id,
    detail: { reason: row.reason },
  });

  return { acknowledged: true };
}

export async function closeBail(req: Request, user: SessionUser, caseId: string, reason: string) {
  const bail = await loadBailByCase(caseId);
  const caseRow = unwrapMaybe(
    await db.from("cases").select("case_id_hash").eq("id", bail.case_id).maybeSingle()
  ) as { case_id_hash: string } | null;
  if (!caseRow) throw notFound("Case");

  const result = await submit("BailChain", "closeBail", [caseRow.case_id_hash, reason], {
    submittedBy: user.id,
    payload: { bailRowId: bail.id },
  });

  await db.from("bail_conditions").update({ active: false }).eq("id", bail.id);

  await recordAction(req, {
    action: "bail.close",
    subject: bail.id,
    caseId: bail.case_id,
    detail: { reason, txHash: result.txHash },
  });

  return { chain: { txHash: result.txHash, explorer: explorerUrl(result.txHash) } };
}

/** Read-only view for the surety, who may see compliance but no case material. */
export async function suretyView(user: SessionUser) {
  const rows = unwrapList(
    await db
      .from("bail_conditions")
      .select(
        "id, case_id, accused_name, conditions, compliance_score, expiry_at, active, " +
          "radius_metres, checkin_interval_seconds, cases(case_reference, case_id_hash)"
      )
      .eq("surety_user_id", user.id)
  ) as any[];

  const out = [];
  for (const row of rows) {
    const live = row.cases?.case_id_hash ? await refreshCompliance(row.id, row.cases.case_id_hash) : null;
    // Deliberately omits order_text, GPS history and violation detail.
    out.push({
      id: row.id,
      accusedName: row.accused_name,
      caseReference: row.cases?.case_reference,
      conditions: row.conditions,
      complianceScore: live?.score ?? row.compliance_score,
      overdue: live?.overdue ?? null,
      expiryAt: row.expiry_at,
      active: row.active,
    });
  }
  return out;
}

export async function bailForAccused(user: SessionUser) {
  if (!user.aadhaarToken) return [];
  return unwrapList(
    await db
      .from("bail_conditions")
      .select(
        "id, case_id, conditions, condition_tags, centre_lat, centre_lng, radius_metres, " +
          "checkin_interval_seconds, expiry_at, active, compliance_score, cases(case_reference, title, case_id_hash)"
      )
      .eq("accused_aadhaar_token", user.aadhaarToken)
      .eq("active", true)
  ) as any[];
}

export async function loadBailByCase(caseId: string) {
  const row = unwrapMaybe(
    await db.from("bail_conditions").select("*").eq("case_id", caseId).maybeSingle()
  ) as any;
  if (!row) throw notFound("Bail order for this case");
  return row;
}

// ------------------------------------------------------------------ internals

function violationKind(reason: string): "GEO_FENCE_BREACH" | "MISSED_CHECK_IN" | "NO_CONTACT_BREACH" | "OTHER" {
  if (reason === "GEO_FENCE_BREACH") return "GEO_FENCE_BREACH";
  if (reason === "MISSED_CHECK_IN") return "MISSED_CHECK_IN";
  if (reason.startsWith("NO_CONTACT")) return "NO_CONTACT_BREACH";
  return "OTHER";
}

/**
 * Mirrors every ViolationDetected in a receipt into the violations table. The
 * chain is authoritative; these rows exist so the dashboard can filter, sort
 * and mark a breach acknowledged without paying gas.
 */
async function persistViolations(
  bail: { id: string; case_id: string },
  receipt: any,
  txHash: string,
  blockNumber: number
) {
  const { contractFor } = await import("../lib/chain");
  const contract = contractFor("BailChain");
  const found: { kind: string; reason: string; detectedAt: string }[] = [];

  for (const log of receipt.logs ?? []) {
    if (String(log.address).toLowerCase() !== String(contract.target).toLowerCase()) continue;
    try {
      const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name !== "ViolationDetected") continue;

      const reason = String(parsed.args[1]);
      const detectedAt = new Date(Number(parsed.args[2]) * 1000).toISOString();

      await db.from("violations").insert({
        case_id: bail.case_id,
        bail_id: bail.id,
        kind: violationKind(reason),
        reason,
        detected_at: detectedAt,
        tx_hash: txHash,
        block_number: blockNumber,
      });

      found.push({ kind: violationKind(reason), reason, detectedAt });
    } catch {
      continue;
    }
  }
  return found;
}
