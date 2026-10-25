import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/error";
import { validate, safeText, uuid } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { subjectCase, decideApproval, exportBundle, holdsForCase, listApprovals, placeHold, releaseHold, requestApproval } from "../services/governance.service";

/** Governance (2.0 · F19): two-person approvals, legal holds, the court export bundle. */
const router = Router();
router.use(requireAuth);

router.get(
  "/approvals",
  requireRole("police", "forensic_lab", "prosecutor", "judge", "court_admin"),
  validate(z.object({ status: z.enum(["pending", "approved", "rejected", "executed", "cancelled"]).optional(), caseId: uuid.optional() }), "query"),
  asyncRoute(async (req, res) => {
    res.json({ approvals: await listApprovals(req.user!, req.query as any) });
  })
);

router.post(
  "/approvals",
  requireRole("police", "forensic_lab", "prosecutor", "judge", "court_admin"),
  writeLimiter,
  validate(
    z.object({
      action: z.enum(["case_close", "evidence_destroy", "custody_after_mismatch"]),
      subjectId: uuid,
      reason: safeText(2000).pipe(z.string().min(10, "Give a reason of at least 10 characters")),
      payload: z
        .object({
          method: z.enum(["returned_to_owner", "destroyed", "auctioned", "transferred", "retained_by_court"]).optional(),
          witnesses: z.array(z.object({ name: safeText(120) })).max(5).optional(),
          notes: safeText(2000).optional(),
        })
        .optional(),
    })
  ),
  asyncRoute(async (req, res) => {
    // Access is checked on the case the subject belongs to, before anything is written.
    const caseId = await subjectCase(req.body.action === "case_close" ? "case" : "evidence", req.body.subjectId);
    await assertCaseAccess(req, caseId, req.user!.role === "judge" ? "read" : "write");
    const approval = await requestApproval(req, req.user!, { ...req.body, idempotencyKey: req.get("idempotency-key") ?? null });
    res.status(201).json({ approval });
  })
);

router.post(
  "/approvals/:id/decide",
  requireRole("judge", "court_admin"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ decision: z.enum(["approve", "reject"]), reason: safeText(2000).pipe(z.string().min(5)) })),
  asyncRoute(async (req, res) => {
    res.json({ approval: await decideApproval(req, req.user!, req.params.id, req.body.decision, req.body.reason) });
  })
);

router.get(
  "/cases/:caseId/holds",
  validate(z.object({ caseId: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json({ holds: await holdsForCase(req.params.caseId) });
  })
);

router.post(
  "/holds",
  requireRole("judge", "prosecutor", "court_admin"),
  writeLimiter,
  validate(z.object({ subjectType: z.enum(["case", "evidence"]), subjectId: uuid, caseId: uuid, reason: safeText(2000).pipe(z.string().min(10)) })),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.body.caseId);
    res.status(201).json({ hold: await placeHold(req, req.user!, req.body) });
  })
);

router.post(
  "/holds/:id/release",
  requireRole("judge", "court_admin"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(z.object({ reason: safeText(2000).pipe(z.string().min(10)) })),
  asyncRoute(async (req, res) => {
    res.json({ hold: await releaseHold(req, req.user!, req.params.id, req.body.reason) });
  })
);

/** The court export bundle, built with the requester's own role. */
router.get(
  "/export",
  requireRole("police", "forensic_lab", "prosecutor", "judge", "defence_lawyer", "court_admin"),
  writeLimiter,
  validate(z.object({ caseId: uuid, evidenceId: uuid.optional() }), "query"),
  asyncRoute(async (req, res) => {
    const { caseId, evidenceId } = req.query as { caseId: string; evidenceId?: string };
    await assertCaseAccess(req, caseId);
    const bundle = await exportBundle(req, req.user!, { caseId, evidenceId: evidenceId ?? null });
    res
      .status(200)
      .setHeader("content-type", "application/zip")
      .setHeader("content-disposition", `attachment; filename="${bundle.fileName}"`)
      .setHeader("x-nyaysetu-sha256", bundle.digest)
      .send(bundle.zip);
  })
);

export default router;
