import { env, capabilities } from "../config/env";
import { logger } from "./logger";
import { canonicalHash, sha256Hex } from "./crypto";
import { AppError } from "./errors";
import { canonicalJson } from "../shared/integrity";
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
  const result = await post<Partial<Omit<AnomalyResult, "available">>>("/predict/evidence-anomaly", input);
  // The verdict goes into constrained columns (a score in 0-1, a text array), so
  // anything that is not the model's own shape — another service answering on
  // the port, a proxy's error page parsed as JSON — counts as no screening, not
  // as a registration that fails at the insert.
  if (!result || typeof result.anomaly !== "boolean" || typeof result.score !== "number" || !Number.isFinite(result.score)) {
    if (result) logger.warn("AI service answered evidence screening in an unexpected shape; treating it as unavailable");
    return { available: false, anomaly: false, score: 0, reasons: ["Screening unavailable"] };
  }
  return {
    available: true,
    anomaly: result.anomaly,
    score: Math.min(1, Math.max(0, Math.round(result.score * 1e5) / 1e5)),
    reasons: Array.isArray(result.reasons) ? result.reasons.filter((r): r is string => typeof r === "string").slice(0, 20) : [],
    modelVersion: typeof result.modelVersion === "string" ? result.modelVersion : undefined,
  };
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

/* ------------------------------------------------------------------- OCR */

/**
 * The proof block ai-service/src/ocr.py attaches to every reading. Every field
 * is a string or an integer, so its canonical JSON is the same bytes in Python
 * and here, and resultDigest can be recomputed rather than trusted.
 */
export interface OcrProof {
  confidencePct: number;
  engine: { name: string; version: string };
  inputSha256: string;
  pipeline: Record<string, unknown>;
  preprocessedSha256: string;
  textSha256: string;
  resultDigest: string;
}

export interface OcrResult {
  mode: "document" | "plate";
  text: string;
  confidence: number;
  variant: string;
  psm: number;
  candidates?: { plate: string; confidence: number; valid: boolean; corrections: number }[];
  improvement?: { rawConfidence: number; rawChars: number; bestConfidence: number; bestChars: number };
  deskewDegrees?: number;
  attempts?: unknown[];
  durationMs?: number;
  proof: OcrProof;
}

const HASH32 = /^0x[0-9a-f]{64}$/;

/**
 * Checks a reading's proof against the bytes it claims to describe. Returns the
 * problem in words, or null when the proof holds: the input digest is the one
 * expected, the text hashes to textSha256, and resultDigest is the canonical
 * digest of the rest.
 */
export function proofProblem(result: OcrResult, expectedInputSha256: string): string | null {
  const proof = result?.proof;
  if (!proof || typeof result.text !== "string") return "The OCR service returned no proof.";
  if (![proof.inputSha256, proof.preprocessedSha256, proof.textSha256, proof.resultDigest].every((h) => typeof h === "string" && HASH32.test(h))) {
    return "The OCR proof is malformed.";
  }
  if (proof.inputSha256 !== expectedInputSha256.toLowerCase()) return "The OCR service read different bytes from the registered file.";
  if (sha256Hex(Buffer.from(result.text, "utf8")) !== proof.textSha256) return "The returned text does not match its digest.";
  const { resultDigest, ...core } = proof;
  let recomputed: string;
  try {
    recomputed = sha256Hex(Buffer.from(canonicalJson(core), "utf8"));
  } catch {
    return "The OCR proof is not canonical.";
  }
  return recomputed === resultDigest ? null : "The OCR result digest does not match its contents.";
}

/**
 * Sends an image to the OCR service. Unlike screening, OCR is something an
 * officer asked for, so a failure is reported as an error with a reason rather
 * than degraded into "unavailable" silently. `expectedSha256` makes the service
 * refuse to read anything but the registered bytes.
 */
export async function ocrImage(
  bytes: Buffer,
  mode: "document" | "plate",
  options: { expectedSha256?: string; lang?: string } = {}
): Promise<OcrResult> {
  if (!capabilities.ai || !env.AI_SERVICE_URL) {
    throw new AppError(503, "OCR_UNAVAILABLE", "OCR runs in the AI service, and AI_SERVICE_URL is not set on this API.");
  }
  const query = mode === "document" && options.lang ? `?lang=${encodeURIComponent(options.lang)}` : "";
  let response: Response;
  try {
    response = await fetch(`${env.AI_SERVICE_URL.replace(/\/$/, "")}/ocr/${mode}${query}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(options.expectedSha256 ? { "x-expected-sha256": options.expectedSha256 } : {}),
        ...(env.AI_SERVICE_KEY ? { "x-ai-key": env.AI_SERVICE_KEY } : {}),
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(env.OCR_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("OCR service unreachable", { reason: error instanceof Error ? error.message : "unknown" });
    throw new AppError(503, "OCR_UNAVAILABLE", "The OCR service did not answer. Start it with `python app.py` in ai-service and retry.");
  }

  const body = (await response.json().catch(() => null)) as (OcrResult & { error?: string; message?: string }) | null;
  if (!response.ok) {
    const message = typeof body?.message === "string" ? body.message : `The OCR service answered ${response.status}.`;
    if (response.status === 503) throw new AppError(503, "OCR_UNAVAILABLE", message);
    if (response.status === 409) throw new AppError(409, "DIGEST_MISMATCH", message);
    if (response.status >= 400 && response.status < 500) throw new AppError(422, body?.error ?? "OCR_REFUSED", message);
    throw new AppError(502, "OCR_FAILED", message, undefined, { expose: true });
  }
  if (!body) throw new AppError(502, "OCR_FAILED", "The OCR service answered with something that is not JSON.", undefined, { expose: true });
  return body;
}
