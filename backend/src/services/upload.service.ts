import { createHash } from "crypto";
import { db, unwrap, unwrapMaybe } from "../lib/supabase";
import { encryptBuffer, decryptBuffer } from "../lib/crypto";
import { env } from "../config/env";
import { badRequest, conflict, forbidden, notFound, AppError } from "../lib/errors";
import { Sha256, toHex32 } from "../shared/integrity";
import { chunkStore } from "../lib/chunkStore";
import type { SessionUser } from "../middleware/auth";

/**
 * Resumable uploads for long recordings (2.0 · F12).
 *
 * Each piece is checked against its own SHA-256 on arrival and stored AES-256-GCM
 * encrypted (lib/chunkStore: local disk, or a private Supabase Storage bucket when
 * hosted serverlessly), so a plaintext recording never rests on the server.
 * Assembly decrypts the pieces in order, feeds them to an incremental SHA-256 as
 * it goes, and refuses the whole recording if the result differs from what the
 * device declared.
 */

export interface UploadSession {
  id: string;
  user_id: string;
  case_id: string;
  file_name: string;
  mime_type: string;
  total_bytes: number;
  chunk_size: number;
  total_chunks: number;
  declared_sha256: string;
  received: number[];
  chunk_digests: Record<string, string>;
  status: "open" | "consumed" | "expired" | "refused";
  expires_at: string;
}

function present(session: UploadSession) {
  const received = [...session.received].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let i = 0; i < session.total_chunks && missing.length < 50; i++) if (!received.includes(i)) missing.push(i);
  return {
    uploadId: session.id,
    status: session.status,
    chunkSize: session.chunk_size,
    totalChunks: session.total_chunks,
    totalBytes: Number(session.total_bytes),
    received,
    nextMissing: missing[0] ?? null,
    complete: received.length === session.total_chunks,
    expiresAt: session.expires_at,
  };
}

export async function openUpload(
  user: SessionUser,
  input: { caseId: string; fileName: string; mimeType: string; totalBytes: number; chunkSize: number; sha256: string }
) {
  if (input.totalBytes > env.MAX_CHUNKED_UPLOAD_BYTES) {
    throw badRequest(`Recordings up to ${Math.round(env.MAX_CHUNKED_UPLOAD_BYTES / 1024 / 1024)} MB can be uploaded in pieces.`);
  }
  const totalChunks = Math.ceil(input.totalBytes / input.chunkSize);
  const row = unwrap(
    await db
      .from("upload_sessions")
      .insert({
        user_id: user.id,
        case_id: input.caseId,
        file_name: input.fileName,
        mime_type: input.mimeType,
        total_bytes: input.totalBytes,
        chunk_size: input.chunkSize,
        total_chunks: totalChunks,
        declared_sha256: input.sha256.toLowerCase(),
        received: [],
        chunk_digests: {},
        status: "open",
        expires_at: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      })
      .select("*")
      .single()
  ) as UploadSession;
  return present(row);
}

export async function loadUpload(user: SessionUser, uploadId: string): Promise<UploadSession> {
  const row = unwrapMaybe(await db.from("upload_sessions").select("*").eq("id", uploadId).maybeSingle()) as UploadSession | null;
  if (!row) throw notFound("Upload");
  if (row.user_id !== user.id) throw forbidden("This upload belongs to someone else.");
  if (row.status === "open" && new Date(row.expires_at).getTime() < Date.now()) {
    await db.from("upload_sessions").update({ status: "expired" }).eq("id", row.id);
    throw new AppError(410, "UPLOAD_EXPIRED", "This upload expired. Start it again; the recording is still on your device.");
  }
  return row;
}

export async function uploadStatus(user: SessionUser, uploadId: string) {
  return present(await loadUpload(user, uploadId));
}

