import { Router } from "express";
import { z } from "zod";
import { db, unwrapMaybe } from "../lib/supabase";
import { badRequest } from "../lib/errors";
import { asyncRoute } from "../middleware/error";
import { validate, uuid, otpCode, latitude, longitude, safeText } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { otpLimiter } from "../middleware/rateLimit";
import { predictBailRisk } from "../lib/ai";
import {
  CONDITION_CATALOGUE,
  grantBail,
  requestCheckInOtp,
  checkIn,
  complianceFor,
  complianceDashboard,
  sweepMissedCheckIns,
  reportViolation,
  acknowledgeViolation,
  closeBail,
  suretyView,
  bailForAccused,
  loadBailByCase,
} from "../services/bail.service";

const router = Router();
router.use(requireAuth);

const riskFactorsSchema = z.object({
  offenceType: safeText(120),
  priorConvictions: z.coerce.number().int().min(0).max(50),
  ageYears: z.coerce.number().int().min(14).max(110),
  previousBailViolations: z.coerce.number().int().min(0).max(50),
  checkInConsistency: z.coerce.number().min(0).max(1),
  movementRadiusKm: z.coerce.number().min(0).max(5000),
  employmentStable: z.coerce.boolean(),
});

/** The fixed condition vocabulary. Index alignment with the chain depends on it. */
router.get("/conditions", (_req, res) => {
  res.json({ conditions: CONDITION_CATALOGUE });
});

/**
 * Risk score without granting anything, so a judge can see the assessment
 * while still deciding. Predictions made here are not anchored: only the one
 * attached to an actual order is.
 */
router.post(
  "/risk-preview",
  requireRole("judge"),
  validate(riskFactorsSchema),
  asyncRoute(async (req, res) => {
    res.json({ risk: await predictBailRisk(req.body as any) });
  })
);

