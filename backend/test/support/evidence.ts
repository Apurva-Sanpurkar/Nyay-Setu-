import { createHash, randomBytes } from "crypto";
import { call, type Actor } from "./harness";
import { buildCaptureManifest, type ManifestInput, type CaptureManifest } from "../../src/shared/integrity";

export const sha = (bytes: Buffer) => "0x" + createHash("sha256").update(bytes).digest("hex");

export async function createCase(actor: Actor, extra: Record<string, unknown> = {}) {
  const response = await call(actor, "POST", "/api/cases", {
    body: {
      title: "Burglary at a warehouse",
      offenceType: "Burglary",
      policeStation: "Shivajinagar PS",
      origin: "complaint",
      ...extra,
    },
  });
  if (response.status !== 201) throw new Error(`case creation failed: ${JSON.stringify(response.body)}`);
  return response.body.case as { id: string; case_reference: string };
}

export async function uploadEvidence(
  actor: Actor,
  caseId: string,
  options: { bytes?: Buffer; headers?: Record<string, string>; notes?: string; gps?: boolean } = {}
) {
  const bytes = options.bytes ?? randomBytes(2048);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/jpeg" }), "scene.jpg");
  form.append("caseId", caseId);
  form.append("clientHash", sha(bytes));
  form.append("kind", "photo");
  form.append("source", "upload");
  if (options.gps !== false) {
    form.append("gpsLat", "18.5308");
    form.append("gpsLng", "73.8478");
  }
  form.append("collectedAt", new Date().toISOString());
  if (options.notes) form.append("notes", options.notes);
  const response = await call(actor, "POST", "/api/evidence", { form, headers: options.headers });
  return { response, bytes };
}

export function manifestFor(
  actor: Actor,
  caseReference: string,
  bytes: Buffer,
  overrides: Partial<ManifestInput> = {}
): CaptureManifest {
  const now = Date.now();
  return buildCaptureManifest({
    source: "capture",
    mediaKind: "photo",
    file: { sha256: sha(bytes), bytes: bytes.length, mimeType: "image/jpeg" },
    caseRef: caseReference,
    officerId: actor.id,
    deviceId: "web-test-device-01",
    appVersion: "2.0.0",
    platform: "web",
    deviceTimeMs: now,
    gpsStart: { lat: 18.5308225, lng: 73.8474647, accuracyMetres: 7.5, takenAtMs: now - 1500, mocked: false },
    maxAccuracyMetres: 50,
    nonce: randomBytes(16).toString("hex"),
    ...overrides,
  });
}

export async function captureEvidence(
  actor: Actor,
  caseId: string,
  manifest: CaptureManifest,
  bytes: Buffer,
  options: { headers?: Record<string, string>; signature?: unknown; deviceClockAtSendMs?: number; kind?: string } = {}
) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: manifest.file.mimeType }), "capture.jpg");
  form.append("caseId", caseId);
  form.append("clientHash", sha(bytes));
  form.append("kind", options.kind ?? "photo");
  form.append("source", "capture");
  form.append("collectedAt", new Date(manifest.deviceTimeMs).toISOString());
  form.append("manifest", JSON.stringify(manifest));
  if (options.signature) form.append("signature", JSON.stringify(options.signature));
  form.append("deviceClockAtSendMs", String(options.deviceClockAtSendMs ?? Date.now()));
  return call(actor, "POST", "/api/evidence", { form, headers: options.headers });
}
