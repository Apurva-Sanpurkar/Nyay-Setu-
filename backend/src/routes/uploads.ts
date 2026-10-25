import express, { Router } from "express";
import { z } from "zod";
import { asyncRoute } from "../middleware/error";
import { validate, hash32, uuid, safeText } from "../middleware/validate";
import { requireAuth, requireRole, assertCaseAccess } from "../middleware/auth";
import { writeLimiter } from "../middleware/rateLimit";
import { openUpload, putChunk, uploadStatus } from "../services/upload.service";

/**
 * Resumable uploads for long recordings (2.0 · F12). Open, send pieces in any
 * order, ask which are missing, then register the evidence with the uploadId.
 */
const router = Router();
router.use(requireAuth);
router.use(requireRole("police", "forensic_lab"));

router.post(
  "/",
  writeLimiter,
  validate(
    z.object({
      caseId: uuid,
      fileName: safeText(255).pipe(z.string().min(1)),
      mimeType: z.string().trim().max(120).regex(/^[a-z]+\/[A-Za-z0-9.+-]+(;.*)?$/, "a MIME type"),
      totalBytes: z.coerce.number().int().positive(),
      chunkSize: z.coerce.number().int().min(256 * 1024).max(16 * 1024 * 1024),
      sha256: hash32,
    })
  ),
  asyncRoute(async (req, res) => {
    await assertCaseAccess(req, req.body.caseId, "write");
    res.status(201).json(await openUpload(req.user!, req.body));
  })
);

router.get(
  "/:id",
  validate(z.object({ id: uuid }), "params"),
  asyncRoute(async (req, res) => {
    res.json(await uploadStatus(req.user!, req.params.id));
  })
);

// Pieces arrive as raw bytes, not JSON, and are capped at the largest piece size.
router.put(
  "/:id/chunks/:index",
  express.raw({ type: "application/octet-stream", limit: 16 * 1024 * 1024 + 1024 }),
  validate(z.object({ id: uuid, index: z.coerce.number().int().min(0) }), "params"),
  asyncRoute(async (req, res) => {
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const declared = req.get("x-chunk-sha256") ?? null;
    res.json(await putChunk(req.user!, req.params.id, Number(req.params.index), bytes, declared));
  })
);

export default router;
