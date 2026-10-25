/**
 * The offline evidence queue, without any React Native in it.
 *
 * A capture is saved on the phone first and sent when the network allows. That
 * is what makes the field app usable in a basement or a village with no signal,
 * and it is only safe because of three rules enforced here:
 *
 *   1. Every item carries an idempotency key, chosen once when it is captured.
 *      The API returns the original record when it sees the same key again, so a
 *      send that reached the server but whose reply was lost cannot register the
 *      item twice.
 *   2. Only failures that can succeed later are retried (no network, timeouts,
 *      rate limits, server errors), with exponential backoff. A refusal (the
 *      digest did not match, no access to the case, an invalid manifest) is
 *      never retried blindly: it becomes NEEDS_ATTENTION for a person.
 *   3. Nothing is ever dropped silently. An item leaves the queue only when the
 *      server has accepted it, or when the officer explicitly discards it.
 *
 * Storage and sending are injected, so this file runs under Node in tests.
 */

export type QueueState = "QUEUED" | "SENDING" | "SENT" | "NEEDS_ATTENTION";

export interface QueuedFile {
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface QueueItem {
  id: string;
  idempotencyKey: string;
  createdAtMs: number;
  caseId: string;
  caseReference: string;
  kind: "photo" | "video";
  file: QueuedFile;
  /** The capture manifest, serialised exactly as it will be sent. */
  manifestJson: string;
  collectedAtIso: string;
  notes: string | null;
  state: QueueState;
  attempts: number;
  nextAttemptAtMs: number;
  lastError: string | null;
  /** Filled in once the server accepts it. */
  result: { evidenceId: string; publicRef: string | null; verificationState: string | null } | null;
}

export interface QueueStore {
  load(): Promise<QueueItem[]>;
  save(items: QueueItem[]): Promise<void>;
}

export type SendOutcome =
  | { kind: "accepted"; evidenceId: string; publicRef: string | null; verificationState: string | null }
  | { kind: "http"; status: number; message: string }
  | { kind: "network"; message: string };

export type Sender = (item: QueueItem) => Promise<SendOutcome>;

export const BACKOFF = {
  baseMs: 5_000,
  maxMs: 15 * 60_000,
  /** After this many failed attempts an item stops retrying on its own. */
  maxAttempts: 12,
};

/**
 * Delay before attempt `attempts + 1`: 5 s, 10 s, 20 s … capped at 15 minutes,
 * with up to 20 % random jitter so a crowd of phones regaining signal together
 * does not retry in lockstep. `random` is injectable for tests.
 */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF.maxMs, BACKOFF.baseMs * 2 ** Math.max(0, attempts - 1));
  return Math.round(exp * (1 + 0.2 * random()));
}

/** Whether a failed send may succeed if simply tried again later. */
export function isRetryable(outcome: Exclude<SendOutcome, { kind: "accepted" }>): boolean {
  if (outcome.kind === "network") return true;
  return outcome.status === 408 || outcome.status === 429 || outcome.status >= 500;
}

export function newItem(
  input: Omit<QueueItem, "state" | "attempts" | "nextAttemptAtMs" | "lastError" | "result" | "createdAtMs">,
  nowMs: number
): QueueItem {
  return { ...input, createdAtMs: nowMs, state: "QUEUED", attempts: 0, nextAttemptAtMs: nowMs, lastError: null, result: null };
}

/** Items due to be sent now, oldest first. */
export function dueItems(items: QueueItem[], nowMs: number): QueueItem[] {
  return items
    .filter((i) => i.state === "QUEUED" && i.nextAttemptAtMs <= nowMs)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}

/** The item after one send, given what happened. Pure. */
export function applyOutcome(item: QueueItem, outcome: SendOutcome, nowMs: number, random: () => number = Math.random): QueueItem {
  if (outcome.kind === "accepted") {
    return {
      ...item,
      state: "SENT",
      lastError: null,
      result: { evidenceId: outcome.evidenceId, publicRef: outcome.publicRef, verificationState: outcome.verificationState },
    };
  }
  const attempts = item.attempts + 1;
  if (!isRetryable(outcome)) {
    return { ...item, attempts, state: "NEEDS_ATTENTION", lastError: outcome.message };
  }
  if (attempts >= BACKOFF.maxAttempts) {
    return { ...item, attempts, state: "NEEDS_ATTENTION", lastError: `Still failing after ${attempts} attempts: ${outcome.message}` };
  }
  return { ...item, attempts, state: "QUEUED", nextAttemptAtMs: nowMs + backoffMs(attempts, random), lastError: outcome.message };
}

/**
 * Items left in SENDING were interrupted (the app was killed mid-send). They go
 * back to QUEUED; the idempotency key makes the resend safe.
 */
export function recoverInterrupted(items: QueueItem[], nowMs: number): QueueItem[] {
  return items.map((i) => (i.state === "SENDING" ? { ...i, state: "QUEUED", nextAttemptAtMs: nowMs } : i));
}

export class EvidenceQueue {
  private flushing: Promise<QueueItem[]> | null = null;

  constructor(
    private readonly store: QueueStore,
    private readonly send: Sender,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {}

  async list(): Promise<QueueItem[]> {
    return this.store.load();
  }

  async add(item: QueueItem): Promise<void> {
    const items = await this.store.load();
    if (items.some((i) => i.idempotencyKey === item.idempotencyKey)) return;
    await this.store.save([...items, item]);
  }

  /** Puts a NEEDS_ATTENTION item back in the queue, after the officer has looked at it. */
  async retry(id: string): Promise<void> {
    const items = await this.store.load();
    await this.store.save(items.map((i) => (i.id === id && i.state === "NEEDS_ATTENTION" ? { ...i, state: "QUEUED", attempts: 0, nextAttemptAtMs: this.now() } : i)));
  }

  /** Removes an item. Only ever called on an explicit decision by the officer. */
  async discard(id: string): Promise<QueueItem | null> {
    const items = await this.store.load();
    const found = items.find((i) => i.id === id) ?? null;
    await this.store.save(items.filter((i) => i.id !== id));
    return found;
  }

  /** Clears items the server has accepted. */
  async clearSent(): Promise<void> {
    const items = await this.store.load();
    await this.store.save(items.filter((i) => i.state !== "SENT"));
  }

  /**
   * Sends every due item, one at a time, oldest first. Concurrent calls share
   * one run, so a timer and a "send now" tap cannot send the same item twice.
   */
  flush(): Promise<QueueItem[]> {
    if (!this.flushing) {
      this.flushing = this.run().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  private async run(): Promise<QueueItem[]> {
    let items = recoverInterrupted(await this.store.load(), this.now());
    for (const due of dueItems(items, this.now())) {
      items = items.map((i) => (i.id === due.id ? { ...i, state: "SENDING" } : i));
      await this.store.save(items);

      let outcome: SendOutcome;
      try {
        outcome = await this.send(due);
      } catch (error) {
        outcome = { kind: "network", message: error instanceof Error ? error.message : String(error) };
      }
      const updated = applyOutcome(due, outcome, this.now(), this.random);
      items = items.map((i) => (i.id === due.id ? updated : i));
      await this.store.save(items);
      // No signal: stop here rather than burn through every item's attempts.
      if (outcome.kind === "network") break;
    }
    return items;
  }
}

/** A plain in-memory store, for tests. */
export class MemoryQueueStore implements QueueStore {
  items: QueueItem[] = [];
  async load() {
    return this.items.map((i) => ({ ...i }));
  }
  async save(items: QueueItem[]) {
    this.items = items.map((i) => ({ ...i }));
  }
}
