import { canonicalJson, toCentimetres, toMicroDegrees } from "./canonical";
import { digestsEqual, sha256Hex } from "./sha256";

/**
 * The capture manifest: what the device knew at the moment of capture, committed
 * to by one digest.
 *
 * For a live capture, THIS digest is what goes on chain, not the file's. The file
 * digest is a field inside it. So the chain commits to the bytes, the place, the
 * device time and the device together, and changing any one of them — one pixel,
 * one micro-degree, one millisecond — changes the anchored value.
 *
 * What it does NOT prove is written into the UI and docs and repeated here so no
 * one reading the code forgets: it proves the bytes and metadata have not changed
 * since they were registered and that they came through this app. It does not
 * prove the scene was genuine, that the GPS was not spoofed, or that the camera
 * was not pointed at a screen.
 */

export const MANIFEST_SCHEMA = "nyaysetu.capture/1";

export type CaptureSource = "capture" | "upload";
export type MediaKind = "photo" | "video" | "audio_video" | "audio" | "document" | "physical";
export type CapturePurpose = "general" | "search_seizure" | "lab_intake";
export type CapturePlatform = "web" | "android" | "ios";

/**
 * OK            a fresh fix within the accuracy threshold
 * LOW_ACCURACY  a fresh fix, but its accuracy radius is wider than the threshold
 * NO_GPS        no fix: permission refused, no hardware, or no signal
 */
export type GpsStatus = "OK" | "LOW_ACCURACY" | "NO_GPS";
export type NoGpsReason = "DENIED" | "UNAVAILABLE" | "TIMEOUT" | "UNSUPPORTED";

export interface GpsFixInput {
  lat: number;
  lng: number;
  accuracyMetres: number;
  altitudeMetres?: number | null;
  /** When the fix was taken, by the device clock, in ms since the epoch. */
  takenAtMs: number;
  /** Android's isFromMockProvider / mocked flag, where the platform exposes it. */
  mocked?: boolean | null;
}

export interface ManifestFix {
  latE6: number;
  lngE6: number;
  accuracyCm: number;
  altitudeCm: number | null;
  takenAtMs: number;
  mocked: boolean | null;
}

export interface CaptureManifest {
  schema: typeof MANIFEST_SCHEMA;
  source: CaptureSource;
  mediaKind: MediaKind;
  purpose: CapturePurpose;
  file: { sha256: string; bytes: number; mimeType: string };
  caseRef: string;
  officerId: string;
  deviceId: string;
  appVersion: string;
  platform: CapturePlatform;
  /** Device clock at the moment the shutter fired (or recording started). */
  deviceTimeMs: number;
  /** Recording length; null for a still photograph. */
  durationMs: number | null;
  gps: {
    status: GpsStatus;
    noFixReason: NoGpsReason | null;
    thresholdCm: number;
    start: ManifestFix | null;
    /** Video only: the fix taken when recording stopped. */
    end: ManifestFix | null;
  };
  /**
   * 128 random bits. The manifest digest is public on chain; without a nonce,
   * someone holding the photograph could try to brute-force the coordinates out
   * of it by guessing candidate positions.
   */
  nonce: string;
}

export interface ManifestInput {
  source: CaptureSource;
  mediaKind: MediaKind;
  purpose?: CapturePurpose;
  file: { sha256: string; bytes: number; mimeType: string };
  caseRef: string;
  officerId: string;
  deviceId: string;
  appVersion: string;
  platform: CapturePlatform;
  deviceTimeMs: number;
  durationMs?: number | null;
  gpsStart?: GpsFixInput | null;
  gpsEnd?: GpsFixInput | null;
  noFixReason?: NoGpsReason | null;
  /** Accuracy radius above which a fix is tagged LOW_ACCURACY. */
  maxAccuracyMetres: number;
  /**
   * How old a fix may be relative to the capture time. A cached position from
   * an hour ago must never be recorded as where the photograph was taken.
   */
  maxFixAgeMs?: number;
  nonce: string;
}

export class ManifestError extends Error {
  constructor(
    readonly code:
      | "BAD_DIGEST"
      | "BAD_FIELD"
      | "STALE_FIX"
      | "FUTURE_FIX"
      | "BAD_COORDINATES"
      | "BAD_NONCE",
    message: string
  ) {
    super(message);
    this.name = "ManifestError";
  }
}

