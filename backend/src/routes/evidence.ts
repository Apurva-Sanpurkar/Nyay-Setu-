import { Request, Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env } from "../config/env";
import { badRequest, notFound } from "../lib/errors";
import { asyncRoute } from "../middleware/error";
import { validate, hash32, uuid, latitude, longitude, safeText } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import {
  registerEvidence,
  retryRegistration,
  transferCustody,
  verifyAgainstChain,
  custodyTimeline,
  fetchPlaintext,
  listCaseEvidence,
  loadEvidence,
  inboxFor,
  stripEnvelope,
  verificationFor,
  presentVerification,
  verificationSummary,
} from "../services/evidence.service";
import { anchorHistory, loadAnchor, recheck } from "../services/verification/anchors";
import { parseManifestField, parseSignatureField } from "../services/capture.service";
import { assembleUpload, consumeUpload } from "../services/upload.service";

const witnessSchema = z
  .array(z.object({ name: z.string().trim().min(2).max(120), description: z.string().trim().max(200).optional() }))
  .max(10);
const checklistSchema = z.record(z.string().max(40), z.boolean());

function jsonField(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest(`${label} is not valid JSON.`);
  }
}

function parseWitnesses(raw: string | undefined) {
  if (!raw) return null;
  const parsed = witnessSchema.safeParse(jsonField(raw, "witnesses"));
  if (!parsed.success) throw badRequest("witnesses must be a list of {name, description}.");
  return parsed.data;
}

function parseChecklist(raw: string | undefined) {
  if (!raw) return null;
  const parsed = checklistSchema.safeParse(jsonField(raw, "searchChecklist"));
  if (!parsed.success) throw badRequest("searchChecklist must be an object of booleans.");
  return parsed.data;
}
import { authorisedPassport, canSeeCaptureDetail, verifyUrl } from "../services/passport/passport.service";
import { buildPassportPdf } from "../lib/pdf/passport";
import { renderCertificate } from "../services/certificate.service";
import { fileReport } from "../services/lab.service";
import { canonicalJson } from "../shared/integrity";
import { forbidden } from "../lib/errors";
import { recordAction } from "../services/audit";

/**
 * The Idempotency-Key header, validated. Chain-writing routes accept one so a
 * client that retries after a dropped connection cannot register an item twice.
 */
function idempotencyKey(req: Request): string | null {
  const raw = req.get("idempotency-key");
  if (!raw) return null;
  if (!/^[A-Za-z0-9:_-]{8,120}$/.test(raw)) {
    throw badRequest("Idempotency-Key must be 8-120 characters of letters, digits, colon, dash or underscore.");
  }
  return raw;
}

const router = Router();
router.use(requireAuth);

// Files are held in memory and never written to a temp directory, so an
// unencrypted evidence file never touches the server's disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1 },
});

const registerSchema = z
  .object({
    caseId: uuid,
    // The digest the device computed before the upload started.
    clientHash: hash32,
    kind: z.enum(["photo", "video", "document", "audio", "physical"]),
    // Optional: an upload of an existing file may have no meaningful position,
    // and a live capture carries its fix inside the manifest instead.
    gpsLat: latitude.optional().nullable(),
    gpsLng: longitude.optional().nullable(),
    collectedAt: z.string().datetime({ offset: true }),
    deviceReportedMtime: z.string().datetime({ offset: true }).optional().nullable(),
    notes: safeText(2000).optional().nullable(),
    source: z.enum(["upload", "capture"]).default("upload"),
    // JSON text fields: multipart cannot carry nested objects.
    manifest: z.string().max(20_000).optional(),
    signature: z.string().max(2_000).optional(),
    deviceClockAtSendMs: z.coerce.number().int().positive().optional(),
    // A long recording sent in resumable pieces (F12) instead of as `file`.
    uploadId: uuid.optional(),
    // Search and seizure: witnesses present (JSON array) and the checklist.
    witnesses: z.string().max(4_000).optional(),
    searchChecklist: z.string().max(2_000).optional(),
  })
  .refine((v) => (v.gpsLat === undefined || v.gpsLat === null) === (v.gpsLng === undefined || v.gpsLng === null), {
    message: "Give both coordinates or neither.",
    path: ["gpsLng"],
  });

/**
 * Register evidence collected at a scene.
 *
 * Multipart, because the file and its metadata arrive together. clientHash is
 * the digest the device computed over the raw bytes before the upload began;
 * the service recomputes it server-side and refuses any disagreement.
 */
