import { Router } from "express";
import { z } from "zod";
import { db, unwrapMaybe } from "../lib/supabase";
import { notFound } from "../lib/errors";
import { asyncRoute } from "../middleware/error";
import { validate, safeText, uuid } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import {
  addCourtEvent,
  addSummonsAttempt,
  bailCompliance,
  courtEventsFor,
  decideAccess,
  explainMissedCheckIn,
  fileObjection,
  listAccessRequests,
  myObligations,
  objectionsFor,
  prosecutionOverview,
  recordFinding,
  requestAccess,
  ruleOnObjection,
  summonsService,
  upcomingHearings,
  withdrawAccess,
} from "../services/court.service";
import { notificationsFor } from "../services/notify.service";

/** Court-facing workflows (2.0 · F15–F18). */
const router = Router();
router.use(requireAuth);

const id = z.object({ id: uuid });
const caseParam = z.object({ caseId: uuid });

/* ------------------------------------------------------------- F15 */
router.get(
  "/prosecution",
  requireRole("prosecutor", "judge", "court_admin"),
  asyncRoute(async (req, res) => {
    res.json(await prosecutionOverview(req.user!));
  })
);

/* ------------------------------------------------------------- F16 */
router.post(
  "/access-requests",
  requireRole("defence_lawyer"),
  writeLimiter,
  validate(z.object({ caseReference: z.string().trim().min(5).max(100), reason: safeText(2000).pipe(z.string().min(10)) })),
  asyncRoute(async (req, res) => {
    res.status(201).json({ request: await requestAccess(req, req.user!, req.body) });
  })
);

router.get(
  "/access-requests",
  requireRole("defence_lawyer", "judge", "court_admin"),
  validate(z.object({ status: z.enum(["pending", "granted", "refused", "withdrawn"]).optional() }), "query"),
  asyncRoute(async (req, res) => {
    res.json({ requests: await listAccessRequests(req.user!, (req.query as any).status) });
  })
);

router.post(
  "/access-requests/:id/decide",
  requireRole("judge", "court_admin"),
  writeLimiter,
  validate(id, "params"),
  validate(z.object({ grant: z.boolean(), reason: safeText(2000).pipe(z.string().min(5)) })),
  asyncRoute(async (req, res) => {
    res.json({ request: await decideAccess(req, req.user!, req.params.id, req.body) });
  })
);

router.post(
  "/access-requests/:id/withdraw",
  requireRole("defence_lawyer"),
  validate(id, "params"),
  asyncRoute(async (req, res) => {
    await withdrawAccess(req, req.user!, req.params.id);
    res.json({ ok: true });
  })
);

router.post(
  "/objections",
  requireRole("defence_lawyer", "prosecutor"),
  writeLimiter,
  validate(z.object({ caseId: uuid, evidenceId: uuid.optional().nullable(), grounds: safeText(4000).pipe(z.string().min(10)) })),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.body.caseId);
    res.status(201).json({ objection: await fileObjection(req, req.user!, req.body) });
  })
);

router.get(
  "/cases/:caseId/objections",
  requireRole("police", "forensic_lab", "prosecutor", "judge", "defence_lawyer", "court_admin"),
  validate(caseParam, "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json({ objections: await objectionsFor(req.params.caseId) });
  })
);

router.post(
  "/objections/:id/rule",
  requireRole("judge", "court_admin"),
  writeLimiter,
  validate(id, "params"),
  validate(z.object({ outcome: z.enum(["upheld", "dismissed"]), ruling: safeText(4000).pipe(z.string().min(10)) })),
  asyncRoute(async (req, res) => {
    res.json({ objection: await ruleOnObjection(req, req.user!, req.params.id, req.body) });
  })
);

/* ------------------------------------------------------------- F17 */
router.post(
  "/cases/:caseId/events",
  requireRole("judge", "court_admin"),
  writeLimiter,
  validate(caseParam, "params"),
  validate(
    z.object({
      kind: z.enum(["hearing", "order", "adjournment", "direction", "judgment"]),
      title: safeText(300).pipe(z.string().min(3)),
      body: safeText(20000).optional().nullable(),
      scheduledFor: z.string().datetime({ offset: true }).optional().nullable(),
      linkedType: z.enum(["evidence", "summons", "bail", "objection", "access_request"]).optional().nullable(),
      linkedId: uuid.optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.status(201).json({ event: await addCourtEvent(req, req.user!, { ...req.body, caseId: req.params.caseId }) });
  })
);

router.get(
  "/cases/:caseId/events",
  validate(caseParam, "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json({ events: await courtEventsFor(req.params.caseId, req.user!.role) });
  })
);

router.get(
  "/hearings",
  asyncRoute(async (req, res) => {
    res.json({ hearings: await upcomingHearings(req.user!) });
  })
);

router.post(
  "/summons/:id/attempts",
  requireRole("judge", "court_admin", "police"),
  writeLimiter,
  validate(id, "params"),
  validate(
    z.object({
      method: z.enum(["in_person", "registered_post", "email", "sms", "affixture", "electronic"]),
      outcome: z.enum(["served", "refused", "not_found", "address_wrong", "deferred"]),
      notes: safeText(2000).optional().nullable(),
      attemptedAt: z.string().datetime({ offset: true }).optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    const summons = unwrapMaybe(await db.from("summons").select("case_id").eq("id", req.params.id).maybeSingle()) as { case_id: string } | null;
    if (!summons) throw notFound("Summons");
    await assertCaseAccess(req, summons.case_id);
    res.status(201).json({ attempt: await addSummonsAttempt(req, req.user!, req.params.id, req.body) });
  })
);

router.get(
  "/cases/:caseId/summons",
  requireRole("police", "prosecutor", "judge", "court_admin"),
  validate(caseParam, "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json({ summons: await summonsService(req.params.caseId) });
  })
);

router.get(
  "/bail/compliance",
  requireRole("judge", "prosecutor", "court_admin"),
  asyncRoute(async (req, res) => {
    res.json(await bailCompliance(req.user!));
  })
);

router.post(
  "/violations/:id/finding",
  requireRole("judge", "court_admin"),
  writeLimiter,
  validate(id, "params"),
  validate(z.object({ finding: z.enum(["no_violation", "gps_drift", "technical", "violation", "absconding"]) })),
  asyncRoute(async (req, res) => {
    res.json({ violation: await recordFinding(req, req.user!, req.params.id, req.body.finding) });
  })
);

/* ------------------------------------------------------------- F18 */
router.post(
  "/bail/:id/explanations",
  requireRole("accused"),
  writeLimiter,
  validate(id, "params"),
  validate(
    z.object({
      violationId: uuid.optional().nullable(),
      category: z.enum(["medical", "network", "device", "travel_permitted", "other"]),
      reason: safeText(2000).pipe(z.string().min(5)),
    })
  ),
  asyncRoute(async (req, res) => {
    res.status(201).json({ explanation: await explainMissedCheckIn(req, req.user!, { ...req.body, bailId: req.params.id }) });
  })
);

router.get(
  "/me/obligations",
  requireRole("accused"),
  asyncRoute(async (req, res) => {
    res.json(await myObligations(req.user!));
  })
);

router.get(
  "/me/notifications",
  asyncRoute(async (req, res) => {
    res.json({ notifications: await notificationsFor(req.user!.id) });
  })
);

export default router;
