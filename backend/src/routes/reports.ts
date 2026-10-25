import { Router } from "express";
import { z } from "zod";
import { db, unwrapList } from "../lib/supabase";
import { sha256Hex } from "../lib/crypto";
import { badRequest, unavailable } from "../lib/errors";
import { logger } from "../lib/logger";
import { asyncRoute } from "../middleware/error";
import { validate, uuid, safeText } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { recordAction } from "../services/audit";
import { loadDossier, redactForRole } from "../services/report.service";
import { canSeeFir } from "../services/case.service";
import type { UserRole } from "../middleware/auth";
import { buildFinalReport } from "../lib/pdf/finalReport";
import { sendCaseDocument, maskEmail } from "../lib/mailer";
import { capabilities } from "../config/env";
import { listCaseRecipients } from "../services/assignments.service";

/**
 * Court documents: produced here, and emailed from here.
 *
 * WHY THE SERVER RENDERS THEM AND NOT THE BROWSER
 *   A charge sheet has to be identical every time it is produced, and it has to
 *   contain everything the record holds rather than whatever a screen had loaded.
 *   Rendering in the browser would make the document a function of the client's
 *   state, its fonts and its filters. Rendering here makes it a function of the
 *   database.
 *
 * WHY THE DIGEST IS RECORDED
 *   Every rendering is hashed and the hash written to the action log. That turns
 *   "is this the report you filed in March" into a question with an answer, without
 *   storing a copy of every PDF anybody ever generated.
 */

const router = Router();
router.use(requireAuth);

function fileNameFor(caseReference: string, kind: string): string {
  const safe = caseReference.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${kind}-${safe}.pdf`;
}

/**
 * The Final Report as a PDF.
 *
 * Available to everyone assigned to the case, including defence counsel: a charge
 * sheet is served on the accused as a matter of law, so withholding it here would
 * be the system inventing a restriction the code does not impose.
 */
router.get(
  "/cases/:id/final-report.pdf",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.id);

    const dossier = redactForRole(await loadDossier(req.params.id), req.user!.role);
    const pdf = await buildFinalReport(dossier).toBuffer();
    const digest = sha256Hex(pdf);

    await recordAction(req, {
      action: "report.final_report",
      subject: dossier.case.id,
      caseId: dossier.case.id,
      detail: {
        documentDigest: digest,
        exhibits: dossier.evidence.length,
        pages: undefined,
        bytes: pdf.length,
      },
    });

    res
      .status(200)
      .setHeader("content-type", "application/pdf")
      .setHeader(
        "content-disposition",
        `inline; filename="${fileNameFor(dossier.case.case_reference, "final-report")}"`
      )
      // So a recipient can check the bytes they received against the bytes sent
      // without opening the file.
      .setHeader("x-nyaysetu-sha256", digest)
      .setHeader("content-length", String(pdf.length))
      .end(pdf);
  })
);

/**
 * Emails the Final Report.
 *
 * Recipients default to the people assigned to the case, because those are the
 * people entitled to it and the list is already maintained. Addresses may also be
 * given explicitly — a Sessions registry, a superior officer, counsel who has not
 * yet been given an account — which is why the endpoint exists at all rather than
 * relying on whoever downloaded it forwarding the file.
 *
 * Restricted to the roles that file and receive filings. An accused person can
 * download their own copy; they cannot post it to arbitrary addresses from the
 * court's mail server.
 */
router.post(
  "/cases/:id/final-report/email",
  requireRole("police", "prosecutor", "judge", "court_admin"),
  validate(z.object({ id: uuid }), "params"),
  validate(
    z.object({
      /** Explicit addresses. Omitted or empty means everyone on the case. */
      recipients: z.array(z.string().trim().email().max(200)).max(20).optional(),
      /** Whether to include the people assigned to the case. */
      includeAssigned: z.boolean().default(true),
      note: safeText(600).optional().nullable(),
    })
  ),
  asyncRoute(async (req, res) => {
    if (!capabilities.emailNotifications) {
      throw unavailable(
        "No mail server is configured, so the report cannot be emailed. Download it and send it " +
          "yourself, or configure SMTP_HOST, SMTP_USER and SMTP_PASSWORD."
      );
    }

    await assertCaseAccess(req, req.params.id);
    const body = req.body as { recipients?: string[]; includeAssigned: boolean; note?: string | null };

    const dossier = await loadDossier(req.params.id);

    const assigned = body.includeAssigned ? await listCaseRecipients(req.params.id) : [];

    // An address typed in by hand has no known role, so it gets the copy with
    // the FIR number withheld.
    const explicit = (body.recipients ?? []).map((email) => ({
      id: null as string | null,
      email,
      full_name: null as string | null,
      role: null as string | null,
    }));

    // Deduplicated on the address, case-insensitively, so somebody who is both
    // assigned and typed in does not receive it twice.
    const seen = new Set<string>();
    const targets = [...assigned, ...explicit].filter((t) => {
      const key = String(t.email).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (targets.length === 0) {
      throw badRequest(
        "Nobody to send it to. Either assign participants to the case or give at least one address."
      );
    }

    // Two renderings at most: one naming the FIR for the roles that may read it,
    // one withholding it for everyone else. Each recipient gets the one for them.
    const privileged = await buildFinalReport(dossier).toBuffer();
    const redacted = await buildFinalReport(redactForRole(dossier, null)).toBuffer();
    const fileName = fileNameFor(dossier.case.case_reference, "final-report");

    // Sent one at a time rather than as a single message with many recipients, so
    // that one bad address fails alone and nobody learns who else received it.
    const results = [];
    for (const target of targets) {
      const pdf = target.role && canSeeFir(target.role as UserRole) ? privileged : redacted;
      const digest = sha256Hex(pdf);
      const outcome = await sendCaseDocument({
        to: target.email,
        userId: target.id,
        recipientName: target.full_name,
        documentTitle: "Final Report / Charge Sheet",
        fileName,
        pdf,
        caseReference: dossier.case.case_reference,
        caseTitle: dossier.case.title,
        sentByName: req.user!.fullName,
        digest,
        note: body.note ?? null,
      });
      results.push({ to: maskEmail(target.email), status: outcome.status, error: outcome.error ?? null });
    }

    const failed = results.filter((r) => r.status !== "sent").length;
    if (failed > 0) {
      logger.warn("Some copies of the final report could not be delivered", {
        caseId: dossier.case.id,
        failed,
      });
    }

    await recordAction(req, {
      action: "report.final_report_emailed",
      subject: dossier.case.id,
      caseId: dossier.case.id,
      outcome: failed === results.length ? "failed" : "ok",
      detail: {
        documentDigest: sha256Hex(privileged),
        redactedDigest: sha256Hex(redacted),
        recipients: results.length,
        failed,
      },
    });

    res.json({
      sent: results.filter((r) => r.status === "sent").length,
      failed,
      digest: sha256Hex(privileged),
      redactedDigest: sha256Hex(redacted),
      fileName,
      results,
    });
  })
);

/**
 * Who this report would go to, so the UI can show the list before sending.
 *
 * Addresses are returned in full rather than masked, because the person calling
 * this is already entitled to the case file and is about to send them a document —
 * masking here would only stop them noticing a wrong address before it is used.
 */
router.get(
  "/cases/:id/final-report/recipients",
  requireRole("police", "prosecutor", "judge", "court_admin"),
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.params.id);

    const rows = await listCaseRecipients(req.params.id);

    res.json({
      emailConfigured: capabilities.emailNotifications,
      recipients: rows.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        role: u.role,
        access: u.access,
      })),
    });
  })
);

export default router;
