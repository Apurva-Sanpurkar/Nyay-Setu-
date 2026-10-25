import { env, capabilities } from "../config/env";
import { logger } from "./logger";
import { canonicalHash } from "./crypto";
import { db } from "./supabase";

/**
 * Client for the Flask model service.
 *
 * Inference runs out of process on purpose. scikit-learn inference is
 * CPU-bound; running it inside the event loop would stall every other request,
 * and the two services want different scaling profiles.
 *
 * Every call degrades rather than fails. An anomaly score is advisory: if the
 * model service is down, evidence intake must still work, and the UI says the
 * screening was skipped rather than silently claiming the item is clean.
 */

export interface AnomalyRequest {
  fileSizeBytes: number;
  mimeType: string;
  claimedCollectedAt: string;
  deviceReportedMtime?: string | null;
  gpsLat: number;
  gpsLng: number;
  stationLat?: number | null;
  stationLng?: number | null;
  uploadDelaySeconds: number;
}

export interface AnomalyResult {
  available: boolean;
  anomaly: boolean;
  score: number;
  reasons: string[];
  modelVersion?: string;
}

export interface BailRiskRequest {
  offenceType: string;
  priorConvictions: number;
  ageYears: number;
  previousBailViolations: number;
  checkInConsistency: number;
  movementRadiusKm: number;
  employmentStable: boolean;
}

export interface BailRiskResult {
  available: boolean;
  band: "LOW" | "MEDIUM" | "HIGH";
  score: number;
  factors: string[];
  modelVersion?: string;
}

export interface DelayRequest {
  offenceType: string;
  courtBacklog: number;
  witnessCount: number;
  evidenceCount: number;
  adjournmentsSoFar: number;
  isBailGranted: boolean;
}

export interface DelayResult {
  available: boolean;
  predictedDays: number;
  confidenceLow: number;
  confidenceHigh: number;
  modelVersion?: string;
}

async function post<T>(route: string, body: unknown): Promise<T | null> {
  if (!capabilities.ai || !env.AI_SERVICE_URL) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.AI_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.AI_SERVICE_URL.replace(/\/$/, "")}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.AI_SERVICE_KEY ? { "x-ai-key": env.AI_SERVICE_KEY } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("AI service returned an error", { route, status: response.status });
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    logger.warn("AI service unreachable", {
      route,
      reason: error instanceof Error ? error.message : "unknown",
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function health(): Promise<boolean> {
  if (!capabilities.ai || !env.AI_SERVICE_URL) return false;
  try {
    const response = await fetch(`${env.AI_SERVICE_URL.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function screenEvidence(input: AnomalyRequest): Promise<AnomalyResult> {
  const result = await post<Omit<AnomalyResult, "available">>("/predict/evidence-anomaly", input);
  if (!result) {
    return { available: false, anomaly: false, score: 0, reasons: ["Screening unavailable"] };
  }
  return { available: true, ...result };
}

export async function predictBailRisk(input: BailRiskRequest): Promise<BailRiskResult> {
  const result = await post<Omit<BailRiskResult, "available">>("/predict/bail-risk", input);
  if (!result) {
    return { available: false, band: "MEDIUM", score: 0.5, factors: ["Model unavailable"] };
  }
  return { available: true, ...result };
}

export async function predictDelay(input: DelayRequest): Promise<DelayResult> {
  const result = await post<Omit<DelayResult, "available">>("/predict/case-delay", input);
  if (!result) {
    return { available: false, predictedDays: 0, confidenceLow: 0, confidenceHigh: 0 };
  }
  return { available: true, ...result };
}

/**
 * Records a prediction and returns its canonical digest.
 *
 * The digest is what anchorAnomalyFlag() writes on-chain. Because the hash
 * covers model name, input and output together, a flag cannot later be
 * explained away as having been about something else, and the flag row cannot
 * be edited without the hash ceasing to match the chain.
 */
export async function recordPrediction(args: {
  model: "evidence_anomaly" | "bail_risk" | "case_delay";
  modelVersion?: string;
  subjectType: string;
  subjectId: string;
  caseId?: string | null;
  input: unknown;
  output: unknown;
}): Promise<string> {
  const payloadHash = canonicalHash({
    model: args.model,
    input: args.input,
    output: args.output,
  });

  const { error } = await db.from("ai_flags").insert({
    model: args.model,
    model_version: args.modelVersion ?? null,
    subject_type: args.subjectType,
    subject_id: args.subjectId,
    case_id: args.caseId ?? null,
    input: args.input as any,
    output: args.output as any,
    payload_hash: payloadHash,
  });

  if (error) logger.warn("Could not persist AI prediction", { model: args.model, error: error.message });
  return payloadHash;
}
