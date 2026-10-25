import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system";

/**
 * SHA-256 of a file, computed on the device.
 *
 * THE DETAIL THAT MATTERS
 * -----------------------
 * The digest must be taken over the RAW BYTES of the file, because that is what
 * the web client and the server both hash. The obvious approach --
 * `Crypto.digestStringAsync(SHA256, base64)` -- hashes the base64 TEXT instead,
 * which produces a completely different value. An officer capturing on a phone
 * would then get a digest the server refuses, and the failure would look like a
 * tamper detection rather than an encoding mistake.
 *
 * So the base64 is decoded to bytes first and `Crypto.digest` is used, which
 * takes a BufferSource. The hex output is lower-case and 0x-prefixed, matching
 * the hash32 contract the API and the database both enforce.
 */

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes base64 to bytes without relying on a global atob, which RN lacks. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, "");
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const byteLength = Math.floor((clean.length * 3) / 4) - padding;
  const bytes = new Uint8Array(byteLength);

  let byteIndex = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const chunk =
      (BASE64_ALPHABET.indexOf(clean[i]) << 18) |
      (BASE64_ALPHABET.indexOf(clean[i + 1]) << 12) |
      ((clean[i + 2] ? BASE64_ALPHABET.indexOf(clean[i + 2]) : 0) << 6) |
      (clean[i + 3] ? BASE64_ALPHABET.indexOf(clean[i + 3]) : 0);

    if (byteIndex < byteLength) bytes[byteIndex++] = (chunk >> 16) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = (chunk >> 8) & 0xff;
    if (byteIndex < byteLength) bytes[byteIndex++] = chunk & 0xff;
  }
  return bytes;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return "0x" + out;
}

export interface HashedFile {
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  hash: string;
  /** The file's own modification time, which intake screening compares against
   *  the claimed collection time. */
  lastModified: string;
}

export async function hashFile(
  uri: string,
  name: string,
  mimeType: string
): Promise<HashedFile> {
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  if (!info.exists) throw new Error("That file is no longer on this device.");

  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const bytes = base64ToBytes(base64);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);

  return {
    uri,
    name,
    mimeType,
    sizeBytes: info.size ?? bytes.length,
    hash: toHex(digest),
    lastModified: new Date(
      "modificationTime" in info && info.modificationTime
        ? info.modificationTime * 1000
        : Date.now()
    ).toISOString(),
  };
}

export function shortHash(hash: string | null | undefined, lead = 12, tail = 8): string {
  if (!hash) return "—";
  if (hash.length <= lead + tail + 3) return hash;
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

/** Same approximation GeoMath.sol uses, so the distance shown matches the chain. */
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const metresPerDegree = 111_320;
  const dLat = (lat2 - lat1) * metresPerDegree;
  const dLng = (lng2 - lng1) * metresPerDegree * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

export function formatMetres(metres: number | null | undefined): string {
  if (metres === null || metres === undefined) return "—";
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(2)} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "overdue";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}
