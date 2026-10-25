import * as crypto from "crypto";
import { db, unwrapMaybe } from "../lib/supabase";
import { badRequest, conflict, forbidden } from "../lib/errors";
import { decryptField } from "../lib/crypto";
import { env } from "../config/env";
import {
  canonicalJson,
  clockSkewSeconds,
  fromMicroDegrees,
  manifestDigest,
  validateManifest,
  withFileDigest,
  type CaptureManifest,
} from "../shared/integrity";

/**
 * Live capture (2.0 · F10, F12).
 *
 * The device builds a canonical manifest — file digest, GPS fix with its accuracy
 * radius, device time, device id, case reference, app version — and the server
 * anchors the manifest's SHA-256 instead of the file's (docs/DECISIONS.md D-04).
 *
 * Everything the device says is re-checked here against what can be checked: the
 * bytes that arrived, the case, the signed-in officer, the clock. What cannot be
 * checked — whether the GPS was spoofed, whether the camera pointed at a screen —
 * is said plainly on every screen that shows the result.
 */

export interface SignatureEnvelope {
  alg: "ECDSA-P256-SHA256" | "HMAC-SHA256";
  keyId: string;
  /** base64url signature over the canonical manifest bytes (P1363 r||s for ECDSA). */
  value: string;
}

export interface CaptureCheck {
  manifest: CaptureManifest;
  manifestHash: string;
  gps: { lat: number | null; lng: number | null; accuracyMetres: number | null; status: string; mocked: boolean | null };
  deviceTime: string;
  skewSeconds: number | null;
  skewFlagged: boolean;
  signatureStatus: "none" | "valid" | "invalid" | "unknown_key";
  purpose: string;
  durationMs: number | null;
  deviceId: string;
  appVersion: string;
}

function parseJsonField<T>(raw: unknown, label: string): T | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw badRequest(`${label} is not valid JSON.`);
  }
}

export function parseManifestField(raw: unknown): CaptureManifest | null {
  return parseJsonField<CaptureManifest>(raw, "manifest");
}

export function parseSignatureField(raw: unknown): SignatureEnvelope | null {
  const value = parseJsonField<SignatureEnvelope>(raw, "signature");
  if (!value) return null;
  if (
    !["ECDSA-P256-SHA256", "HMAC-SHA256"].includes(value.alg) ||
    typeof value.keyId !== "string" ||
    typeof value.value !== "string" ||
    value.value.length > 512
  ) {
    throw badRequest("signature must be {alg, keyId, value}.");
  }
  return value;
}

/**
 * Verifies a device signature over the canonical manifest. Never throws: an
 * unknown key or a bad signature is recorded and flagged, because refusing the
 * upload would lose evidence that is otherwise intact and anchored by digest.
 */
