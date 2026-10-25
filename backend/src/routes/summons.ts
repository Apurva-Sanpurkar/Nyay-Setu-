import { Router } from "express";
import { z } from "zod";
import { db, unwrapMaybe } from "../lib/supabase";
import { badRequest, notFound } from "../lib/errors";
import { asyncRoute } from "../middleware/error";
import { validate, uuid, otpCode, latitude, longitude, safeText, hash32 } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { otpLimiter } from "../middleware/rateLimit";
import {
  issueSummons,
  requestAcknowledgementOtp,
  confirmAcknowledgement,
  deliveryStatus,
  sweepNonDelivery,
  listForCase,
  listForRecipient,
  courtOverview,
  loadSummons,
} from "../services/summons.service";

const router = Router();
router.use(requireAuth);

/**
 * Issue a summons.
 *
 * The recipient is identified by Aadhaar token. The court supplies the number
 * once; it is tokenised immediately and the number is discarded, so no route in
 * this file can persist one.
 */
router.post(
  "/",
  requireRole("judge", "court_admin"),
  validate(
    z.object({
      caseId: uuid,
      recipientUserId: uuid.optional().nullable(),
      recipientName: safeText(160),
      // Either an existing account's token, or a raw number to tokenise now.
      recipientAadhaarNumber: z
        .string()
        .trim()
        .regex(/^[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}$/)
        .optional(),
      documentBody: safeText(20000),
      hearingAt: z.string().datetime({ offset: true }).optional().nullable(),
      windowHours: z.coerce.number().int().min(1).max(720).optional(),
    })
  ),
  asyncRoute(async (req, res) => {
    const body = req.body as any;
    await assertCaseAccess(req, body.caseId);

    let recipientAadhaarToken: string | null = null;

    if (body.recipientUserId) {
      const { getAadhaarToken } = await import("../lib/pii");
      recipientAadhaarToken = await getAadhaarToken(body.recipientUserId);
      if (!recipientAadhaarToken) {
        throw badRequest("That recipient has no Aadhaar token on file.");
      }
    } else if (body.recipientAadhaarNumber) {
      const { aadhaarToken } = await import("../lib/crypto");
      // Tokenised here and the number goes out of scope immediately.
      recipientAadhaarToken = aadhaarToken(body.recipientAadhaarNumber);
    } else {
      throw badRequest("Provide either recipientUserId or recipientAadhaarNumber.");
    }

    const result = await issueSummons(req, req.user!, {
      caseId: body.caseId,
      recipientUserId: body.recipientUserId ?? null,
      recipientName: body.recipientName,
      recipientAadhaarToken,
      documentBody: body.documentBody,
      hearingAt: body.hearingAt ?? null,
      windowHours: body.windowHours,
    });

    res.status(201).json(result);
  })
);

/** The court's delivery board. This is the answer to "was it served?". */
router.get(
  "/court/overview",
  requireRole("judge", "court_admin", "prosecutor"),
  asyncRoute(async (_req, res) => {
    const rows = await courtOverview();
    res.json({
      summons: rows,
      counts: {
        pending: rows.filter((r) => r.effectiveStatus === "PENDING").length,
        delivered: rows.filter((r) => r.effectiveStatus === "DELIVERED").length,
        failed: rows.filter((r) => r.effectiveStatus === "FAILED").length,
      },
    });
  })
);

/** A recipient's own inbox. */
router.get(
  "/inbox",
  asyncRoute(async (req, res) => {
    res.json({ summons: await listForRecipient(req.user!) });
  })
);

router.get(
  "/case/:caseId",
  validate(z.object({ caseId: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json({ summons: await listForCase(req.params.caseId) });
  })
);

router.get(
  "/:id/status",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const row = await loadSummons(req.params.id);
    const isRecipient = row.recipient_aadhaar_token === req.user!.aadhaarToken;
    if (!isRecipient) await assertCaseAccess(req, row.case_id);

    const status = await deliveryStatus(req.params.id);

    // A recipient sees their own summons; they do not get the case dossier.
    if (isRecipient && req.user!.role === "accused") {
      const { document_body, recipient_aadhaar_token, ...rest } = status.summons;
      return res.json({ ...status, summons: { ...rest, document_body } });
    }
    res.json(status);
  })
);

/** Step one of acknowledgement: request the OTP. */
router.post(
  "/:id/otp",
  otpLimiter,
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    if (!req.user!.aadhaarToken) {
      throw badRequest("Your account has no Aadhaar token on file, so you cannot acknowledge a summons.");
    }
    const dispatch = await requestAcknowledgementOtp(req, req.user!, req.params.id);
    res.json(dispatch);
  })
);

/**
 * Step two: verify the OTP and record the acknowledgement on chain, with time,
 * place and device. This is the transaction that defeats "I was never served".
 */
router.post(
  "/:id/acknowledge",
  otpLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      challengeId: uuid,
      otp: otpCode,
      gpsLat: latitude,
      gpsLng: longitude,
      deviceId: safeText(200).optional().nullable(),
      platform: safeText(80).optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    if (!req.user!.aadhaarToken) throw badRequest("Your account has no Aadhaar token on file.");

    const result = await confirmAcknowledgement(req, req.user!, {
      summonsId: req.params.id,
      challengeId: req.body.challengeId,
      otp: req.body.otp,
      gpsLat: req.body.gpsLat,
      gpsLng: req.body.gpsLng,
      deviceId: req.body.deviceId ?? null,
      platform: req.body.platform ?? null,
    });

    res.json(result);
  })
);

/** Anyone on the case can check a PDF they were handed against the issued hash. */
router.post(
  "/:id/verify-document",
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ documentHash: hash32 })),
  asyncRoute(async (req, res) => {
    const row = await loadSummons(req.params.id);
    const isRecipient = row.recipient_aadhaar_token === req.user!.aadhaarToken;
    if (!isRecipient) await assertCaseAccess(req, row.case_id);

    let onChainMatches: boolean | null = null;
    if (row.chain_summons_id !== null) {
      const { read, chain } = await import("../lib/chain");
      if (chain.isReady) {
        onChainMatches = await read<boolean>("SummonsChain", "verifyDocument", [
          row.chain_summons_id,
          req.body.documentHash,
        ]);
      }
    }

    res.json({
      matchesDatabase: row.document_hash === req.body.documentHash,
      matchesChain: onChainMatches,
      expectedHash: row.document_hash,
    });
  })
);

/** Manual trigger for the 72 hour sweep. The scheduler runs it automatically. */
router.post(
  "/sweep",
  requireRole("court_admin"),
  asyncRoute(async (_req, res) => {
    res.json(await sweepNonDelivery());
  })
);

export default router;
