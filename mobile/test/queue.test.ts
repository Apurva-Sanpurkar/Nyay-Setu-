import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BACKOFF,
  EvidenceQueue,
  MemoryQueueStore,
  applyOutcome,
  backoffMs,
  isRetryable,
  newItem,
  recoverInterrupted,
  type QueueItem,
  type SendOutcome,
} from "../src/lib/queueCore";

const HASH = "0x" + "ab".repeat(32);

function item(n: number, now = 1_000): QueueItem {
  return newItem(
    {
      id: `item-${n}`,
      idempotencyKey: `key-${n}`,
      caseId: "case-1",
      caseReference: "NS/PS/2026/000001",
      kind: "photo",
      file: { uri: `file:///queue/${n}.jpg`, name: `${n}.jpg`, mimeType: "image/jpeg", sizeBytes: 1000, sha256: HASH },
      manifestJson: "{}",
      collectedAtIso: new Date(now).toISOString(),
      notes: null,
    },
    now + n
  );
}

const accepted = (id = "ev-1"): SendOutcome => ({ kind: "accepted", evidenceId: id, publicRef: "NSE-X", verificationState: "SUBMITTED" });

test("backoff doubles from 5 s, is capped at 15 minutes, and jitters by at most 20 %", () => {
  assert.equal(backoffMs(1, () => 0), 5_000);
  assert.equal(backoffMs(2, () => 0), 10_000);
  assert.equal(backoffMs(3, () => 0), 20_000);
  assert.equal(backoffMs(30, () => 0), BACKOFF.maxMs);
  assert.equal(backoffMs(1, () => 1), 6_000);
});

test("only failures that can succeed later are retryable", () => {
  assert.equal(isRetryable({ kind: "network", message: "offline" }), true);
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryable({ kind: "http", status, message: "" }), true, String(status));
  for (const status of [400, 401, 403, 404, 409, 413, 422]) assert.equal(isRetryable({ kind: "http", status, message: "" }), false, String(status));
});

test("a refusal goes to NEEDS_ATTENTION at once and keeps the server's reason", () => {
  const next = applyOutcome(item(1), { kind: "http", status: 422, message: "The digest did not match." }, 10_000);
  assert.equal(next.state, "NEEDS_ATTENTION");
  assert.equal(next.lastError, "The digest did not match.");
});

test("a retryable failure is rescheduled, and gives up to a person after the attempt limit", () => {
  let current = item(1);
  for (let i = 1; i < BACKOFF.maxAttempts; i++) {
    current = applyOutcome(current, { kind: "http", status: 503, message: "busy" }, 0, () => 0);
    assert.equal(current.state, "QUEUED");
    assert.equal(current.nextAttemptAtMs, backoffMs(i, () => 0));
  }
  current = applyOutcome(current, { kind: "http", status: 503, message: "busy" }, 0, () => 0);
  assert.equal(current.state, "NEEDS_ATTENTION");
  assert.match(current.lastError!, /Still failing after/);
});

test("an item interrupted mid-send is queued again, not lost", () => {
  const items = recoverInterrupted([{ ...item(1), state: "SENDING" }, { ...item(2), state: "SENT" }], 50);
  assert.equal(items[0].state, "QUEUED");
  assert.equal(items[1].state, "SENT");
});

test("flush sends due items oldest first, and stops at the first network failure", async () => {
  const store = new MemoryQueueStore();
  const sent: string[] = [];
  let online = true;
  const queue = new EvidenceQueue(
    store,
    async (i) => {
      sent.push(i.id);
      return online ? accepted(`ev-${i.id}`) : { kind: "network", message: "no signal" };
    },
    () => 10_000,
    () => 0
  );
  await queue.add(item(2));
  await queue.add(item(1));
  await queue.add(item(3));

  online = false;
  let after = await queue.flush();
  assert.deepEqual(sent, ["item-1"], "the first network failure ends the run");
  assert.equal(after.find((i) => i.id === "item-1")!.state, "QUEUED");

  online = true;
  sent.length = 0;
  // Not due yet: backoff applies to the item that failed, but the others are due.
  after = await queue.flush();
  assert.deepEqual(sent, ["item-2", "item-3"]);
  assert.equal(after.filter((i) => i.state === "SENT").length, 2);
});

test("the same capture added twice is queued once, and concurrent flushes send it once", async () => {
  const store = new MemoryQueueStore();
  let sends = 0;
  const queue = new EvidenceQueue(store, async () => {
    sends++;
    await new Promise((r) => setTimeout(r, 10));
    return accepted();
  });
  const one = item(1);
  await queue.add(one);
  await queue.add({ ...one, id: "a-different-id" });
  assert.equal((await queue.list()).length, 1);

  await Promise.all([queue.flush(), queue.flush(), queue.flush()]);
  assert.equal(sends, 1);
});

test("a sender that throws is treated as a network failure, never as success", async () => {
  const store = new MemoryQueueStore();
  const queue = new EvidenceQueue(store, async () => {
    throw new Error("socket hang up");
  }, () => 10_000, () => 0);
  await queue.add(item(1));
  const [after] = await queue.flush();
  assert.equal(after.state, "QUEUED");
  assert.equal(after.lastError, "socket hang up");
});

test("nothing leaves the queue except by acceptance or an explicit discard", async () => {
  const store = new MemoryQueueStore();
  const queue = new EvidenceQueue(store, async () => ({ kind: "http", status: 403, message: "No write access." }));
  await queue.add(item(1));
  await queue.flush();
  await queue.clearSent();
  assert.equal((await queue.list()).length, 1, "a refused item is kept");
  assert.equal((await queue.list())[0].state, "NEEDS_ATTENTION");

  await queue.retry("item-1");
  assert.equal((await queue.list())[0].state, "QUEUED");

  const removed = await queue.discard("item-1");
  assert.equal(removed?.id, "item-1");
  assert.equal((await queue.list()).length, 0);
});