const HASH32 = /^0x[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const DEFAULT_MAX_FIX_AGE_MS = 60_000;

function requireText(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new ManifestError("BAD_FIELD", `${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new ManifestError("BAD_FIELD", `${label} must be an integer ≥ ${min}.`);
  }
  return value;
}

function encodeFix(fix: GpsFixInput, deviceTimeMs: number, maxAgeMs: number, label: string): ManifestFix {
  if (
    !Number.isFinite(fix.lat) ||
    !Number.isFinite(fix.lng) ||
    fix.lat < -90 ||
    fix.lat > 90 ||
    fix.lng < -180 ||
    fix.lng > 180
  ) {
    throw new ManifestError("BAD_COORDINATES", `${label} is not a valid point on Earth.`);
  }
  if (!Number.isFinite(fix.accuracyMetres) || fix.accuracyMetres < 0) {
    throw new ManifestError("BAD_FIELD", `${label} needs an accuracy radius.`);
  }
  requireInteger(fix.takenAtMs, `${label}.takenAtMs`);
  if (deviceTimeMs - fix.takenAtMs > maxAgeMs) {
    throw new ManifestError(
      "STALE_FIX",
      `${label} is ${Math.round((deviceTimeMs - fix.takenAtMs) / 1000)} s older than the capture. ` +
        "A cached position is not recorded as the place of capture; take a fresh fix."
    );
  }
  if (fix.takenAtMs - deviceTimeMs > maxAgeMs) {
    throw new ManifestError("FUTURE_FIX", `${label} is timestamped after the capture by more than the allowed window.`);
  }

  return {
    latE6: toMicroDegrees(fix.lat),
    lngE6: toMicroDegrees(fix.lng),
    accuracyCm: toCentimetres(fix.accuracyMetres),
    altitudeCm:
      fix.altitudeMetres === null || fix.altitudeMetres === undefined || !Number.isFinite(fix.altitudeMetres)
        ? null
        : toCentimetres(fix.altitudeMetres),
    takenAtMs: fix.takenAtMs,
    mocked: typeof fix.mocked === "boolean" ? fix.mocked : null,
  };
}

/** Builds and validates a manifest. Throws ManifestError on anything doubtful. */
export function buildCaptureManifest(input: ManifestInput): CaptureManifest {
  const fileSha = String(input.file?.sha256 ?? "").toLowerCase();
  if (!HASH32.test(fileSha)) throw new ManifestError("BAD_DIGEST", "file.sha256 must be a 0x-prefixed SHA-256.");
  if (!NONCE.test(input.nonce)) throw new ManifestError("BAD_NONCE", "nonce must be 32 lower-case hex characters.");

  const deviceTimeMs = requireInteger(input.deviceTimeMs, "deviceTimeMs");
  const maxAge = input.maxFixAgeMs ?? DEFAULT_MAX_FIX_AGE_MS;
  const thresholdCm = toCentimetres(input.maxAccuracyMetres);

  const start = input.gpsStart ? encodeFix(input.gpsStart, deviceTimeMs, maxAge, "gpsStart") : null;
  const endReference =
    input.durationMs && input.durationMs > 0 ? deviceTimeMs + input.durationMs : deviceTimeMs;
  const end = input.gpsEnd ? encodeFix(input.gpsEnd, endReference, maxAge, "gpsEnd") : null;

  let status: GpsStatus;
  if (!start) status = "NO_GPS";
  else if (start.accuracyCm > thresholdCm || (end !== null && end.accuracyCm > thresholdCm)) status = "LOW_ACCURACY";
  else status = "OK";

  return {
    schema: MANIFEST_SCHEMA,
    source: input.source,
    mediaKind: input.mediaKind,
    purpose: input.purpose ?? "general",
    file: {
      sha256: fileSha,
      bytes: requireInteger(input.file.bytes, "file.bytes"),
      mimeType: requireText(input.file.mimeType, "file.mimeType", 120),
    },
    caseRef: requireText(input.caseRef, "caseRef", 80),
    officerId: requireText(input.officerId, "officerId", 80),
    deviceId: requireText(input.deviceId, "deviceId", 120),
    appVersion: requireText(input.appVersion, "appVersion", 40),
    platform: input.platform,
    deviceTimeMs,
    durationMs:
      input.durationMs === null || input.durationMs === undefined
        ? null
        : requireInteger(input.durationMs, "durationMs"),
    gps: {
      status,
      noFixReason: start ? null : (input.noFixReason ?? "UNAVAILABLE"),
      thresholdCm,
      start,
      end,
    },
    nonce: input.nonce,
  };
}

/**
 * Structural check of a manifest that arrived from somewhere untrusted — an
 * upload, an offline sync bundle. Returns the list of problems; empty means valid.
 */
export function validateManifest(value: unknown): string[] {
  const problems: string[] = [];
  const m = value as Partial<CaptureManifest> | null;
  if (!m || typeof m !== "object") return ["manifest is not an object"];
  if (m.schema !== MANIFEST_SCHEMA) problems.push(`schema must be ${MANIFEST_SCHEMA}`);
  if (m.source !== "capture" && m.source !== "upload") problems.push("source must be capture or upload");
  if (!m.file || !HASH32.test(String(m.file.sha256))) problems.push("file.sha256 must be a SHA-256");
  if (!m.file || !Number.isSafeInteger(m.file.bytes)) problems.push("file.bytes must be an integer");
  if (typeof m.caseRef !== "string" || !m.caseRef) problems.push("caseRef is required");
  if (typeof m.officerId !== "string" || !m.officerId) problems.push("officerId is required");
  if (typeof m.deviceId !== "string" || !m.deviceId) problems.push("deviceId is required");
  if (!Number.isSafeInteger(m.deviceTimeMs)) problems.push("deviceTimeMs must be an integer");
  if (!m.gps || !["OK", "LOW_ACCURACY", "NO_GPS"].includes(String(m.gps.status))) problems.push("gps.status is invalid");
  if (m.gps && m.gps.status !== "NO_GPS" && !m.gps.start) problems.push("gps.start is required unless status is NO_GPS");
  if (typeof m.nonce !== "string" || !NONCE.test(m.nonce)) problems.push("nonce must be 32 hex characters");
  try {
    canonicalJson(value);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "not canonicalisable");
  }
  return problems;
}

/** The canonical bytes of the manifest, as UTF-8 text. */
export function manifestCanonical(manifest: CaptureManifest): string {
  return canonicalJson(manifest);
}

/** SHA-256 of the canonical manifest: the value anchored on chain for a capture. */
export function manifestDigest(manifest: CaptureManifest): string {
  return sha256Hex(canonicalJson(manifest));
}

/** The same manifest with a different file digest — used to test a candidate file. */
export function withFileDigest(manifest: CaptureManifest, fileSha256: string): CaptureManifest {
  return { ...manifest, file: { ...manifest.file, sha256: fileSha256.toLowerCase() } };
}

export interface CaptureVerification {
  /** The candidate file's digest equals the one recorded in the manifest. */
  fileMatchesManifest: boolean;
  /** The manifest, with the candidate's digest substituted, hashes to the anchored value. */
  manifestMatchesAnchor: boolean;
  derivedDigest: string;
}

/**
 * The two-step check: file → manifest → chain. Both must hold for a capture to
 * verify, and they are reported separately so a UI can say which one failed.
 */
export function verifyCapture(args: {
  manifest: CaptureManifest;
  candidateFileSha256: string;
  anchoredDigest: string;
}): CaptureVerification {
  const derived = manifestDigest(withFileDigest(args.manifest, args.candidateFileSha256));
  return {
    fileMatchesManifest: digestsEqual(args.manifest.file.sha256, args.candidateFileSha256),
    manifestMatchesAnchor: digestsEqual(derived, args.anchoredDigest),
    derivedDigest: derived,
  };
}

/** Device clock against server clock, in whole seconds. Positive: device ahead. */
export function clockSkewSeconds(deviceTimeMs: number, serverTimeMs: number): number {
  return Math.round((deviceTimeMs - serverTimeMs) / 1000);
}