router.post(
  "/",
  // The laboratory registers only its own packaging photographs (F14), as live
  // captures with purpose lab_intake; everything else is police.
  requireRole("police", "forensic_lab"),
  writeLimiter,
  upload.single("file"),
  asyncRoute(async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw badRequest(
        "Invalid evidence metadata.",
        Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message]))
      );
    }

    await assertCaseAccess(req, parsed.data.caseId, "write");

    // The bytes come either with this request or from a completed resumable upload.
    let file: { buffer: Buffer; originalname: string; mimetype: string };
    if (parsed.data.uploadId) {
      if (req.file) throw badRequest("Send either a file or an uploadId, not both.");
      const assembled = await assembleUpload(req.user!, parsed.data.uploadId, parsed.data.caseId);
      file = { buffer: assembled.buffer, originalname: assembled.session.file_name, mimetype: assembled.session.mime_type };
    } else {
      if (!req.file) throw badRequest("Attach the evidence file as the `file` field, or send an uploadId.");
      file = req.file;
    }
    const witnesses = parseWitnesses(parsed.data.witnesses);
    const searchChecklist = parseChecklist(parsed.data.searchChecklist);

    const manifest = parseManifestField(parsed.data.manifest);
    const signature = parseSignatureField(parsed.data.signature);
    if (req.user!.role === "forensic_lab" && (parsed.data.source !== "capture" || (manifest as any)?.purpose !== "lab_intake")) {
      throw forbidden("The laboratory registers only live packaging photographs taken at intake (purpose lab_intake).");
    }
    if (parsed.data.source === "upload" && manifest) {
      throw badRequest("An uploaded file is anchored by its own digest; send source=capture with a manifest for a live capture.");
    }

    const result = await registerEvidence(req, req.user!, {
      caseId: parsed.data.caseId,
      clientHash: parsed.data.clientHash,
      fileName: file.originalname,
      mimeType: file.mimetype || "application/octet-stream",
      kind: parsed.data.kind,
      buffer: file.buffer,
      gpsLat: parsed.data.gpsLat ?? null,
      gpsLng: parsed.data.gpsLng ?? null,
      source: parsed.data.source,
      manifest,
      signature,
      deviceClockAtSendMs: parsed.data.deviceClockAtSendMs ?? null,
      collectedAt: parsed.data.collectedAt,
      deviceReportedMtime: parsed.data.deviceReportedMtime ?? null,
      notes: parsed.data.notes ?? null,
      idempotencyKey: idempotencyKey(req),
      witnesses,
      searchChecklist,
    });

    if (parsed.data.uploadId && !result.replayed) await consumeUpload(parsed.data.uploadId, result.evidence.id);

    // 200 for a replay of a request already handled; 201 for a new record,
    // whatever state its anchoring reached. The body always says which state.
    res.status(result.replayed ? 200 : 201).json(result);
  })
);

/** Verification states across the caller's cases, and what needs attention. */
router.get(
  "/summary",
  asyncRoute(async (req, res) => {
    res.json(await verificationSummary(req.user!));
  })
);

/** Items waiting for the caller's role to accept custody. */
router.get(
  "/inbox",
  requireRole("forensic_lab", "prosecutor", "judge"),
  asyncRoute(async (req, res) => {
    res.json({ items: await inboxFor(req.user!.role, req.user!.id) });
  })
);

router.get(
  "/case/:caseId",
  validate(z.object({ caseId: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json({ items: await listCaseEvidence(req.params.caseId) });
  })
);

router.get(
  "/:id",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);

    // Neither the key id nor the auth tag is any use to a client, and both are
    // part of the encryption envelope, so they stay server-side.
    res.json({ evidence: stripEnvelope(item), verification: await verificationFor(item) });
  })
);

/** Both trails side by side, so the UI can prove they agree. */
router.get(
  "/:id/custody",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);

    const timeline = await custodyTimeline(req.params.id);
    res.json({ ...timeline, evidence: stripEnvelope(timeline.evidence) });
  })
);

/**
 * Accept custody. The receiving role submits the digest it recomputed from the
 * artefact it was handed, and a mismatch is anchored before being refused.
 */
router.post(
  "/:id/custody",
  requireRole("forensic_lab", "prosecutor", "judge"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ confirmedHash: hash32 })),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id, "write");

    const result = await transferCustody(
      req,
      req.user!,
      req.params.id,
      req.body.confirmedHash,
      idempotencyKey(req) ?? undefined
    );
    res.json(result);
  })
);

