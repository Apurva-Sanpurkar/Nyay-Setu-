import { canonicalJson, type CaptureManifest } from "@nyaysetu/integrity";
import { api } from "./api";
import { idb } from "./idb";

/**
 * This browser's capture-manifest signing key (2.0 · F10).
 *
 * An ECDSA P-256 key pair generated with `extractable: false`: the private key
 * can sign, but no script — ours included — can ever read it out. It is kept in
 * IndexedDB and its public half is registered with the API once. A valid
 * signature shows that a manifest came from a registered install of this app on
 * this browser profile. It is not hardware attestation, and nothing claims it is.
 */

interface StoredKey {
  keyId: string;
  privateKey: CryptoKey;
  registeredFor: string | null;
}

const STORAGE_KEY = "device-signing-key";

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "web-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  new Uint8Array(bytes).forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function signingAvailable(): boolean {
  return typeof crypto !== "undefined" && Boolean(crypto.subtle) && typeof indexedDB !== "undefined" && window.isSecureContext;
}

/** The key for this user on this browser, created and registered on first use. */
async function ensureKey(userId: string): Promise<StoredKey | null> {
  if (!signingAvailable()) return null;
  let stored = await idb.get<StoredKey>(STORAGE_KEY).catch(() => undefined);

  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    stored = { keyId: randomId(), privateKey: pair.privateKey, registeredFor: null };
    // The public key is always exportable, even from a non-extractable pair.
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    await idb.put(`${STORAGE_KEY}:public`, jwk);
    await idb.put(STORAGE_KEY, stored);
  }

  if (stored.registeredFor !== userId) {
    const jwk = await idb.get<JsonWebKey>(`${STORAGE_KEY}:public`);
    if (!jwk) return null;
    await api.post("/api/devices/keys", {
      algorithm: "ECDSA-P256-SHA256",
      keyId: stored.keyId,
      platform: "web",
      label: navigator.userAgent.slice(0, 70),
      publicJwk: jwk,
    });
    stored = { ...stored, registeredFor: userId };
    await idb.put(STORAGE_KEY, stored);
  }
  return stored;
}

export interface ManifestSignature {
  alg: "ECDSA-P256-SHA256";
  keyId: string;
  value: string;
}

/** Signs the canonical manifest bytes. Returns null when this browser cannot hold a key. */
export async function signManifest(manifest: CaptureManifest, userId: string): Promise<ManifestSignature | null> {
  try {
    const key = await ensureKey(userId);
    if (!key) return null;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(canonicalJson(manifest))
    );
    return { alg: "ECDSA-P256-SHA256", keyId: key.keyId, value: base64url(signature) };
  } catch {
    // A signature is an extra assurance, not a gate: the item is still anchored
    // by its digest, and the record says it was unsigned.
    return null;
  }
}

/** A stable identifier for this browser install, written into every manifest. */
export function deviceId(): string {
  const KEY = "nyaysetu.device";
  try {
    let id = localStorage.getItem(KEY);
    if (!id) {
      id = "web-" + crypto.randomUUID();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return "web-ephemeral";
  }
}

export function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}
