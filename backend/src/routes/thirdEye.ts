import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { badRequest, notFound } from "../lib/errors";
import { db, unwrapMaybe } from "../lib/supabase";
import { asyncRoute } from "../middleware/error";
import { validate, safeText, uuid } from "../middleware/validate";
import { requireAuth, requireRole } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { storeMedia } from "../services/smart/media.service";
import {
  ARREST_STATUSES,
  CLASSIFICATIONS,
  DISCLAIMER,
  INVESTIGATION_STATUSES,
  INVOLVEMENTS,
  OFFENCE_CATEGORIES,
  activityLog,
  addCaseLink,
  createPerson,
  crossCaseLinks,
  getPerson,
  imageLeadsFor,
  listLeads,
  repeatOffenders,
  reviewLead,
  search,
  searchByImage,
  thirdEyeStats,
  updateCaseLink,
  updatePerson,
} from "../services/thirdEye.service";

/**
 * Third Eye: criminal intelligence records, case linking and investigative
 * leads. Police only for anything that touches a person's record; the registry
 * may read the activity log, which is what oversight needs.
 */
const router = Router();
router.use(requireAuth);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4_400_000, files: 1 } });

const optionalText = (max: number) => safeText(max).optional().nullable().transform((v) => (v ? v : null));
const purpose = safeText(300).pipe(z.string().min(10, "state the purpose of this search in at least 10 characters (e.g. the FIR you are investigating)"));
const reason = safeText(500).pipe(z.string().min(10, "give the reason for this change in at least 10 characters"));
const perceptualHash = z.string().trim().toLowerCase().regex(/^[0-9a-f]{16}$/, "a 64-bit perceptual hash as 16 hex digits");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

/** What this module does and, as importantly, does not do. */
router.get("/meta", requireRole("police", "court_admin"), (_req, res) => {
  res.json({
    disclaimer: DISCLAIMER,
    capabilities: {
      recordMatching: true,
      imageNearDuplicate: true,
      faceRecognition: false,
      sketchToPhoto: false,
    },
    notes: [
      "Image matching finds the same picture uploaded twice (a re-used photograph or CCTV still). It does not compare faces.",
      "Facial recognition and sketch-to-photograph comparison are disabled until a validated method, legal authorisation and a human-review protocol are in place.",
    ],
    enums: { classifications: CLASSIFICATIONS, offenceCategories: OFFENCE_CATEGORIES, involvements: INVOLVEMENTS, investigationStatuses: INVESTIGATION_STATUSES, arrestStatuses: ARREST_STATUSES },
  });
});

router.get("/activity", requireRole("police", "court_admin"), asyncRoute(async (_req, res) => res.json({ activity: await activityLog() })));

// Everything below reads or writes person records: police only.
router.use(requireRole("police"));

router.post(
  "/search",
  writeLimiter,
  validate(
    z.object({
      purpose,
      name: safeText(120).optional(),
      fir: safeText(64).optional(),
      offenceCategory: z.enum(OFFENCE_CATEGORIES).optional(),
      station: safeText(120).optional(),
      modusOperandi: safeText(500).optional(),
      marks: safeText(300).optional(),
      classification: z.enum(CLASSIFICATIONS).optional(),
    })
  ),
  asyncRoute(async (req, res) => {
    const { purpose: why, ...criteria } = req.body;
    if (!Object.values(criteria).some((v) => typeof v === "string" && v.trim())) {
      throw badRequest("Give at least one search criterion.");
    }
    res.json(await search(req, req.body));
  })
);

router.post(
  "/search/image",
  writeLimiter,
  validate(z.object({ purpose, perceptualHash })),
  asyncRoute(async (req, res) => {
    res.json(await searchByImage(req, req.body.perceptualHash, req.body.purpose));
  })
);

const personFields = {
  fullName: safeText(160).pipe(z.string().min(2)),
  aliases: z.array(safeText(160).pipe(z.string().min(2))).max(10).optional(),
  gender: z.enum(["male", "female", "transgender", "unknown"]).optional().nullable(),
  dateOfBirth: isoDate.optional().nullable(),
  ageEstimate: z.coerce.number().int().min(5).max(120).optional().nullable(),
  heightCm: z.coerce.number().int().min(50).max(250).optional().nullable(),
  build: optionalText(60),
  complexion: optionalText(60),
  identifyingMarks: optionalText(1000),
  physicalDescription: optionalText(2000),
  classification: z.enum(CLASSIFICATIONS),
};

