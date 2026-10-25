import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildCaptureManifest,
  canonicalJson,
  CanonicalError,
  manifestDigest,
  ManifestError,
  validateManifest,
  verifyCapture,
  withFileDigest,
  toMicroDegrees,
  type ManifestInput,
} from "../src";
import vectors from "./vectors.json";

const FILE = "0x" + "ab".repeat(32);

function base(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    source: "capture",
    mediaKind: "photo",
    file: { sha256: FILE, bytes: 2_456_789, mimeType: "image/jpeg" },
    caseRef: "NS/PUNE-SHIVAJINAGAR/2026/000042",
    officerId: "8d1f5b9e-2f7a-4f5e-9b9b-1d0c4e1f7a10",
    deviceId: "web-3f2a9c",
    appVersion: "2.0.0",
    platform: "web",
    deviceTimeMs: 1_760_000_000_000,
    gpsStart: { lat: 18.5308, lng: 73.8478, accuracyMetres: 8.4, altitudeMetres: 560.2, takenAtMs: 1_759_999_998_500 },
    maxAccuracyMetres: 50,
    nonce: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

test("canonical JSON sorts keys at every depth and has no whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: "x" } }), '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}');
  assert.equal(canonicalJson({ k: -0 }), '{"k":0}');
  assert.equal(canonicalJson({ skip: undefined, keep: "न्याय" }), '{"keep":"न्याय"}');
});

test("canonical JSON refuses values with more than one spelling", () => {
  assert.throws(() => canonicalJson({ lat: 18.5308 }), CanonicalError);
  assert.throws(() => canonicalJson({ n: Number.NaN }), CanonicalError);
  assert.throws(() => canonicalJson({ big: 2 ** 60 }), CanonicalError);
  assert.throws(() => canonicalJson([1, undefined]), /undefined inside an array/);
  assert.throws(() => canonicalJson({ when: new Date() }), /plain objects/);
  assert.throws(() => canonicalJson({ id: BigInt(1) }), /Unsupported type bigint/);
});

test("micro-degree rounding matches the backend and GeoMath (Math.round)", () => {
  assert.equal(toMicroDegrees(18.5308), 18_530_800);
  assert.equal(toMicroDegrees(-73.8478005), -73_847_800);
  assert.equal(toMicroDegrees(0.0000005), 1);
});

test("golden vector: the manifest digest has not changed since it was fixed", () => {
  const manifest = buildCaptureManifest(vectors.manifestInput as ManifestInput);
  assert.equal(canonicalJson(manifest), vectors.canonical);
  assert.equal(manifestDigest(manifest), vectors.digest);
  // And it is plain SHA-256 of the canonical UTF-8, nothing exotic.
  assert.equal("0x" + createHash("sha256").update(vectors.canonical, "utf8").digest("hex"), vectors.digest);
});

test("key order of the input does not change the digest", () => {
  const a = buildCaptureManifest(base());
  const shuffled = JSON.parse(JSON.stringify(a));
  const reversed = Object.fromEntries(Object.entries(shuffled).reverse());
  assert.equal(manifestDigest(reversed as any), manifestDigest(a));
});

test("one changed pixel, coordinate or millisecond each changes the anchored digest", () => {
  const original = manifestDigest(buildCaptureManifest(base()));

  const pixel = manifestDigest(buildCaptureManifest(base({ file: { sha256: "0x" + "ab".repeat(31) + "ac", bytes: 2_456_789, mimeType: "image/jpeg" } })));
  const gps = manifestDigest(
    buildCaptureManifest(base({ gpsStart: { lat: 18.530801, lng: 73.8478, accuracyMetres: 8.4, altitudeMetres: 560.2, takenAtMs: 1_759_999_998_500 } }))
  );
  const time = manifestDigest(buildCaptureManifest(base({ deviceTimeMs: 1_760_000_000_001 })));

  for (const [label, changed] of Object.entries({ pixel, gps, time })) {
    assert.notEqual(changed, original, label);
  }
});

test("a stale or future fix is refused, never recorded as the place of capture", () => {
  assert.throws(
    () => buildCaptureManifest(base({ gpsStart: { lat: 18.5, lng: 73.8, accuracyMetres: 5, takenAtMs: 1_760_000_000_000 - 10 * 60_000 } })),
    (error: unknown) => error instanceof ManifestError && error.code === "STALE_FIX"
  );
  assert.throws(
    () => buildCaptureManifest(base({ gpsStart: { lat: 18.5, lng: 73.8, accuracyMetres: 5, takenAtMs: 1_760_000_000_000 + 10 * 60_000 } })),
    (error: unknown) => error instanceof ManifestError && error.code === "FUTURE_FIX"
  );
});

test("accuracy and permission outcomes are tagged, not hidden", () => {
  assert.equal(buildCaptureManifest(base()).gps.status, "OK");

  const wide = buildCaptureManifest(base({ gpsStart: { lat: 18.5, lng: 73.8, accuracyMetres: 900, takenAtMs: 1_760_000_000_000 } }));
  assert.equal(wide.gps.status, "LOW_ACCURACY");
  assert.equal(wide.gps.start?.accuracyCm, 90_000);

  const denied = buildCaptureManifest(base({ gpsStart: null, noFixReason: "DENIED" }));
  assert.equal(denied.gps.status, "NO_GPS");
  assert.equal(denied.gps.noFixReason, "DENIED");
  assert.equal(denied.gps.start, null);
});

test("upload and capture are distinguishable inside the digest", () => {
  const capture = manifestDigest(buildCaptureManifest(base({ source: "capture" })));
  const upload = manifestDigest(buildCaptureManifest(base({ source: "upload" })));
  assert.notEqual(capture, upload);
});

test("verifyCapture reports file and manifest steps separately", () => {
  const manifest = buildCaptureManifest(base());
  const anchored = manifestDigest(manifest);

  const genuine = verifyCapture({ manifest, candidateFileSha256: FILE, anchoredDigest: anchored });
  assert.deepEqual([genuine.fileMatchesManifest, genuine.manifestMatchesAnchor], [true, true]);

  const tamperedFile = verifyCapture({ manifest, candidateFileSha256: "0x" + "cd".repeat(32), anchoredDigest: anchored });
  assert.deepEqual([tamperedFile.fileMatchesManifest, tamperedFile.manifestMatchesAnchor], [false, false]);

  // A manifest edited to agree with a tampered file still cannot match the chain.
  const forged = withFileDigest(manifest, "0x" + "cd".repeat(32));
  const forgedCheck = verifyCapture({ manifest: forged, candidateFileSha256: "0x" + "cd".repeat(32), anchoredDigest: anchored });
  assert.equal(forgedCheck.fileMatchesManifest, true);
  assert.equal(forgedCheck.manifestMatchesAnchor, false);
});

test("validateManifest catches a malformed bundle from an untrusted sender", () => {
  assert.deepEqual(validateManifest(buildCaptureManifest(base())), []);
  const broken = { ...buildCaptureManifest(base()), nonce: "short", gps: { status: "OK", start: null } };
  const problems = validateManifest(broken);
  assert.ok(problems.some((p) => p.includes("nonce")));
  assert.ok(problems.some((p) => p.includes("gps.start")));
  assert.deepEqual(validateManifest(null), ["manifest is not an object"]);
});
