import { db, unwrap, unwrapList, unwrapMaybe } from "../../lib/supabase";
import { sha256Hex } from "../../lib/crypto";
import { AppError, badRequest, notFound } from "../../lib/errors";
import { loadDecrypted, storeEncrypted } from "../../lib/storage";
import type { SessionUser } from "../../middleware/auth";
import { anchorRecord, verificationsFor, type SmartModule } from "./recordAnchor";

/**
 * Photographs and sketches for Vehicle Trace and Third Eye.
 *
 * Same handling as evidence: encrypted in this process before it is stored, the
 * SHA-256 of the plaintext anchored, the row append-only. The served copy is
 * re-hashed after decryption, so a substituted file is refused rather than shown.
 */

export type MediaKind = "vehicle_photo" | "plate_photo" | "suspect_photo" | "sketch" | "cctv_still" | "other";

/** 3.5 MB: under Vercel's 4.5 MB request cap with room for the form fields. */
export const MAX_MEDIA_BYTES = 3_500_000;

/** Identifies the format from the bytes, not from the name or the declared type. */
export function sniffImage(buffer: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("latin1") === "RIFF" && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const PUBLIC_COLUMNS = "id, module, subject_id, kind, sha256, mime_type, bytes, perceptual_hash, source_note, uploaded_by, uploaded_station, uploaded_at";

export async function storeMedia(args: {
  module: SmartModule;
  subjectId: string;
  kind: MediaKind;
  file: Buffer;
  perceptualHash?: string | null;
  sourceNote?: string | null;
  user: SessionUser;
}) {
  if (args.file.length === 0) throw badRequest("The image is empty.");
  if (args.file.length > MAX_MEDIA_BYTES) throw badRequest("The image is larger than 3.5 MB. The app compresses photos before sending; try again from the app.");
  const mime = sniffImage(args.file);
  if (!mime) throw badRequest("Only JPEG, PNG and WebP photographs are accepted.");

  const sha256 = sha256Hex(args.file);
  const stored = await storeEncrypted(args.file, `${args.module}-${args.kind}`);
  const row = unwrap(
    await db
      .from("secure_media")
      .insert({
        module: args.module,
        subject_id: args.subjectId,
        kind: args.kind,
        cid: stored.cid,
        iv: stored.iv,
        tag: stored.tag,
        key_id: stored.keyId,
        sha256,
        mime_type: mime,
        bytes: args.file.length,
        perceptual_hash: args.perceptualHash ?? null,
        source_note: args.sourceNote ?? null,
        uploaded_by: args.user.id,
        uploaded_station: args.user.stationOrCourt,
      })
      .select(PUBLIC_COLUMNS)
      .single()
  ) as any;

  const { anchor } = await anchorRecord({
    module: args.module,
    recordId: args.subjectId,
    digest: sha256,
    subjectType: "secure_media",
    subjectId: row.id,
    idempotencyKey: `secure_media:${row.id}`,
    actor: { id: args.user.id, role: args.user.role },
  });
  return { ...row, verification: { state: anchor.state, txHash: anchor.tx_hash } };
}

export async function listMedia(module: SmartModule, subjectIds: string[]) {
  if (subjectIds.length === 0) return [];
  const rows = unwrapList(
    await db.from("secure_media").select(PUBLIC_COLUMNS).eq("module", module).in("subject_id", subjectIds).order("uploaded_at", { ascending: true })
  ) as any[];
  const states = await verificationsFor("secure_media", rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, verification: states.get(r.id) ?? null }));
}

/** Decrypts one item and checks it against the digest recorded at upload. */
export async function readMedia(id: string) {
  const row = unwrapMaybe(await db.from("secure_media").select("*").eq("id", id).maybeSingle()) as any;
  if (!row) throw notFound("Photograph");
  const bytes = await loadDecrypted(row.cid, row.iv, row.tag);
  if (sha256Hex(bytes) !== row.sha256) {
    throw new AppError(409, "MEDIA_ALTERED", "The stored photograph does not match the digest recorded when it was uploaded.");
  }
  return { row, bytes };
}
