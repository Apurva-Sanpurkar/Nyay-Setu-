import { sha256Chunked, sha256Hex as pureSha256Hex } from "@nyaysetu/integrity";

/**
 * Client-side SHA-256, computed before a single byte leaves the device.
 *
 * Two paths, chosen by size:
 *
 *   - up to 32 MB: WebCrypto (`crypto.subtle.digest`), the browser's native,
 *     fastest implementation. It wants the whole file in memory, which at this
 *     size is fine.
 *   - above that: the incremental SHA-256 from @nyaysetu/integrity, fed a 4 MB
 *     slice at a time. Memory stays at one slice whatever the size, so a
 *     forty-minute search-and-seizure recording can be hashed on a phone.
 *
 * Both produce the same digest — the shared package is tested against
 * node:crypto at every length across block boundaries — so which path ran never
 * matters to anyone comparing digests later.
 */

const WEBCRYPTO_LIMIT = 32 * 1024 * 1024;
const CHUNK = 4 * 1024 * 1024;

export function isCryptoAvailable(): boolean {
  return typeof crypto !== "undefined" && typeof crypto.subtle?.digest === "function";
}

/**
 * Kept for callers that want to warn: WebCrypto needs a secure context. Hashing
 * still works without it (the streaming path is plain JavaScript), but the
 * camera and location do not, so live capture still needs HTTPS.
 */
export function explainCryptoAvailability(): string | null {
  return null;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return "0x" + out;
}

export async function sha256File(
  file: File | Blob,
  onProgress?: (fraction: number) => void,
  signal?: { aborted: boolean }
): Promise<string> {
  if (file.size <= WEBCRYPTO_LIMIT && isCryptoAvailable()) {
    onProgress?.(0.4);
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    onProgress?.(1);
    return toHex(digest);
  }

  return sha256Chunked(
    {
      size: file.size,
      read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
    },
    {
      chunkSize: CHUNK,
      signal,
      onProgress: (fraction) => {
        onProgress?.(fraction);
      },
    }
  );
}

export async function sha256Text(value: string): Promise<string> {
  if (isCryptoAvailable()) {
    return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  }
  return pureSha256Hex(value);
}

/** Shortens a digest for display without hiding the ends that matter. */
export function shortHash(hash: string | null | undefined, lead = 10, tail = 6): string {
  if (!hash) return "—";
  if (hash.length <= lead + tail + 3) return hash;
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

export function isHash32(value: string): boolean {
  return /^0x[0-9a-f]{64}$/.test(value);
}
