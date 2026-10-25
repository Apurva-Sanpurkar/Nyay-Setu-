import { Router } from "express";
import { z } from "zod";
import { db, unwrapMaybe } from "../lib/supabase";
import { notFound } from "../lib/errors";
import { asyncRoute } from "../middleware/error";
import { validate, hash32, safeText, uuid } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { fileReport, intakesFor, labQueue, recordIntake, recordWorkingCopy, setIntakeStatus, workingCopiesFor } from "../services/lab.service";

/** The forensic laboratory (2.0 · F14). */
const router = Router();
router.use(requireAuth);

async function caseOf(evidenceId: string): Promise<string> {
  const row = unwrapMaybe(await db.from("evidence_items").select("case_id").eq("id", evidenceId).maybeSingle()) as { case_id: string } | null;
  if (!row) throw notFound("Evidence item");
  return row.case_id;
}

router.get(
  "/queue",
  requireRole("forensic_lab", "prosecutor", "judge", "court_admin"),
  asyncRoute(async (req, res) => {
    res.json(await labQueue(req.user!));
  })
);

router.post(
  "/evidence/:id/intake",
  requireRole("forensic_lab"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      sealIntact: z.boolean(),
      sealNotes: safeText(1000).optional().nullable(),
      packagingEvidenceIds: z.array(uuid).max(10).optional(),
      conditionNotes: safeText(2000).optional().nullable(),
      recheckSha256: hash32,
    })
  ),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, await caseOf(req.params.id), "write");
    res.status(201).json(await recordIntake(req, req.user!, req.params.id, req.body));
  })
);

router.get(
  "/evidence/:id",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, await caseOf(req.params.id));
    const [intakes, workingCopies] = await Promise.all([intakesFor(req.params.id), workingCopiesFor(req.params.id)]);
    res.json({ intakes, workingCopies });
  })
);

router.patch(
  "/intakes/:id",
  requireRole("forensic_lab"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ status: z.enum(["in_analysis", "reported", "returned"]) })),
  asyncRoute(async (req, res) => {
    const intake = unwrapMaybe(await db.from("lab_intakes").select("case_id").eq("id", req.params.id).maybeSingle()) as { case_id: string } | null;
    if (!intake) throw notFound("Lab intake");
    await assertCaseAccess(req, intake.case_id, "write");
    res.json({ intake: await setIntakeStatus(req, req.user!, req.params.id, req.body.status) });
  })
);

router.post(
  "/evidence/:id/working-copies",
  requireRole("forensic_lab"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      copySha256: hash32,
      tool: safeText(120).pipe(z.string().min(2)),
      toolVersion: safeText(60).pipe(z.string().min(1)),
      method: safeText(500).pipe(z.string().min(3)),
      notes: safeText(2000).optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, await caseOf(req.params.id), "write");
    res.status(201).json(await recordWorkingCopy(req, req.user!, req.params.id, req.body));
  })
);

export const reportBody = z.object({
  conclusion: safeText(500).pipe(z.string().min(10)),
  detail: safeText(20000).optional().nullable(),
  analystName: safeText(160).optional(),
  tool: safeText(160).pipe(z.string().min(2)),
  method: safeText(1000).pipe(z.string().min(3)),
  supersedesId: uuid.optional().nullable(),
});

router.post(
  "/evidence/:id/reports",
  requireRole("forensic_lab"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(reportBody),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, await caseOf(req.params.id), "write");
    res.status(201).json(await fileReport(req, req.user!, req.params.id, { ...req.body, analystName: req.body.analystName ?? req.user!.fullName }));
  })
);

export default router;
