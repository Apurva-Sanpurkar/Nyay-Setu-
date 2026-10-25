import { Router } from "express";
import { z } from "zod";
import { db, unwrap, unwrapList, unwrapMaybe } from "../lib/supabase";
import { describeSections } from "../lib/statute";
import { forbidden, notFound } from "../lib/errors";
import { asyncRoute } from "../middleware/error";
import { validate, safeText, firNumber, uuid } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { recordAction } from "../services/audit";
import { listCaseEvidence } from "../services/evidence.service";
import { listForCase as summonsForCase } from "../services/summons.service";
import { listCaseParticipants } from "../services/assignments.service";
import {
  CASE_COLUMNS,
  FIR_ROLES,
  caseActivity,
  createCase,
  getFirRecord,
  linkFir,
  presentCase,
  presentCases,
  firView,
} from "../services/case.service";

const router = Router();
router.use(requireAuth);

/** Cases the caller may see. The court registry sees all of them. */
router.get(
  "/",
  asyncRoute(async (req, res) => {
    const user = req.user!;

    if (user.role === "court_admin") {
      const cases = unwrapList(
        await db.from("cases").select(CASE_COLUMNS).order("registered_at", { ascending: false }).limit(200)
      );
      return res.json({ cases: await presentCases(cases, user.role) });
    }

    const assignments = unwrapList(
      await db.from("case_assignments").select("case_id, access").eq("user_id", user.id)
    ) as { case_id: string; access: string }[];

    if (assignments.length === 0) return res.json({ cases: [] });

    const cases = unwrapList(
      await db
        .from("cases")
        .select(CASE_COLUMNS)
        .in(
          "id",
          assignments.map((a) => a.case_id)
        )
        .order("registered_at", { ascending: false })
    ) as any[];

    const accessById = new Map(assignments.map((a) => [a.case_id, a.access]));
    const presented = await presentCases(cases, user.role);
    res.json({ cases: presented.map((c) => ({ ...c, access: accessById.get(c.id) ?? "read" })) });
  })
);

const firBody = z.object({
  number: z.string().trim().min(1).max(40),
  year: z.coerce.number().int(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  policeStation: safeText(160).optional(),
  district: safeText(120).optional().nullable(),
});

const createBody = z
  .object({
    title: safeText(200).pipe(z.string().min(3, "A title of at least 3 characters is required")),
    offenceType: safeText(120).pipe(z.string().min(2)),
    sections: z.array(safeText(40)).max(20).default([]),
    policeStation: safeText(160).pipe(z.string().min(2)),
    courtName: safeText(160).optional().nullable(),
    summary: safeText(8000).optional().nullable(),
    origin: z.enum(["fir", "complaint", "court", "other"]).optional(),
    fir: firBody.optional().nullable(),
    /** 1.0 clients sent the FIR number on its own. Still accepted. */
    firNumber: firNumber.optional(),
  })
  .strict();

/**
 * Register a case. The FIR is optional and stored apart from the case; the
 * on-chain key is a salted hash, so nothing about the case is recoverable from
 * the chain (docs/DECISIONS.md D-02).
 */
router.post(
  "/",
  requireRole("police", "court_admin"),
  writeLimiter,
  validate(createBody),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof createBody>;
    const fir =
      body.fir ??
      (body.firNumber ? { number: body.firNumber, year: new Date().getUTCFullYear(), date: null } : undefined);

    const result = await createCase(req, req.user!, {
      title: body.title,
      offenceType: body.offenceType,
      sections: body.sections,
      policeStation: body.policeStation,
      courtName: body.courtName ?? null,
      summary: body.summary ?? null,
      origin: body.origin ?? (fir ? "fir" : "complaint"),
      fir: fir ?? undefined,
    });

    res.status(201).json(result);
  })
);

router.get(
  "/:id",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.id);

    const row = unwrapMaybe(
      await db.from("cases").select(`${CASE_COLUMNS}, summary`).eq("id", req.params.id).maybeSingle()
    ) as any;
    if (!row) throw notFound("Case");

    // Two queries rather than an embed: case_assignments has two foreign keys to
    // users, so PostgREST cannot tell which one an embed means and refuses the
    // whole request with PGRST201. See assignments.service.ts.
    const [assignments, fir] = await Promise.all([listCaseParticipants(row.id), getFirRecord(row.id)]);

    const redactPrivileged = req.user!.role === "defence_lawyer" || req.user!.role === "accused";
    const presented = presentCase(row, req.user!.role, fir);
    res.json({
      case: redactPrivileged ? { ...presented, summary: null } : presented,
      assignments,
      statute: describeSections(row.sections ?? []),
    });
  })
);