/** Stores one piece. Re-sending the same bytes is harmless; different bytes are refused. */
export async function putChunk(user: SessionUser, uploadId: string, index: number, bytes: Buffer, declaredChunkSha: string | null) {
  const session = await loadUpload(user, uploadId);
  if (session.status !== "open") throw conflict(`This upload is ${session.status}.`);
  if (!Number.isInteger(index) || index < 0 || index >= session.total_chunks) throw badRequest("Piece index out of range.");

  const isLast = index === session.total_chunks - 1;
  const expectedLength = isLast ? Number(session.total_bytes) - index * session.chunk_size : session.chunk_size;
  if (bytes.length !== expectedLength) {
    throw badRequest(`Piece ${index} should be ${expectedLength} bytes; ${bytes.length} arrived.`);
  }

  const digest = "0x" + createHash("sha256").update(bytes).digest("hex");
  if (declaredChunkSha && declaredChunkSha.toLowerCase() !== digest) {
    throw conflict(`Piece ${index} was damaged in transit: its digest does not match. Send it again.`);
  }

  const previous = session.chunk_digests[String(index)];
  if (previous) {
    if (previous !== digest) throw conflict(`Piece ${index} was already received with different content.`);
    return present(session);
  }

  const sealed = encryptBuffer(bytes);
  await chunkStore().put(session.id, index, Buffer.concat([Buffer.from(sealed.iv + sealed.tag, "utf8"), sealed.ciphertext]));

  // Read-modify-write guarded by status. Two pieces arriving at once each add
  // their own index; a lost update is caught at assembly, which re-checks every
  // piece is stored, and the client simply re-sends what status reports missing.
  const fresh = (await loadUpload(user, uploadId)) as UploadSession;
  const received = Array.from(new Set([...fresh.received, index]));
  const digests = { ...fresh.chunk_digests, [String(index)]: digest };
  const updated = unwrap(
    await db
      .from("upload_sessions")
      .update({ received, chunk_digests: digests })
      .eq("id", session.id)
      .eq("status", "open")
      .select("*")
      .single()
  ) as UploadSession;
  return present(updated);
}

/**
 * Reassembles a complete upload into memory for registration, hashing every
 * piece incrementally as it is decrypted. Throws if any piece is missing, any
 * piece's digest changed on disk, or the whole recording's digest differs from
 * the one the device declared.
 */
export async function assembleUpload(user: SessionUser, uploadId: string, caseId: string): Promise<{ session: UploadSession; buffer: Buffer; sha256: string }> {
  const session = await loadUpload(user, uploadId);
  if (session.status !== "open") throw conflict(`This upload is ${session.status}.`);
  if (session.case_id !== caseId) throw conflict("This upload was opened for a different case.");
  if (session.received.length !== session.total_chunks) {
    throw conflict(`${session.total_chunks - session.received.length} piece(s) have not arrived yet.`, present(session));
  }

  const hasher = new Sha256();
  const parts: Buffer[] = [];
  const store = chunkStore();
  for (let index = 0; index < session.total_chunks; index++) {
    const raw = await store.get(session.id, index);
    if (!raw) throw conflict(`Piece ${index} is missing on the server. Send it again.`, present(session));
    const header = raw.subarray(0, 24 + 32).toString("utf8");
    const plain = decryptBuffer(raw.subarray(56), header.slice(0, 24), header.slice(24, 56));
    const digest = "0x" + createHash("sha256").update(plain).digest("hex");
    if (digest !== session.chunk_digests[String(index)]) {
      throw conflict(`Piece ${index} no longer matches the digest it arrived with.`);
    }
    hasher.update(plain);
    parts.push(plain);
  }

  const sha256 = toHex32(hasher.digest());
  if (sha256 !== session.declared_sha256) {
    await db.from("upload_sessions").update({ status: "refused" }).eq("id", session.id);
    throw conflict(
      "The reassembled recording does not hash to the digest your device declared. It was refused; nothing was registered.",
      { declared: session.declared_sha256, assembled: sha256 }
    );
  }
  return { session, buffer: Buffer.concat(parts), sha256 };
}

export async function consumeUpload(uploadId: string, evidenceId: string): Promise<void> {
  await db.from("upload_sessions").update({ status: "consumed", evidence_id: evidenceId }).eq("id", uploadId);
  await chunkStore().remove(uploadId);
}
