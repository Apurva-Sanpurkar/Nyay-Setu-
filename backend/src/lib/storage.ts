import * as fs from "fs";
import * as path from "path";
import { env, capabilities } from "../config/env";
import { logger } from "./logger";
import { encryptBuffer, decryptBuffer, EncryptedBlob } from "./crypto";
import { AppError, notFound } from "./errors";

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
  backend: "pinata" | "local";
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

  const response = await fetch(PINATA_PIN_URL, {
    method: "POST",
    headers: pinataHeaders(),
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new AppError(502, "IPFS_ERROR", `Pinata rejected the upload (${response.status}).`, body.slice(0, 300));
  }

  const json = (await response.json()) as { IpfsHash?: string };
  if (!json.IpfsHash) throw new AppError(502, "IPFS_ERROR", "Pinata returned no CID.");
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

/** Encrypts, then stores. Returns everything needed to get the bytes back. */
export async function storeEncrypted(plaintext: Buffer, fileName: string): Promise<StoredBlob> {
  const blob = encryptBuffer(plaintext);

  if (capabilities.ipfs) {
    const cid = await pinToPinata(blob, fileName);
    logger.info("Pinned encrypted evidence to IPFS", { cid, bytes: blob.ciphertext.length });
    return {
      cid,
      iv: blob.iv,
      tag: blob.tag,
      keyId: blob.keyId,
      bytes: blob.ciphertext.length,
      backend: "pinata",
    };
  }

  // Local fallback. The "CID" is the digest of the ciphertext, so it is still
  // content-addressed and still stable.
  const { createHash } = await import("crypto");
  const digest = createHash("sha256").update(blob.ciphertext).digest("hex");
  const cid = `local-${digest}`;

  fs.mkdirSync(env.localBlobDir, { recursive: true });
  fs.writeFileSync(localPath(cid), blob.ciphertext);
  logger.warn("Stored evidence locally; Pinata is not configured", { cid });

  return {
    cid,
    iv: blob.iv,
    tag: blob.tag,
    keyId: blob.keyId,
    bytes: blob.ciphertext.length,
    backend: "local",
  };
}

/** Fetches and decrypts. Throws if the auth tag fails, which means tampering. */
export async function loadDecrypted(cid: string, iv: string, tag: string): Promise<Buffer> {
  let ciphertext: Buffer;

  if (cid.startsWith("local-")) {
    const file = localPath(cid);
    if (!fs.existsSync(file)) throw notFound("Stored evidence file");
    ciphertext = fs.readFileSync(file);
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