/** Grant bail with conditions encoded on chain. */
router.post(
  "/grant",
  requireRole("judge"),
  validate(
    z.object({
      caseId: uuid,
      accusedUserId: uuid.optional().nullable(),
      accusedName: safeText(160),
      accusedAadhaarNumber: z
        .string()
        .trim()
        .regex(/^[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}$/)
        .optional(),
      conditionTags: z
        .array(z.enum(["GEO_RESTRICTION", "PERIODIC_CHECKIN", "NO_CONTACT", "SURRENDER_PASSPORT", "NO_REOFFENCE"]))
        .min(1)
        .max(5),
      centreLat: latitude,
      centreLng: longitude,
      // 0 disables the geo-fence entirely.
      radiusMetres: z.coerce.number().int().min(0).max(500_000),
      checkinIntervalSeconds: z.coerce.number().int().min(60).max(31_536_000),
      expiryAt: z.string().datetime({ offset: true }),
      orderText: safeText(20000).optional().nullable(),
      suretyName: safeText(160).optional().nullable(),
      suretyUserId: uuid.optional().nullable(),
      riskFactors: riskFactorsSchema.optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    const body = req.body as any;
    await assertCaseAccess(req, body.caseId);

    let accusedAadhaarToken: string | null = null;
    if (body.accusedUserId) {
      const { getAadhaarToken } = await import("../lib/pii");
      accusedAadhaarToken = await getAadhaarToken(body.accusedUserId);
      if (!accusedAadhaarToken) {
        throw badRequest("That accused has no Aadhaar token on file.");
      }
    } else if (body.accusedAadhaarNumber) {
      const { aadhaarToken } = await import("../lib/crypto");
      accusedAadhaarToken = aadhaarToken(body.accusedAadhaarNumber);
    } else {
      throw badRequest("Provide either accusedUserId or accusedAadhaarNumber.");
    }

    // A geo-restriction condition with no radius would be unenforceable.
    if (body.conditionTags.includes("GEO_RESTRICTION") && body.radiusMetres === 0) {
      throw badRequest(
        "GEO_RESTRICTION was selected but radiusMetres is 0. Set a radius, or drop the condition."
      );
    }

    const result = await grantBail(req, req.user!, {
      caseId: body.caseId,
      accusedUserId: body.accusedUserId ?? null,
      accusedName: body.accusedName,
      accusedAadhaarToken,
      conditionTags: body.conditionTags,
      centreLat: body.centreLat,
      centreLng: body.centreLng,
      radiusMetres: body.radiusMetres,
      checkinIntervalSeconds: body.checkinIntervalSeconds,
      expiryAt: body.expiryAt,
      orderText: body.orderText ?? null,
      suretyName: body.suretyName ?? null,
      suretyUserId: body.suretyUserId ?? null,
      riskFactors: body.riskFactors ?? null,
    });

    res.status(201).json(result);
  })
);

/** The live compliance board: green or red per accused. */
router.get(
  "/dashboard",
  requireRole("judge", "court_admin", "prosecutor"),
  asyncRoute(async (_req, res) => {
    const rows = await complianceDashboard();
    res.json({
      orders: rows,
      counts: {
        total: rows.length,
        compliant: rows.filter((r) => r.state === "compliant").length,
        breach: rows.filter((r) => r.state === "breach").length,
        overdue: rows.filter((r) => r.live?.overdue).length,
      },
    });
  })
);

/** What the accused sees: their own orders and when the next check-in is due. */
router.get(
  "/mine",
  asyncRoute(async (req, res) => {
    const orders = await bailForAccused(req.user!);
    const { refreshCompliance } = await import("../services/bail.service");

    const enriched = [];
    for (const order of orders) {
      const live = order.cases?.case_id_hash
        ? await refreshCompliance(order.id, order.cases.case_id_hash)
        : null;
      enriched.push({ ...order, live });
    }
    res.json({ orders: enriched });
  })
);

/** Read-only compliance view for a guarantor. No case material. */
router.get(
  "/surety",
  asyncRoute(async (req, res) => {
    res.json({ orders: await suretyView(req.user!) });
  })
);

router.get(
  "/case/:caseId",
  validate(z.object({ caseId: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const bail = await loadBailByCase(req.params.caseId);
    const isParty =
      bail.accused_aadhaar_token === req.user!.aadhaarToken ||
      bail.surety_user_id === req.user!.id;
    if (!isParty) await assertCaseAccess(req, req.params.caseId);

    const result = await complianceFor(req.params.caseId);

    // The surety sees compliance, not the order text or the GPS trail.
    if (bail.surety_user_id === req.user!.id && bail.accused_user_id !== req.user!.id) {
      return res.json({
        ...result,
        bail: { ...result.bail, order_text: null, centre_lat: null, centre_lng: null },
        checkins: result.checkins.map((c: any) => ({
          id: c.id,
          occurred_at: c.occurred_at,
          within_fence: c.within_fence,
        })),
      });
    }

    res.json(result);
  })
);

/** Step one of a check-in. */
router.post(
  "/case/:caseId/otp",
  otpLimiter,
  validate(z.object({ caseId: uuid }), "params"),
  asyncRoute(async (req, res) => {
    if (!req.user!.aadhaarToken) throw badRequest("Your account has no Aadhaar token on file.");
    res.json(await requestCheckInOtp(req, req.user!, req.params.caseId));
  })
);

/**
 * Step two: the check-in itself. The contract decides whether this is compliant
 * or a breach, so the verdict is reproducible by anyone reading the chain.
 */
router.post(
  "/case/:caseId/checkin",
  otpLimiter,
  validate(z.object({ caseId: uuid }), "params"),
  validate(
    z.object({
      challengeId: uuid,
      otp: otpCode,
      gpsLat: latitude,
      gpsLng: longitude,
      deviceId: safeText(200).optional().nullable(),
      platform: safeText(80).optional().nullable(),
      // The fix's accuracy radius, so the court can tell GPS drift from a breach (F17).
      accuracyMetres: z.coerce.number().min(0).max(100_000).optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    if (!req.user!.aadhaarToken) throw badRequest("Your account has no Aadhaar token on file.");

    const result = await checkIn(req, req.user!, {
      caseId: req.params.caseId,
      challengeId: req.body.challengeId,
      otp: req.body.otp,
      gpsLat: req.body.gpsLat,
      gpsLng: req.body.gpsLng,
      deviceId: req.body.deviceId ?? null,
      platform: req.body.platform ?? null,
      accuracyMetres: req.body.accuracyMetres ?? null,
    });

    res.json(result);
  })
);

/** Breaches only a human can observe, such as contacting a witness. */
router.post(
  "/case/:caseId/violation",
  requireRole("judge", "court_admin"),
  validate(z.object({ caseId: uuid }), "params"),
  validate(z.object({ reason: safeText(120) })),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json(await reportViolation(req, req.user!, req.params.caseId, req.body.reason));
  })
);

router.post(
  "/violations/:id/acknowledge",
  requireRole("judge", "court_admin"),
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    res.json(await acknowledgeViolation(req, req.user!, req.params.id));
  })
);

router.post(
  "/case/:caseId/close",
  requireRole("judge"),
  validate(z.object({ caseId: uuid }), "params"),
  validate(z.object({ reason: safeText(120) })),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json(await closeBail(req, req.user!, req.params.caseId, req.body.reason));
  })
);

/** Manual trigger for the missed-check-in sweep. The scheduler runs it too. */
router.post(
  "/sweep",
  requireRole("court_admin"),
  asyncRoute(async (_req, res) => {
    res.json(await sweepMissedCheckIns());
  })
);

export default router;