/**
 * Independent verification. Open to every role assigned to the case, which is
 * how the defence uses it: the answer is read from the chain, not from the
 * prosecution's database.
 */
router.post(
  "/:id/verify",
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      submittedHash: hash32,
      // Anchoring costs gas, so the caller chooses. The defence anchors, so the
      // verification itself becomes part of the record.
      anchor: z.coerce.boolean().default(true),
    })
  ),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);

    const result = await verifyAgainstChain(
      req,
      req.user!,
      req.params.id,
      req.body.submittedHash,
      req.body.anchor
    );
    res.json(result);
  })
);

/**
 * Verification from a file rather than a precomputed digest. The frontend
 * normally hashes in the browser with WebCrypto; this exists for the case where
 * counsel has only the file and wants the server to do the arithmetic.
 */
router.post(
  "/:id/verify-file",
  validate(z.object({ id: uuid }), "params"),
  upload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) throw badRequest("Attach the file to verify as the `file` field.");

    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);

    const { sha256Hex } = await import("../lib/crypto");
    const digest = sha256Hex(req.file.buffer);

    const result = await verifyAgainstChain(req, req.user!, req.params.id, digest, true);
    res.json({ ...result, computedHash: digest, fileName: req.file.originalname });
  })
);

/** Kept for 1.0 clients; now the versioned report workflow (F14). See /api/lab/evidence/:id/reports. */
router.post(
  "/:id/forensic-report",
  requireRole("forensic_lab"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      conclusion: safeText(500).pipe(z.string().min(10)),
      detail: safeText(20000).optional().nullable(),
      tool: safeText(160).optional(),
      method: safeText(1000).optional(),
    })
  ),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id, "write");
    const result = await fileReport(req, req.user!, req.params.id, {
      conclusion: req.body.conclusion,
      detail: req.body.detail ?? null,
      analystName: req.user!.fullName,
      tool: req.body.tool ?? "not stated",
      method: req.body.method ?? "not stated",
    });
    res.status(201).json(result);
  })
);

router.get(
  "/:id/forensic-reports",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);

    const { db, unwrapList } = await import("../lib/supabase");
    const reports = unwrapList(
      await db
        .from("forensic_reports")
        .select("id, report_hash, conclusion, detail, created_at, tx_hash, lab_id, version, supersedes_id, analyst_name, tool, method")
        .eq("evidence_id", req.params.id)
        .order("created_at", { ascending: false })
    );
    res.json({ reports });
  })
);

/**
 * Download the original file, decrypted.
 *
 * Not available to the defence: counsel verifies integrity against the chain
 * and receives disclosure through the court, not through this API. The response
 * carries the recomputed digest in a header so a client can re-check it.
 */
