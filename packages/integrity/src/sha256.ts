/**
 * SHA-256 in plain TypeScript, incremental.
 *
 * WHY NOT WEBCRYPTO OR NODE'S CRYPTO
 *   Both exist, and both are used where they are the better tool. But neither is
 *   available everywhere this digest is computed, and WebCrypto has no streaming
 *   interface at all: `crypto.subtle.digest` wants the whole buffer, which is why a
 *   40 minute search-and-seizure video could not be hashed in a browser without
 *   holding it in memory. This implementation takes the bytes a slice at a time, so
 *   memory stays at one slice however large the file.
 *
 *   It is also the reason the capture manifest digest is identical on a phone, in a
 *   browser and on the server: it is the same function, not three implementations
 *   that are supposed to agree.
 *
 * Correctness is checked against node:crypto and the FIPS 180-4 test vectors in
 * packages/integrity/test.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

export class Sha256 {
  private readonly state = new Uint32Array(INITIAL);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  /** Total bytes absorbed. A Number holds 2^53, which is 8 petabytes. */
  private total = 0;
  private finished = false;

  update(data: Uint8Array): this {
    if (this.finished) throw new Error("Sha256: update() after digest()");
    let offset = 0;
    this.total += data.length;

    // Top up a partial block first.
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, data.length);
      this.block.set(data.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset = take;
      if (this.blockLength === 64) {
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
    }

    // Whole blocks straight from the input, without copying.
    while (offset + 64 <= data.length) {
      this.compress(data, offset);
      offset += 64;
    }

    if (offset < data.length) {
      this.block.set(data.subarray(offset), 0);
      this.blockLength = data.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error("Sha256: digest() called twice");
    this.finished = true;

    const bitLengthHigh = Math.floor(this.total / 0x20000000);
    const bitLengthLow = (this.total << 3) >>> 0;

    this.block[this.blockLength++] = 0x80;
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength);
      this.compress(this.block, 0);
      this.blockLength = 0;
    }
    this.block.fill(0, this.blockLength, 56);
    this.block[56] = (bitLengthHigh >>> 24) & 0xff;
    this.block[57] = (bitLengthHigh >>> 16) & 0xff;
    this.block[58] = (bitLengthHigh >>> 8) & 0xff;
    this.block[59] = bitLengthHigh & 0xff;
    this.block[60] = (bitLengthLow >>> 24) & 0xff;
    this.block[61] = (bitLengthLow >>> 16) & 0xff;
    this.block[62] = (bitLengthLow >>> 8) & 0xff;
    this.block[63] = bitLengthLow & 0xff;
    this.compress(this.block, 0);

    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      out[i * 4] = (this.state[i] >>> 24) & 0xff;
      out[i * 4 + 1] = (this.state[i] >>> 16) & 0xff;
      out[i * 4 + 2] = (this.state[i] >>> 8) & 0xff;
      out[i * 4 + 3] = this.state[i] & 0xff;
    }
    return out;
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15];
      const w2 = w[i - 2];
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

/** 0x-prefixed lower-case hex: the `hash32` shape the API, database and chain all use. */
export function toHex32(bytes: Uint8Array): string {
  let out = "0x";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) throw new Error("Not a hex string.");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * UTF-8 encoding without relying on TextEncoder, which older Hermes builds lack.
 * Lone surrogates become U+FFFD, matching what TextEncoder does.
 */
export function utf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xd800 && code <= 0xdfff) {
      code = 0xfffd;
    }

    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
  }
  return Uint8Array.from(bytes);
}

/** One-shot digest of bytes or of a string's UTF-8 encoding. */
export function sha256Hex(data: Uint8Array | string): string {
  return toHex32(new Sha256().update(typeof data === "string" ? utf8(data) : data).digest());
}

/**
 * Something that can be read a slice at a time: a browser Blob/File, or anything
 * else that offers size and an async slice reader.
 */
export interface ChunkSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/**
 * Hashes a source in fixed-size slices. Memory use is one slice, whatever the
 * size of the source — which is the whole point for long recordings.
 */
export async function sha256Chunked(
  source: ChunkSource,
  options: { chunkSize?: number; onProgress?: (fraction: number) => void; signal?: { aborted: boolean } } = {}
): Promise<string> {
  const chunkSize = options.chunkSize ?? 4 * 1024 * 1024;
  const hasher = new Sha256();
  let offset = 0;

  if (source.size === 0) {
    options.onProgress?.(1);
    return toHex32(hasher.digest());
  }

  while (offset < source.size) {
    if (options.signal?.aborted) throw new Error("Hashing was cancelled.");
    const length = Math.min(chunkSize, source.size - offset);
    const slice = await source.read(offset, length);
    if (slice.length !== length) {
      throw new Error(`Short read at offset ${offset}: wanted ${length} bytes, got ${slice.length}.`);
    }
    hasher.update(slice);
    offset += length;
    options.onProgress?.(offset / source.size);
  }
  return toHex32(hasher.digest());
}

/** HMAC-SHA-256 (RFC 2104). Used for device-bound manifest signatures on the phone. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = new Sha256().update(k).digest();
  const padded = new Uint8Array(blockSize);
  padded.set(k);

  const inner = new Uint8Array(blockSize);
  const outer = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padded[i] ^ 0x36;
    outer[i] = padded[i] ^ 0x5c;
  }

  const innerDigest = new Sha256().update(inner).update(message).digest();
  return new Sha256().update(outer).update(innerDigest).digest();
}

/** Constant-time comparison of two hex digests, case-insensitive. */
export function digestsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}
