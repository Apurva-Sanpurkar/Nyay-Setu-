import { Router } from "express";
import { z } from "zod";
import QRCode from "qrcode";
import { asyncRoute } from "../middleware/error";
import { validate, hash32 } from "../middleware/validate";
import { publicLimiter } from "../middleware/rateLimit";
import { checkFileAgainstChain, publicPassport, verifyUrl } from "../services/passport/passport.service";
import { buildPassportPdf } from "../lib/pdf/passport";

/**
 * The public Integrity Passport (2.0 · F3). No sign-in, no session, no CSRF —
 * and nothing in any response that the privacy rule does not allow: reference,
 * digest, transaction, block time, state, custody event types with role labels.
 *
 * Every route here sits behind the strictest rate limit in the API, keyed by
 * address, because each request reads the chain on the visitor's behalf.
 */
const router = Router();
router.use(publicLimiter);
// The QR image and the PDF are embedded or opened by the SPA on another origin.
// They are public by design, so the API's default same-site resource policy is
// relaxed here and nowhere else.
router.use((_req, res, next) => {
  res.setHeader("cross-origin-resource-policy", "cross-origin");
  next();
});

const refParam = z.object({ ref: z.string().trim().min(4).max(40) });

router.get(
  "/verify/:ref",
  validate(refParam, "params"),
  asyncRoute(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json({ passport: await publicPassport(req.params.ref) });
  })
);

/** The visitor's browser hashed the file; only the digest arrives here. */
router.post(
  "/verify/:ref/check",
  validate(refParam, "params"),
  validate(z.object({ sha256: hash32 }).strict()),
  asyncRoute(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.json({ result: await checkFileAgainstChain(req.params.ref, req.body.sha256) });
  })
);

router.get(
  "/verify/:ref/passport.pdf",
  validate(refParam, "params"),
  asyncRoute(async (req, res) => {
    const passport = await publicPassport(req.params.ref);
    const pdf = await buildPassportPdf(passport, { verifyUrl: verifyUrl(passport.reference) });
    res
      .status(200)
      .setHeader("content-type", "application/pdf")
      .setHeader("content-disposition", `inline; filename="passport-${passport.reference}.pdf"`)
      .setHeader("cache-control", "no-store")
      .send(pdf);
  })
);

router.get(
  "/verify/:ref/qr.svg",
  validate(refParam, "params"),
  asyncRoute(async (req, res) => {
    // Resolved first so an unknown reference is a 404, not a QR code for nothing.
    const passport = await publicPassport(req.params.ref);
    const svg = await QRCode.toString(verifyUrl(passport.reference), {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      color: { dark: "#13201a", light: "#ffffff" },
    });
    res.setHeader("content-type", "image/svg+xml").setHeader("cache-control", "public, max-age=3600").send(svg);
  })
);

export default router;