export async function verifySignature(
  manifest: CaptureManifest,
  signature: SignatureEnvelope | null,
  userId: string
): Promise<CaptureCheck["signatureStatus"]> {
  if (!signature) return "none";
  const key = unwrapMaybe(
    await db
      .from("device_keys")
      .select("key_id, user_id, algorithm, public_jwk, secret_encrypted, revoked_at")
      .eq("key_id", signature.keyId)
      .maybeSingle()
  ) as any;
  if (!key || key.revoked_at || key.user_id !== userId || key.algorithm !== signature.alg) return "unknown_key";

  const message = Buffer.from(canonicalJson(manifest), "utf8");
  const presented = Buffer.from(signature.value, "base64url");

  try {
    if (key.algorithm === "ECDSA-P256-SHA256") {
      const publicKey = crypto.createPublicKey({ key: key.public_jwk, format: "jwk" });
      const ok = crypto.verify("sha256", message, { key: publicKey, dsaEncoding: "ieee-p1363" }, presented);
      return ok ? "valid" : "invalid";
    }
    const secret = Buffer.from(decryptField(key.secret_encrypted), "hex");
    const expected = crypto.createHmac("sha256", secret).update(message).digest();
    return expected.length === presented.length && crypto.timingSafeEqual(expected, presented) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * Checks a capture manifest against the request it arrived with. Throws for
 * anything that would make the anchored digest describe something other than
 * this file, this case and this officer.
 */
export async function checkCapture(args: {
  manifest: unknown;
  signature: SignatureEnvelope | null;
  serverFileHash: string;
  fileBytes: number;
  caseReference: string;
  userId: string;
  deviceClockAtSendMs: number | null;
  nowMs?: number;
}): Promise<CaptureCheck> {
  const problems = validateManifest(args.manifest);
  if (problems.length > 0) throw badRequest("The capture manifest is malformed.", { problems });
  const manifest = args.manifest as CaptureManifest;

  if (manifest.file.sha256.toLowerCase() !== args.serverFileHash.toLowerCase()) {
    throw conflict(
      "The manifest names a different file digest from the bytes that arrived. Nothing was registered.",
      { manifestFileHash: manifest.file.sha256, serverHash: args.serverFileHash }
    );
  }
  if (manifest.file.bytes !== args.fileBytes) {
    throw conflict("The manifest names a different file size from the bytes that arrived.");
  }
  if (manifest.caseRef !== args.caseReference) {
    throw conflict("The manifest was captured for a different case reference.", {
      manifestCaseRef: manifest.caseRef,
      caseReference: args.caseReference,
    });
  }
  if (manifest.officerId !== args.userId) {
    throw forbidden("A capture can only be registered by the officer who made it.");
  }

  // The status the device recorded must agree with its own numbers.
  const start = manifest.gps.start;
  const end = manifest.gps.end;
  const widest = Math.max(start?.accuracyCm ?? 0, end?.accuracyCm ?? 0);
  const expectedStatus = !start ? "NO_GPS" : widest > manifest.gps.thresholdCm ? "LOW_ACCURACY" : "OK";
  if (manifest.gps.status !== expectedStatus) {
    throw badRequest(`The manifest says GPS was ${manifest.gps.status} but its own fix says ${expectedStatus}.`);
  }
  if (env.CAPTURE_REQUIRE_GPS && manifest.source === "capture" && manifest.gps.status === "NO_GPS") {
    throw badRequest("This deployment requires a GPS fix for every live capture.");
  }

  const now = args.nowMs ?? Date.now();
  const tolerance = env.CLOCK_SKEW_TOLERANCE_SECONDS;
  const skew = args.deviceClockAtSendMs === null ? null : clockSkewSeconds(args.deviceClockAtSendMs, now);
  // A capture timestamped in the future by more than the tolerance is suspect
  // whatever the send-time clock says.
  const futureCapture = manifest.deviceTimeMs - now > tolerance * 1000;

  return {
    manifest,
    manifestHash: manifestDigest(manifest),
    gps: {
      lat: start ? fromMicroDegrees(start.latE6) : null,
      lng: start ? fromMicroDegrees(start.lngE6) : null,
      accuracyMetres: start ? start.accuracyCm / 100 : null,
      status: manifest.gps.status,
      mocked: start?.mocked ?? null,
    },
    deviceTime: new Date(manifest.deviceTimeMs).toISOString(),
    skewSeconds: skew,
    skewFlagged: futureCapture || (skew !== null && Math.abs(skew) > tolerance),
    signatureStatus: await verifySignature(manifest, args.signature, args.userId),
    purpose: manifest.purpose,
    durationMs: manifest.durationMs,
    deviceId: manifest.deviceId,
    appVersion: manifest.appVersion,
  };
}

/**
 * What goes on chain for a given file digest, for this item: the file digest
 * itself for an upload, or the manifest's digest with that file digest
 * substituted in for a capture. Used at every custody handover and re-check, so
 * the receiver hashes the file they hold and the server does the rest.
 */
export function digestForChain(item: { anchor_mode?: string | null; capture_manifest?: unknown }, fileSha256: string): string {
  if (item.anchor_mode === "manifest" && item.capture_manifest) {
    return manifestDigest(withFileDigest(item.capture_manifest as CaptureManifest, fileSha256));
  }
  return fileSha256.toLowerCase();
}
