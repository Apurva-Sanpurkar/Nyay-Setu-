import * as fs from "fs";
import * as path from "path";
import { env, capabilities } from "../config/env";
import { logger } from "./logger";
import { encryptBuffer, decryptBuffer, EncryptedBlob } from "./crypto";
import { AppError, notFound } from "./errors";
import { db } from "./supabase";

/**
 * Evidence file storage.
 *
 * The order of operations is the security property: the plaintext is encrypted
 * with AES-256-GCM inside this process, and only the ciphertext is handed to
 * Pinata. IPFS content is world-readable by CID, so pinning a plaintext
 * evidence photo would publish it. The key never leaves the backend, so a
 * leaked CID yields nothing but noise.
 *
 * When Pinata is not configured the ciphertext is written to a local directory
 * instead. That keeps the whole demo runnable offline; it is not a production
 * posture and the health endpoint says so.
 */

export interface StoredBlob {
  cid: string;
  iv: string;
  tag: string;
  keyId: string;
  bytes: number;
  backend: "pinata" | "supabase" | "local";
}

const PINATA_PIN_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

function pinataHeaders(): Record<string, string> {
  if (env.PINATA_JWT) return { Authorization: `Bearer ${env.PINATA_JWT}` };
  return {
    pinata_api_key: env.PINATA_API_KEY ?? "",
    pinata_secret_api_key: env.PINATA_API_SECRET ?? "",
  };
}

function localPath(cid: string): string {
  // Guard against a crafted CID escaping the blob directory.
  const safe = cid.replace(/[^A-Za-z0-9_.-]/g, "");
  return path.join(env.localBlobDir, `${safe}.bin`);
}

async function pinToPinata(blob: EncryptedBlob, fileName: string): Promise<string> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(blob.ciphertext)], { type: "application/octet-stream" }),
    `${fileName}.enc`
  );
  form.append(
    "pinataMetadata",
    JSON.stringify({
      name: `${fileName}.enc`,
      // Metadata is public on Pinata, so it carries no case details.
      keyvalues: { project: "nyaysetu", encryption: "aes-256-gcm", keyId: blob.keyId },
    })
  );

  let response: Response;
  try {
    response = await fetch(PINATA_PIN_URL, {
      method: "POST",
      headers: pinataHeaders(),
      body: form,
    });
  } catch (error) {
    logger.error("Pinata unreachable", { reason: error instanceof Error ? error.message : String(error) });
    throw new AppError(
      502,
      "IPFS_UNREACHABLE",
      "The evidence store (Pinata) could not be reached, so nothing was registered. Check the API's internet connection and retry.",
      undefined,
      { expose: true }
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logger.error("Pinata rejected an upload", { status: response.status, body: body.slice(0, 300) });
    const hint =
      response.status === 401 || response.status === 403
        ? "Its credentials were refused: check PINATA_JWT in backend/.env."
        : response.status === 429
          ? "Its rate limit or plan quota was reached."
          : "Retry shortly.";
    throw new AppError(
      502,
      "IPFS_ERROR",
      `The evidence store (Pinata) refused the file (${response.status}), so nothing was registered. ${hint}`,
      undefined,
      { expose: true }
    );
  }

  const json = (await response.json()) as { IpfsHash?: string };
  if (!json.IpfsHash) throw new AppError(502, "IPFS_ERROR", "Pinata returned no CID.", undefined, { expose: true });
  return json.IpfsHash;
}