/** One call that fills a case dossier screen. */
router.get(
  "/:id/overview",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.id);
    const caseId = req.params.id;

    const row = unwrapMaybe(
      await db.from("cases").select(`${CASE_COLUMNS}, summary`).eq("id", caseId).maybeSingle()
    ) as any;
    if (!row) throw notFound("Case");

    const [evidence, summons, bail, violations, fir] = await Promise.all([
      listCaseEvidence(caseId),
      summonsForCase(caseId),
      db
        .from("bail_conditions")
        .select("id, accused_name, conditions, compliance_score, risk_band, active, expiry_at, radius_metres")
        .eq("case_id", caseId)
        .maybeSingle()
        .then((r) => r.data),
      db
        .from("violations")
        .select("id, kind, reason, detected_at, acknowledged_at")
        .eq("case_id", caseId)
        .order("detected_at", { ascending: false })
        .limit(20)
        .then((r) => r.data ?? []),
      getFirRecord(caseId),
    ]);

    // The defence sees the evidence chain and nothing that would expose the
    // prosecution's working notes.
    const redactPrivileged = req.user!.role === "defence_lawyer";
    const presented = presentCase(row, req.user!.role, fir);

    res.json({
      case: redactPrivileged ? { ...presented, summary: null } : presented,
      statute: describeSections(row.sections ?? []),
      evidence,
      summons: redactPrivileged ? [] : summons,
      bail,
      violations,
      counts: {
        evidence: evidence.length,
        flaggedEvidence: evidence.filter((e: any) => e.anomaly_flagged).length,
        summons: summons.length,
        openViolations: violations.filter((v: any) => !v.acknowledged_at).length,
      },
    });
  })
);

/** The FIR linked to a case. Police, prosecutor, judge and court admin only. */
router.get(
  "/:id/fir",
  requireRole(...FIR_ROLES),
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.id);
    res.json({ fir: firView(await getFirRecord(req.params.id), req.user!.role) });
  })
);

/** Link an FIR to a case, or correct one. Police with write access, or the registry. */
router.put(
  "/:id/fir",
  requireRole("police", "court_admin"),
  writeLimiter,
  validate(z.object({ id: uuid }), "params"),
  validate(firBody.extend({ policeStation: safeText(160).pipe(z.string().min(2)) })),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.id, "write");
    const fir = await linkFir(req, req.user!, req.params.id, req.body);
    res.json({ fir });
  })
);

/**
 * The case's activity, oldest first: everything the API recorded against it,
 * including refusals. Detail is reduced to a safe whitelist because every
 * assigned role, defence included, can read it.
 */
router.get(
  "/:id/timeline",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.id);
    res.json({ entries: await caseActivity(req.params.id) });
  })
);

/** Case assignment is how every other permission is derived. */
router.post(
  "/:id/assignments",
  requireRole("court_admin", "judge"),
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      userId: uuid,
      access: z.enum(["read", "write"]).default("read"),
    })
  ),
  asyncRoute(async (req, res) => {
    const caseId = req.params.id;
    // A judge manages participants only on cases they sit on.
    if (req.user!.role === "judge") await assertCaseAccess(req, caseId);
    const { userId, access } = req.body as { userId: string; access: "read" | "write" };

    const target = unwrapMaybe(
      await db.from("users").select("id, full_name, role").eq("id", userId).maybeSingle()
    ) as { id: string; full_name: string; role: string } | null;
    if (!target) throw notFound("User");

    // Defence counsel and the accused never get write access to prosecution material.
    const effective = target.role === "defence_lawyer" || target.role === "accused" ? "read" : access;

    const row = unwrap(
      await db
        .from("case_assignments")
        .upsert(
          { case_id: caseId, user_id: userId, access: effective, assigned_by: req.user!.id },
          { onConflict: "case_id,user_id" }
        )
        .select("case_id, user_id, access, created_at")
        .single()
    );

    await recordAction(req, {
      action: "case.assign",
      subject: userId,
      caseId,
      detail: { role: target.role, access: effective, downgraded: effective !== access },
    });

    res.status(201).json({ assignment: row, downgradedToRead: effective !== access });
  })
);

router.delete(
  "/:id/assignments/:userId",
  requireRole("court_admin", "judge"),
  validate(z.object({ id: uuid, userId: uuid }), "params"),
  asyncRoute(async (req, res) => {
    if (req.user!.role === "judge") await assertCaseAccess(req, req.params.id);

    await db
      .from("case_assignments")
      .delete()
      .eq("case_id", req.params.id)
      .eq("user_id", req.params.userId);

    await recordAction(req, {
      action: "case.unassign",
      subject: req.params.userId,
      caseId: req.params.id,
    });

    res.json({ ok: true });
  })
);

router.patch(
  "/:id/status",
  requireRole("police", "prosecutor", "judge", "court_admin"),
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      status: z.enum(["registered", "under_investigation", "charge_sheeted", "trial", "disposed"]),
    })
  ),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.id, "write");

    // Closing a case is a governance action: it needs two different people
    // (F19). This route refuses it outright rather than half-supporting it.
    if (req.body.status === "disposed") {
      throw forbidden(
        "Closing a case needs two-person approval. Request it from the case's governance panel."
      );
    }

    const row = unwrap(
      await db
        .from("cases")
        .update({ status: req.body.status })
        .eq("id", req.params.id)
        .select(CASE_COLUMNS)
        .single()
    );

    await recordAction(req, {
      action: "case.status_change",
      subject: req.params.id,
      caseId: req.params.id,
      detail: { status: req.body.status },
    });

    res.json({ case: presentCase(row, req.user!.role, await getFirRecord(req.params.id)) });
  })
);

export default router;
