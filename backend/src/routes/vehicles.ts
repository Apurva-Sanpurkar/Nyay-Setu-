import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { env, capabilities } from "../config/env";
import { AppError, badRequest } from "../lib/errors";
import { asyncRoute } from "../middleware/error";
import { validate, safeText, uuid, latitude, longitude } from "../middleware/validate";
import { requireAuth, requireRole } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { recordAction } from "../services/audit";
import { normalisePlate, plateShape } from "../lib/similarity";
import { storeMedia } from "../services/smart/media.service";
import {
  REPORT_TYPES,
  VEHICLE_STATUSES,
  VEHICLE_TYPES,
  addObservation,
  changeStatus,
  createReport,
  decideMatch,
  getReport,
  listMatches,
  listReports,
  plateCheck,
  rematch,
  vehicleStats,
} from "../services/vehicleTrace.service";
import { db, unwrapMaybe } from "../lib/supabase";

/**
 * Vehicle Trace: lost, stolen, found and abandoned vehicles across stations.
 * Police read and write; the registry reads, for oversight.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole("police", "court_admin"));

// Photographs stay in memory until they are encrypted; the app compresses them
// to well under Vercel's 4.5 MB request limit before sending.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4_400_000, files: 1 } });

const optionalText = (max: number) => safeText(max).optional().nullable().transform((v) => (v ? v : null));

router.get(
  "/",
  validate(
    z.object({
      station: safeText(120).optional(),
      status: z.enum(VEHICLE_STATUSES).optional(),
      type: z.enum(REPORT_TYPES).optional(),
      q: safeText(60).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      scope: z.enum(["mine", "all"]).optional(),
    }),
    "query"
  ),
  asyncRoute(async (req, res) => {
    res.json({ reports: await listReports(req.user!, req.query as any) });
  })
);

router.post(
  "/",
  requireRole("police"),
  writeLimiter,
  validate(
    z
      .object({
        reportType: z.enum(REPORT_TYPES),
        registration: optionalText(20),
        registrationSource: z.enum(["manual", "anpr", "anpr_corrected", "none"]).optional(),
        vehicleType: z.enum(VEHICLE_TYPES),
        make: optionalText(60),
        model: optionalText(60),
        colour: optionalText(40),
        chassisLast5: z.string().trim().regex(/^[A-Za-z0-9]{3,6}$/, "3 to 6 letters or digits").optional().nullable(),
        conditionNotes: optionalText(2000),
        complaintRef: optionalText(80),
        caseId: uuid.optional().nullable(),
        incidentAt: z.string().datetime({ offset: true }).optional().nullable(),
        latitude: latitude.optional().nullable(),
        longitude: longitude.optional().nullable(),
        locationAccuracyM: z.coerce.number().min(0).max(100_000).optional().nullable(),
        locationSource: z.enum(["gps", "manual", "none"]).optional(),
        locationText: optionalText(300),
        ownerContact: optionalText(200),
        confirmNotDuplicate: z.boolean().optional(),
      })
      .refine((v) => !["missing", "stolen"].includes(v.reportType) || Boolean(v.registration || v.chassisLast5), {
        message: "A missing or stolen vehicle needs its registration number or the end of its chassis number.",
        path: ["registration"],
      })
  ),
  asyncRoute(async (req, res) => {
    res.status(201).json(await createReport(req, req.user!, req.body));
  })
);

router.get("/stats", asyncRoute(async (_req, res) => res.json(await vehicleStats())));

router.get(
  "/matches",
  validate(z.object({ status: z.enum(["pending", "verified", "rejected"]).optional() }), "query"),
  asyncRoute(async (req, res) => {
    res.json({ matches: await listMatches(req.user!, req.query.status as string | undefined) });
  })
);

router.post(
  "/matches/:id/decision",
  requireRole("police"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      decision: z.enum(["verified", "rejected"]),
      note: safeText(1000).pipe(z.string().min(10, "explain the decision in at least 10 characters")),
    })
  ),
  asyncRoute(async (req, res) => {
    res.json({ match: await decideMatch(req, req.user!, req.params.id, req.body.decision, req.body.note) });
  })
);

router.get(
  "/plate-check",
  validate(z.object({ registration: safeText(20).pipe(z.string().min(4)) }), "query"),
  asyncRoute(async (req, res) => {
    const result = await plateCheck(String(req.query.registration));
    await recordAction(req, { action: "vehicle.plate_check", detail: { hits: result.hits.length } });
    res.json(result);
  })
);

/**
 * Server-side number plate recognition, when a provider is configured. Without
 * one this answers 501 and the app reads the plate on the device instead. Either
 * way the officer confirms or corrects the number before anything is matched.
 */
