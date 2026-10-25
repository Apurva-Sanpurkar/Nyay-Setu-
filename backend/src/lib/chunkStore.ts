import * as fs from "fs";
import * as path from "path";
import { db } from "./supabase";
import { env } from "../config/env";
import { AppError } from "./errors";

/**
 * Where the pieces of a resumable upload wait until the recording is complete.
 *
 * Pieces arrive in separate requests. On a single long-running server they can
 * wait on local disk; on serverless hosting (Vercel) consecutive requests may
 * reach different instances, so pieces must live somewhere shared. The
 * Supabase Storage backend keeps them in a private bucket. Either way the
 * bytes stored are already AES-256-GCM encrypted by the caller.
 *
 * UPLOAD_STORE=disk|supabase chooses explicitly; by default the in-memory test
 * database uses disk and a real database uses Supabase Storage.
 */
export interface ChunkStore {
  readonly name: "disk" | "supabase";
  put(uploadId: string, index: number, data: Buffer): Promise<void>;
  get(uploadId: string, index: number): Promise<Buffer | null>;
  remove(uploadId: string): Promise<void>;
}

const diskStore: ChunkStore = {
  name: "disk",
  async put(uploadId, index, data) {
    const dir = path.join(env.localBlobDir, "staging", uploadId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${index}.bin`), data);
  },
  async get(uploadId, index) {
    const file = path.join(env.localBlobDir, "staging", uploadId, `${index}.bin`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  },
  async remove(uploadId) {
    fs.rmSync(path.join(env.localBlobDir, "staging", uploadId), { recursive: true, force: true });
  },
};

/** Private bucket created by migration 013_upload_staging.sql. */
export const STAGING_BUCKET = "upload-staging";

const supabaseStore: ChunkStore = {
  name: "supabase",
  async put(uploadId, index, data) {
    const { error } = await db.storage.from(STAGING_BUCKET).upload(`${uploadId}/${index}.bin`, data, {
      contentType: "application/octet-stream",
      upsert: true,
    });
    if (error) {
      throw new AppError(503, "STAGING_UNAVAILABLE", `The piece could not be stored: ${error.message}. Send it again.`);
    }
  },
  async get(uploadId, index) {
    const { data, error } = await db.storage.from(STAGING_BUCKET).download(`${uploadId}/${index}.bin`);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  },
  async remove(uploadId) {
    const { data } = await db.storage.from(STAGING_BUCKET).list(uploadId, { limit: 1000 });
    const paths = (data ?? []).map((f) => `${uploadId}/${f.name}`);
    if (paths.length) await db.storage.from(STAGING_BUCKET).remove(paths);
  },
};

export function chunkStore(): ChunkStore {
  const choice = process.env.UPLOAD_STORE ?? (process.env.NYAY_DB === "memory" ? "disk" : "supabase");
  return choice === "disk" ? diskStore : supabaseStore;
}