router.get(
  "/:id/download",
  requireRole("police", "forensic_lab", "prosecutor", "judge", "court_admin"),
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);

    const { plaintext, digest, intact } = await fetchPlaintext(req.params.id);

    res.setHeader("content-type", item.mime_type || "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(item.file_name)}"`);
    res.setHeader("x-nyaysetu-sha256", digest);
    res.setHeader("x-nyaysetu-integrity", intact ? "verified" : "MISMATCH");
    res.send(plaintext);
  })
);

/**
 * The item's verification state and its full history. Every assigned role may
 * read it: whether something is confirmed is not a secret from anyone who can
 * see the item at all.
 */
router.get(
  "/:id/verification",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);
    if (!item.anchor_id) return res.json({ verification: presentVerification(null), history: [] });
    const anchor = await loadAnchor(item.anchor_id);
    res.json({ verification: presentVerification(anchor), history: await anchorHistory(anchor.id) });
  })
);

/** Resend a registration that failed to anchor. Police with write access, or the registry. */
router.post(
  "/:id/anchor/retry",
  requireRole("police", "court_admin"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id, "write");
    res.json(await retryRegistration(req, req.user!, req.params.id));
  })
);

/**
 * Look at the chain now rather than waiting for the tracker. Moves the state only
 * if what it sees justifies it; it cannot be used to declare anything confirmed.
 */
router.post(
  "/:id/anchor/recheck",
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);
    if (!item.anchor_id) throw badRequest("This item has no registration anchor.");
    const before = await loadAnchor(item.anchor_id);
    const after = await recheck(before, { id: req.user!.id, role: req.user!.role });
    await recordAction(req, {
      action: "evidence.recheck_anchor",
      subject: item.id,
      caseId: item.case_id,
      detail: { state: after.state, fromState: before.state },
    });
    res.json({ verification: presentVerification(after), changed: after.state !== before.state });
  })
);

/**
 * The Passport as an assigned role sees it: the public view plus capture
 * quality, and — for every role but the accused — where it was captured.
 */
router.get(
  "/:id/passport",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);
    const view = await authorisedPassport(item.id, req.user!.role);
    res.json({ ...view, verifyUrl: verifyUrl(view.passport.reference) });
  })
);

/** The authorised PDF edition. Capture quality, never coordinates. */
router.get(
  "/:id/passport.pdf",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);
    const view = await authorisedPassport(item.id, req.user!.role);
    const c = view.capture;
    const pdf = await buildPassportPdf(view.passport, {
      verifyUrl: verifyUrl(view.passport.reference),
      generatedFor: req.user!.role.replace(/_/g, " "),
      capture: c
        ? {
            source: c.source,
            purpose: c.purpose,
            deviceTime: c.deviceTime,
            serverReceivedAt: c.serverReceivedAt,
            clockSkewSeconds: c.clockSkewSeconds,
            clockSkewFlagged: c.clockSkewFlagged,
            gpsStatus: c.gps.status,
            accuracyMetres: c.gps.accuracyMetres,
            mocked: c.gps.mocked,
            signatureStatus: c.signatureStatus,
            durationMs: c.durationMs,
            fileSha256: c.fileSha256,
            manifestHash: c.manifestHash,
          }
        : null,
    });
    await recordAction(req, { action: "evidence.passport_pdf", subject: item.id, caseId: item.case_id });
    res
      .status(200)
      .setHeader("content-type", "application/pdf")
      .setHeader("content-disposition", `inline; filename="passport-${view.passport.reference}.pdf"`)
      .send(pdf);
  })
);

/**
 * The canonical capture manifest, byte for byte as it was hashed. With it, and
 * the file, anyone can recompute both digests offline. Contains coordinates, so
 * the accused does not receive it.
 */
router.get(
  "/:id/manifest",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);
    if (!canSeeCaptureDetail(req.user!.role)) throw forbidden("The capture manifest is not available to your role.");
    if (!item.capture_manifest) throw badRequest("This item was uploaded, not captured live, so it has no manifest.");
    await recordAction(req, { action: "evidence.manifest_download", subject: item.id, caseId: item.case_id });
    res
      .setHeader("content-type", "application/json; charset=utf-8")
      .setHeader("content-disposition", `attachment; filename="manifest-${item.public_ref}.json"`)
      .send(canonicalJson(item.capture_manifest));
  })
);

/**
 * The Section 63 certificate (F11), auto-filled from the record. Refuses with a
 * list of what is missing rather than printing a blank that looks filled.
 * A TEMPLATE to be verified with a legal practitioner; the PDF says so.
 */
router.post(
  "/:id/certificate",
  requireRole("police", "forensic_lab", "prosecutor", "judge", "court_admin"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      custodianName: safeText(160).optional().nullable(),
      custodianDesignation: safeText(160).optional().nullable(),
      deviceDescription: safeText(1000).optional().nullable(),
      productionMethod: safeText(2000).optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);
    const result = await renderCertificate(item.id, req.user!, req.body);
    await recordAction(req, {
      action: "evidence.certificate",
      subject: item.id,
      caseId: item.case_id,
      detail: { pdfSha256: result.pdfSha, templateVersion: result.templateVersion },
    });
    res
      .status(200)
      .setHeader("content-type", "application/pdf")
      .setHeader("content-disposition", `inline; filename="section63-${item.public_ref}.pdf"`)
      .setHeader("x-nyaysetu-sha256", result.pdfSha)
      .send(result.pdf);
  })
);

/** Every verification attempt on an item, pass or fail. */
router.get(
  "/:id/integrity-checks",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = await loadEvidence(req.params.id);
    await assertCaseAccess(req, item.case_id);

    const { db, unwrapList } = await import("../lib/supabase");
    const checks = unwrapList(
      await db
        .from("integrity_checks")
        .select("id, submitted_hash, expected_hash, matched, checked_by_role, context, tx_hash, created_at")
        .eq("evidence_id", req.params.id)
        .order("created_at", { ascending: false })
        .limit(100)
    );
    res.json({ checks });
  })
);

export default router;
