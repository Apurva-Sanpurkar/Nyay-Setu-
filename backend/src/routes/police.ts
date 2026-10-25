import { Router } from "express";
import { z } from "zod";
import { db, unwrapList, unwrapMaybe } from "../lib/supabase";
import { notFound } from "../lib/errors";
import { asyncRoute } from "../middleware/error";
import { validate, safeText, uuid } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { recordAction } from "../services/audit";
import {
  createSeizure,
  custodyFormPdf,
  listSeizures,
  malkhanaHistory,
  malkhanaRegister,
  movementVerifications,
  recordMovement,
  seizureMemoPdf,
} from "../services/police.service";

/**
 * Police workflow (2.0 · F13): seizures, the malkhana register, the forms.
 * Reading is open to every role assigned to the case (detail is trimmed by
 * role in the service); writing is police with write access.
 */
const router = Router();
router.use(requireAuth);

function pdf(res: import("express").Response, body: Buffer, name: string) {
  res.status(200).setHeader("content-type", "application/pdf").setHeader("content-disposition", `inline; filename="${name}"`).send(body);
}

router.post(
  "/seizures",
  requireRole("police"),
  writeLimiter,
  validate(
    z.object({
      caseId: uuid,
      memoNumber: safeText(60).pipe(z.string().min(1)),
      seizedAt: z.string().datetime({ offset: true }),
      place: safeText(400).pipe(z.string().min(3)),
      seizedFrom: safeText(200).optional().nullable(),
      witnesses: z.array(z.object({ name: safeText(120).pipe(z.string().min(2)), address: safeText(300).optional() })).max(10).default([]),
      notes: safeText(4000).optional().nullable(),
      items: z
        .array(z.object({ evidenceId: uuid, label: safeText(120).pipe(z.string().min(1)), description: safeText(500).optional().nullable() }))
        .min(1)
        .max(50),
    })
  ),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.body.caseId, "write");
    res.status(201).json(await createSeizure(req, req.user!, req.body));
  })
);

router.get(
  "/cases/:caseId/seizures",
  validate(z.object({ caseId: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.caseId);
    res.json({ seizures: await listSeizures(req.params.caseId, req.user!.role) });
  })
);

router.get(
  "/seizures/:id/memo.pdf",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const seizure = unwrapMaybe(await db.from("seizures").select("case_id").eq("id", req.params.id).maybeSingle()) as { case_id: string } | null;
    if (!seizure) throw notFound("Seizure");
    await assertCaseAccess(req, seizure.case_id);
    const { pdf: body, memoNumber } = await seizureMemoPdf(req.params.id, req.user!.role);
    await recordAction(req, { action: "police.seizure_memo_pdf", subject: req.params.id, caseId: seizure.case_id });
    pdf(res, body, `seizure-memo-${memoNumber.replace(/[^A-Za-z0-9]+/g, "-")}.pdf`);
  })
);

router.post(
  "/evidence/:id/malkhana",
  requireRole("police"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      movement: z.enum(["IN", "OUT", "RETURN", "TRANSFER"]),
      location: safeText(200).pipe(z.string().min(2)),
      shelf: safeText(80).optional().nullable(),
      reason: safeText(500).pipe(z.string().min(3)),
      counterparty: safeText(200).optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    const item = unwrapMaybe(await db.from("evidence_items").select("case_id").eq("id", req.params.id).maybeSingle()) as { case_id: string } | null;
    if (!item) throw notFound("Evidence item");
    await assertCaseAccess(req, item.case_id, "write");
    res.status(201).json(await recordMovement(req, req.user!, req.params.id, req.body));
  })
);

router.get(
  "/evidence/:id/malkhana",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = unwrapMaybe(await db.from("evidence_items").select("case_id").eq("id", req.params.id).maybeSingle()) as { case_id: string } | null;
    if (!item) throw notFound("Evidence item");
    await assertCaseAccess(req, item.case_id);
    const history = await malkhanaHistory(req.params.id);
    const states = await movementVerifications(history.map((m) => m.id));
    res.json({ movements: history.map((m) => ({ ...m, verification: states.get(m.id) ?? null })) });
  })
);

/** The register across the caller's cases (the registry: all). */
router.get(
  "/malkhana",
  requireRole("police", "prosecutor", "judge", "court_admin"),
  asyncRoute(async (req, res) => {
    const caseIds =
      req.user!.role === "court_admin"
        ? null
        : (unwrapList(await db.from("case_assignments").select("case_id").eq("user_id", req.user!.id)) as { case_id: string }[]).map((a) => a.case_id);
    res.json({ items: caseIds && caseIds.length === 0 ? [] : await malkhanaRegister(caseIds) });
  })
);

router.get(
  "/evidence/:id/custody-form.pdf",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    const item = unwrapMaybe(await db.from("evidence_items").select("case_id").eq("id", req.params.id).maybeSingle()) as { case_id: string } | null;
    if (!item) throw notFound("Evidence item");
    await assertCaseAccess(req, item.case_id);
    const form = await custodyFormPdf(req.params.id);
    await recordAction(req, { action: "evidence.custody_form_pdf", subject: req.params.id, caseId: item.case_id });
    pdf(res, form.pdf, `custody-form-${form.publicRef}.pdf`);
  })
);

export default router;