async function fetchFromPinata(cid: string): Promise<Buffer> {
  const url = `${env.PINATA_GATEWAY.replace(/\/$/, "")}/ipfs/${cid}`;
  const response = await fetch(url, {
    headers: env.PINATA_JWT ? { Authorization: `Bearer ${env.PINATA_JWT}` } : {},
  });
  if (!response.ok) {
    throw new AppError(502, "IPFS_ERROR", `Gateway returned ${response.status} for ${cid}.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Where evidence goes when Pinata is not configured or does not take it: a
 * private Supabase Storage bucket on a real database (it survives serverless
 * instances and restarts), or a local directory on the in-memory test database.
 * Only ciphertext is ever written, so the fallback is as safe as IPFS.
 */
export const VAULT_BUCKET = "evidence-vault";
let vaultReady = false;

async function storeFallback(ciphertext: Buffer, reason: string): Promise<{ cid: string; backend: "supabase" | "local" }> {
  const { createHash } = await import("crypto");
  const digest = createHash("sha256").update(ciphertext).digest("hex");

  if (process.env.NYAY_DB !== "memory") {
    const cid = `sb-${digest}`;
    if (!vaultReady) {
      // Created on first use, private, no policies: only the service role reaches it.
      const { error } = await db.storage.createBucket(VAULT_BUCKET, { public: false });
      if (error && !/already exists|duplicate/i.test(error.message)) {
        logger.error("Could not create the evidence vault bucket", { error: error.message });
      }
      vaultReady = true;
    }
    const { error } = await db.storage
      .from(VAULT_BUCKET)
      .upload(`${cid}.bin`, ciphertext, { contentType: "application/octet-stream", upsert: true });
    if (error) {
      logger.error("Evidence vault upload failed", { error: error.message, reason });
      throw new AppError(
        503,
        "STORAGE_UNAVAILABLE",
        `${reason} The backup store (Supabase Storage) also refused it: ${error.message}. Nothing was registered.`
      );
    }
    logger.warn("Stored encrypted evidence in the Supabase vault", { cid, reason });
    return { cid, backend: "supabase" };
  }

  const cid = `local-${digest}`;
  fs.mkdirSync(env.localBlobDir, { recursive: true });
  fs.writeFileSync(localPath(cid), ciphertext);
  logger.warn("Stored evidence locally", { cid, reason });
  return { cid, backend: "local" };
}

/** Encrypts, then stores. Returns everything needed to get the bytes back. */
export async function storeEncrypted(plaintext: Buffer, fileName: string): Promise<StoredBlob> {
  const blob = encryptBuffer(plaintext);
  const stored = (location: { cid: string; backend: StoredBlob["backend"] }): StoredBlob => ({
    ...location,
    iv: blob.iv,
    tag: blob.tag,
    keyId: blob.keyId,
    bytes: blob.ciphertext.length,
  });

  if (capabilities.ipfs) {
    try {
      const cid = await pinToPinata(blob, fileName);
      logger.info("Pinned encrypted evidence to IPFS", { cid, bytes: blob.ciphertext.length });
      return stored({ cid, backend: "pinata" });
    } catch (error) {
      // A Pinata outage, a quota or a revoked key must not stop an officer
      // registering evidence at the scene. The failure is logged loudly (with
      // Pinata's own reply, above) and the ciphertext goes to the vault.
      const reason = error instanceof Error ? error.message : "Pinata failed.";
      logger.error("Pinata did not take the evidence; using the backup store", { reason });
      return stored(await storeFallback(blob.ciphertext, reason));
    }
  }

  return stored(await storeFallback(blob.ciphertext, "Pinata is not configured."));
}

/** Fetches and decrypts. Throws if the auth tag fails, which means tampering. */
export async function loadDecrypted(cid: string, iv: string, tag: string): Promise<Buffer> {
  let ciphertext: Buffer;

  if (cid.startsWith("local-")) {
    const file = localPath(cid);
    if (!fs.existsSync(file)) throw notFound("Stored evidence file");
    ciphertext = fs.readFileSync(file);
  } else if (cid.startsWith("sb-")) {
    const { data, error } = await db.storage.from(VAULT_BUCKET).download(`${cid.replace(/[^A-Za-z0-9_.-]/g, "")}.bin`);
    if (error || !data) throw notFound("Stored evidence file");
    ciphertext = Buffer.from(await data.arrayBuffer());
  } else {
    ciphertext = await fetchFromPinata(cid);
  }

  try {
    return decryptBuffer(ciphertext, iv, tag);
  } catch {
    // GCM authentication failed: the stored bytes are not the bytes we wrote.
    throw new AppError(
      409,
      "CIPHERTEXT_TAMPERED",
      "The stored file failed its authentication tag. The bytes have been altered since pinning."
    );
  }
}
