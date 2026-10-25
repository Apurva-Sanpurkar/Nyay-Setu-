import { Router } from "express";
import { z } from "zod";
import { db, unwrap, unwrapList } from "../lib/supabase";
import { encryptField } from "../lib/crypto";
import { asyncRoute } from "../middleware/error";
import { validate } from "../middleware/validate";
import { requireAuth, requireRole } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { recordAction } from "../services/audit";
import { badRequest, notFound } from "../lib/errors";

/**
 * Capture-manifest signing keys (2.0 · F10). A device registers its key once;
 * after that every manifest it signs is checked against it. Police and the
 * forensic laboratory capture; nobody else needs a key.
 */
const router = Router();
router.use(requireAuth);

const keyId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);

const body = z.discriminatedUnion("algorithm", [
  z.object({
    algorithm: z.literal("ECDSA-P256-SHA256"),
    keyId,
    platform: z.enum(["web", "android", "ios"]),
    label: z.string().trim().max(80).optional(),
    publicJwk: z
      .object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string().max(64), y: z.string().max(64) })
      .passthrough(),
  }),
  z.object({
    algorithm: z.literal("HMAC-SHA256"),
    keyId,
    platform: z.enum(["web", "android", "ios"]),
    label: z.string().trim().max(80).optional(),
    secret: z.string().regex(/^[0-9a-f]{64}$/, "32 bytes of lower-case hex"),
  }),
]);

router.post(
  "/keys",
  requireRole("police", "forensic_lab"),
  writeLimiter,
  validate(body),
  asyncRoute(async (req, res) => {
    const input = req.body as z.infer<typeof body>;
    const existing = await db.from("device_keys").select("user_id").eq("key_id", input.keyId).maybeSingle();
    if (existing.data) {
      if ((existing.data as any).user_id !== req.user!.id) throw badRequest("That key id is taken. Generate a new one.");
      return res.json({ ok: true, keyId: input.keyId, alreadyRegistered: true });
    }

    const row = unwrap(
      await db
        .from("device_keys")
        .insert({
          user_id: req.user!.id,
          key_id: input.keyId,
          algorithm: input.algorithm,
          platform: input.platform,
          label: input.label ?? null,
          // Only the public half of an ECDSA key exists here. An HMAC secret is
          // stored encrypted with the evidence key and never returned.
          public_jwk:
            input.algorithm === "ECDSA-P256-SHA256"
              ? { kty: "EC", crv: "P-256", x: input.publicJwk.x, y: input.publicJwk.y }
              : null,
          secret_encrypted: input.algorithm === "HMAC-SHA256" ? encryptField(input.secret) : null,
        })
        .select("key_id, algorithm, platform, label, created_at")
        .single()
    );

    await recordAction(req, { action: "device.key_registered", subject: input.keyId, detail: { platform: input.platform } });
    res.status(201).json({ key: row });
  })
);

router.get(
  "/keys",
  asyncRoute(async (req, res) => {
    const keys = unwrapList(
      await db
        .from("device_keys")
        .select("key_id, algorithm, platform, label, created_at, revoked_at")
        .eq("user_id", req.user!.id)
        .order("created_at", { ascending: false })
    );
    res.json({ keys });
  })
);

router.delete(
  "/keys/:keyId",
  writeLimiter,
  validate(z.object({ keyId }), "params"),
  asyncRoute(async (req, res) => {
    const updated = unwrapList(
      await db
        .from("device_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("key_id", req.params.keyId)
        .eq("user_id", req.user!.id)
        .select("key_id")
    );
    if (updated.length === 0) throw notFound("Device key");
    await recordAction(req, { action: "device.key_revoked", subject: req.params.keyId });
    res.json({ ok: true });
  })
);

export default router;