router.post(
  "/persons",
  writeLimiter,
  validate(z.object(personFields)),
  asyncRoute(async (req, res) => {
    res.status(201).json(await createPerson(req, req.user!, req.body));
  })
);

router.get(
  "/persons/:id",
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ purpose: safeText(300).optional() }), "query"),
  asyncRoute(async (req, res) => {
    res.json(await getPerson(req, req.params.id, (req.query.purpose as string | undefined) ?? null));
  })
);

router.patch(
  "/persons/:id",
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z
      .object({ ...personFields, recordStatus: z.enum(["active", "archived"]) })
      .partial()
      .extend({ reason })
  ),
  asyncRoute(async (req, res) => {
    const { reason: why, ...patch } = req.body;
    res.json(await updatePerson(req, req.user!, req.params.id, patch, why));
  })
);

router.post(
  "/persons/:id/cases",
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      firNumber: z.string().trim().min(3).max(64).regex(/^[A-Za-z0-9/_ .-]+$/, "letters, digits, slash, dash, dot and underscore only"),
      caseId: uuid.optional().nullable(),
      policeStation: safeText(120).pipe(z.string().min(2)),
      offence: safeText(300).pipe(z.string().min(2)),
      offenceCategory: z.enum(OFFENCE_CATEGORIES),
      modusOperandi: optionalText(2000),
      crimeDate: isoDate.optional().nullable(),
      crimeLocation: optionalText(300),
      involvement: z.enum(INVOLVEMENTS),
      investigationStatus: z.enum(INVESTIGATION_STATUSES),
      arrestStatus: z.enum(ARREST_STATUSES).optional().nullable(),
      courtStatus: optionalText(200),
      investigatingOfficer: optionalText(160),
    })
  ),
  asyncRoute(async (req, res) => {
    res.status(201).json(await addCaseLink(req, req.user!, req.params.id, req.body));
  })
);

router.patch(
  "/cases/:id",
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      investigationStatus: z.enum(INVESTIGATION_STATUSES).optional(),
      arrestStatus: z.enum(ARREST_STATUSES).optional().nullable(),
      courtStatus: optionalText(200),
      involvement: z.enum(INVOLVEMENTS).optional(),
      investigatingOfficer: optionalText(160),
      reason,
    })
  ),
  asyncRoute(async (req, res) => {
    const { reason: why, ...patch } = req.body;
    res.json(await updateCaseLink(req, req.user!, req.params.id, patch, why));
  })
);

router.post(
  "/persons/:id/media",
  writeLimiter,
  upload.single("file"),
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      kind: z.enum(["suspect_photo", "sketch", "cctv_still", "other"]),
      perceptualHash: perceptualHash.optional(),
      sourceNote: optionalText(300),
    })
  ),
  asyncRoute(async (req, res) => {
    const person = unwrapMaybe(await db.from("ti_persons").select("id").eq("id", req.params.id).maybeSingle());
    if (!person) throw notFound("Person record");
    if (!req.file) throw badRequest("Attach the image as `file`.");
    const media = await storeMedia({
      module: "third_eye",
      subjectId: req.params.id,
      kind: req.body.kind,
      file: req.file.buffer,
      perceptualHash: req.body.perceptualHash ?? null,
      sourceNote: req.body.sourceNote,
      user: req.user!,
    });
    const leads = await imageLeadsFor(req, req.user!, req.params.id, media);
    res.status(201).json({ media, leads, disclaimer: DISCLAIMER });
  })
);

router.get(
  "/leads",
  validate(z.object({ status: z.enum(["pending", "confirmed", "rejected"]).optional() }), "query"),
  asyncRoute(async (req, res) => {
    res.json({ leads: await listLeads(req.query.status as string | undefined), disclaimer: DISCLAIMER });
  })
);

router.post(
  "/leads/:id/review",
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      decision: z.enum(["confirmed", "rejected"]),
      note: safeText(1000).pipe(z.string().min(15, "record what you checked, in at least 15 characters")),
    })
  ),
  asyncRoute(async (req, res) => {
    res.json({ lead: await reviewLead(req, req.user!, req.params.id, req.body.decision, req.body.note) });
  })
);

router.get("/repeat-offenders", asyncRoute(async (_req, res) => res.json({ people: await repeatOffenders() })));
router.get("/cross-case", asyncRoute(async (_req, res) => res.json({ leads: await crossCaseLinks() })));
router.get("/stats", asyncRoute(async (_req, res) => res.json(await thirdEyeStats())));

export default router;