router.post(
  "/anpr",
  requireRole("police"),
  writeLimiter,
  upload.single("image"),
  asyncRoute(async (req, res) => {
    if (!capabilities.serverAnpr) {
      throw new AppError(501, "ANPR_ON_DEVICE", "Server-side plate recognition is not configured; the app reads the plate on this device.");
    }
    if (!req.file) throw badRequest("Attach the number plate photograph as `image`.");
    const form = new FormData();
    form.append("upload", new Blob([new Uint8Array(req.file.buffer)]), "plate.jpg");
    form.append("regions", "in");
    const response = await fetch(env.PLATE_RECOGNIZER_URL, { method: "POST", headers: { Authorization: `Token ${env.PLATE_RECOGNIZER_TOKEN}` }, body: form });
    if (!response.ok) throw new AppError(502, "ANPR_FAILED", `The plate recognition service answered ${response.status}.`);
    const body = (await response.json()) as { results?: { plate: string; score: number; candidates?: { plate: string; score: number }[] }[] };
    const candidates = (body.results ?? [])
      .flatMap((r) => [{ plate: r.plate, score: r.score }, ...(r.candidates ?? [])])
      .map((c) => ({ plate: normalisePlate(c.plate), score: Math.round(c.score * 1000) / 1000 }))
      .filter((c): c is { plate: string; score: number } => Boolean(c.plate));
    const unique = [...new Map(candidates.map((c) => [c.plate, c])).values()].slice(0, 5);
    await recordAction(req, { action: "vehicle.anpr", detail: { provider: "platerecognizer", candidates: unique.length } });
    res.json({ provider: "server", candidates: unique.map((c) => ({ ...c, shape: plateShape(c.plate) })) });
  })
);

router.get(
  "/:id",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const result = await getReport(req.user!, req.params.id);
    await recordAction(req, { action: "vehicle.view", subject: req.params.id });
    res.json(result);
  })
);

router.post(
  "/:id/observations",
  requireRole("police"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ note: safeText(2000).pipe(z.string().min(3)) })),
  asyncRoute(async (req, res) => {
    res.status(201).json({ event: await addObservation(req, req.user!, req.params.id, req.body.note) });
  })
);

router.post(
  "/:id/status",
  requireRole("police"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ status: z.enum(VEHICLE_STATUSES), note: optionalText(1000) })),
  asyncRoute(async (req, res) => {
    res.json({ report: await changeStatus(req, req.user!, req.params.id, req.body.status, req.body.note) });
  })
);

router.post(
  "/:id/rematch",
  requireRole("police"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    res.json(await rematch(req, req.user!, req.params.id));
  })
);

router.post(
  "/:id/media",
  requireRole("police"),
  writeLimiter,
  upload.single("file"),
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ kind: z.enum(["vehicle_photo", "plate_photo"]), sourceNote: optionalText(300) })),
  asyncRoute(async (req, res) => {
    const report = unwrapMaybe(await db.from("vehicle_reports").select("id").eq("id", req.params.id).maybeSingle());
    if (!report) throw badRequest("No such vehicle report.");
    if (!req.file) throw badRequest("Attach the photograph as `file`.");
    const media = await storeMedia({ module: "vehicle_trace", subjectId: req.params.id, kind: req.body.kind, file: req.file.buffer, sourceNote: req.body.sourceNote, user: req.user! });
    await recordAction(req, { action: "vehicle.media", subject: req.params.id, detail: { mediaId: media.id, kind: media.kind } });
    res.status(201).json({ media });
  })
);

export default router;
