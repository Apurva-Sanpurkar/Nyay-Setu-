import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/error";
import { validate, safeText, uuid } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import {
  ALERT_HANDLERS,
  ALERT_READERS,
  acknowledgeAlert,
  alertDetail,
  auditTimeline,
  commentOnAlert,
  listAlerts,
  resolveAlert,
} from "../services/alerts.service";

/** Discrepancy alerts and the Justice Audit Trail (2.0 · F4). */
const router = Router();
router.use(requireAuth);

router.get(
  "/",
  requireRole(...ALERT_READERS),
  validate(
    z.object({
      caseId: uuid.optional(),
      status: z.enum(["open", "acknowledged", "resolved"]).optional(),
      kind: z.string().regex(/^[A-Z_]{3,40}$/).optional(),
    }),
    "query"
  ),
  asyncRoute(async (req, res) => {
    res.json({ alerts: await listAlerts(req.user!, req.query as any) });
  })
);

router.get(
  "/cases/:caseId/timeline",
  validate(z.object({ caseId: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json(await auditTimeline(req.params.caseId, req.user!.role));
  })
);

router.get(
  "/:id",
  requireRole(...ALERT_READERS),
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    res.json(await alertDetail(req.user!, req.params.id));
  })
);

router.post(
  "/:id/acknowledge",
  requireRole(...ALERT_HANDLERS),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    res.json({ alert: await acknowledgeAlert(req, req.user!, req.params.id) });
  })
);

router.post(
  "/:id/comments",
  requireRole(...ALERT_READERS),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ body: safeText(4000).pipe(z.string().min(1)) })),
  asyncRoute(async (req, res) => {
    res.status(201).json({ comment: await commentOnAlert(req, req.user!, req.params.id, req.body.body) });
  })
);

router.post(
  "/:id/resolve",
  requireRole(...ALERT_HANDLERS),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ resolution: safeText(4000).pipe(z.string().min(10, "Explain the resolution in at least 10 characters")) })),
  asyncRoute(async (req, res) => {
    res.json({ alert: await resolveAlert(req, req.user!, req.params.id, req.body.resolution) });
  })
);

export default router;
