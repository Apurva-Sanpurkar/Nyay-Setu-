import { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/error";
import { validate, safeText } from "../middleware/validate";
import { requireAuth, requireRole } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { recordAction } from "../services/audit";
import { listTemplates, loadTemplate, updateTemplate } from "../services/certificate.service";

/**
 * Document templates (2.0 · F11). Readable by any signed-in user so they can see
 * what a document will say; editable only by the court registry, so the wording
 * of the Section 63 certificate can follow the Schedule without a code change.
 */
const router = Router();
router.use(requireAuth);

router.get(
  "/",
  asyncRoute(async (_req, res) => {
    res.json({ templates: await listTemplates() });
  })
);

router.get(
  "/:key",
  validate(z.object({ key: z.string().regex(/^[a-z0-9_]{3,60}$/) }), "params"),
  asyncRoute(async (req, res) => {
    res.json({ template: await loadTemplate(req.params.key) });
  })
);

router.put(
  "/:key",
  requireRole("court_admin"),
  writeLimiter,
  validate(z.object({ key: z.string().regex(/^[a-z0-9_]{3,60}$/) }), "params"),
  validate(
    z.object({
      title: safeText(300).pipe(z.string().min(5)),
      sections: z.array(z.object({ heading: safeText(200).pipe(z.string().min(1)), body: safeText(6000) })).min(1).max(30),
      footer: safeText(600).pipe(z.string().min(20)),
    })
  ),
  asyncRoute(async (req, res) => {
    const template = await updateTemplate(req.user!, req.params.key, req.body);
    await recordAction(req, { action: "template.update", subject: req.params.key, detail: { version: template.version } });
    res.json({ template });
  })
);

export default router;
