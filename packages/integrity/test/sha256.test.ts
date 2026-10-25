import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Sha256, sha256Hex, sha256Chunked, hmacSha256, toHex32, utf8, digestsEqual } from "../src";

const node = (data: Uint8Array | string) => "0x" + createHash("sha256").update(data).digest("hex");

test("FIPS 180-4 vectors", () => {
  assert.equal(sha256Hex(""), "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "0x248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
  );
  assert.equal(
    sha256Hex("a".repeat(1_000_000)),
    "0xcdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
  );
});

test("agrees with node:crypto for every length across two block boundaries", () => {
  for (let length = 0; length <= 200; length++) {
    const data = randomBytes(length);
    assert.equal(sha256Hex(data), node(data), `length ${length}`);
  }
});

test("incremental updates at random split points give the one-shot digest", () => {
  for (let round = 0; round < 50; round++) {
    const data = randomBytes(1 + Math.floor(Math.random() * 5000));
    const hasher = new Sha256();
    let offset = 0;
    while (offset < data.length) {
      const step = 1 + Math.floor(Math.random() * 300);
      hasher.update(data.subarray(offset, offset + step));
      offset += step;
    }
    assert.equal(toHex32(hasher.digest()), node(data));
  }
});

test("UTF-8 encoding matches Buffer for Devanagari, emoji and lone surrogates", () => {
  for (const value of ["न्यायसेतु", "मराठी", "👩🏽‍⚖️ court", "plain", "é́"]) {
    assert.deepEqual(Buffer.from(utf8(value)), Buffer.from(value, "utf8"), value);
    assert.equal(sha256Hex(value), node(value));
  }
  // A lone surrogate becomes U+FFFD, as TextEncoder does.
  assert.deepEqual(Buffer.from(utf8("a\ud800b")), Buffer.from("a�b", "utf8"));
});

test("chunked hashing streams a large source without holding it", async () => {
  // 48 MB generated on demand from a seed; never materialised as one buffer.
  const size = 48 * 1024 * 1024 + 123;
  const seedBlock = randomBytes(65_536);
  const reference = createHash("sha256");
  for (let offset = 0; offset < size; offset += seedBlock.length) {
    reference.update(seedBlock.subarray(0, Math.min(seedBlock.length, size - offset)));
  }

  let largestRead = 0;
  let reads = 0;
  const chunkSize = 1024 * 1024;
  const digest = await sha256Chunked(
    {
      size,
      async read(offset, length) {
        reads++;
        largestRead = Math.max(largestRead, length);
        const out = new Uint8Array(length);
        for (let i = 0; i < length; ) {
          const at = (offset + i) % seedBlock.length;
          const take = Math.min(seedBlock.length - at, length - i);
          out.set(seedBlock.subarray(at, at + take), i);
          i += take;
        }
        return out;
      },
    },
    { chunkSize }
  );

  assert.equal(digest, "0x" + reference.digest("hex"));
  assert.ok(largestRead <= chunkSize, "never asked for more than one chunk");
  assert.equal(reads, Math.ceil(size / chunkSize));
});

test("chunked hashing refuses a short read instead of hashing the wrong bytes", async () => {
  await assert.rejects(
    sha256Chunked({ size: 10, read: async () => new Uint8Array(3) }, { chunkSize: 10 }),
    /Short read/
  );
});

test("HMAC-SHA-256 agrees with node:crypto, including keys longer than a block", () => {
  for (const keyLength of [0, 1, 32, 64, 65, 200]) {
    const key = randomBytes(keyLength);
    const message = randomBytes(300);
    const expected = createHmac("sha256", key).update(message).digest("hex");
    assert.equal(toHex32(hmacSha256(key, message)), "0x" + expected, `key ${keyLength}`);
  }
});

test("digest comparison is case-insensitive and refuses non-strings", () => {
  assert.ok(digestsEqual("0xABCDEF", "0xabcdef"));
  assert.ok(!digestsEqual("0xabc", "0xabd"));
  assert.ok(!digestsEqual(null, "0xabc"));
});
