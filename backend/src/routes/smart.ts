import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/error";
import { validate, uuid } from "../middleware/validate";
import { requireAuth, requireRole } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { recordAction } from "../services/audit";
import { readMedia } from "../services/smart/media.service";
import { listStationAlerts, updateStationAlert } from "../services/smart/stationAlerts.service";
import { vehicleStats } from "../services/vehicleTrace.service";
import { thirdEyeStats } from "../services/thirdEye.service";
import { capabilities } from "../config/env";

/**
 * What Vehicle Trace and Third Eye share: inter-station alerts, the encrypted
 * photographs, and the analytics overview.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole("police", "court_admin"));

router.get(
  "/alerts",
  validate(z.object({ status: z.enum(["unread", "read", "actioned"]).optional() }), "query"),
  asyncRoute(async (req, res) => {
    res.json({ alerts: await listStationAlerts(req.user!, req.query.status as string | undefined) });
  })
);

router.patch(
  "/alerts/:id",
  requireRole("police"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ status: z.enum(["read", "actioned"]) })),
  asyncRoute(async (req, res) => {
    res.json({ alert: await updateStationAlert(req.user!, req.params.id, req.body.status) });
  })
);

/** One photograph, decrypted and re-hashed. Never cached: it is investigative material. */
router.get(
  "/media/:id",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const { row, bytes } = await readMedia(req.params.id);
    await recordAction(req, { action: "smart.media_view", subject: row.id, detail: { module: row.module, subject: row.subject_id } });
    res
      .status(200)
      .setHeader("content-type", row.mime_type)
      .setHeader("cache-control", "private, no-store")
      .setHeader("x-nyaysetu-sha256", row.sha256)
      .send(bytes);
  })
);

router.get(
  "/overview",
  asyncRoute(async (_req, res) => {
    const [vehicles, thirdEye] = await Promise.all([vehicleStats(), thirdEyeStats()]);
    res.json({ vehicles, thirdEye, capabilities: { serverAnpr: capabilities.serverAnpr, faceRecognition: false } });
  })
);

export default router;
