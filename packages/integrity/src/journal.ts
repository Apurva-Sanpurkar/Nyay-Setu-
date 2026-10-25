import { Sha256, toHex32 } from "./sha256";

/**
 * A recording journal: every piece of a recording is written to durable storage
 * the moment the recorder hands it over, so a dropped call, a crashed tab or a
 * phone that ran out of battery leaves a recording that can be recovered rather
 * than lost (2.0 · F12).
 *
 * Storage is behind a tiny interface so the same logic runs on IndexedDB in the
 * browser, the file system on the phone, and a Map in the tests.
 */

export interface JournalStore {
  get(key: string): Promise<Uint8Array | string | null>;
  put(key: string, value: Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export interface JournalMeta {
  id: string;
  caseId: string;
  mimeType: string;
  startedAtMs: number;
  /** Set when the recorder stopped cleanly. Absent: the recording was interrupted. */
  stoppedAtMs?: number;
  chunks: number;
  bytes: number;
  /** Anything the capture flow needs back on recovery: GPS at start, purpose. */
  extra?: Record<string, unknown>;
}

const META = (id: string) => `rec:${id}:meta`;
const CHUNK = (id: string, index: number) => `rec:${id}:chunk:${String(index).padStart(6, "0")}`;

function decodeMeta(raw: Uint8Array | string | null): JournalMeta | null {
  if (raw === null) return null;
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  return JSON.parse(text) as JournalMeta;
}

export class RecordingJournal {
  constructor(private readonly store: JournalStore) {}

  async begin(meta: Omit<JournalMeta, "chunks" | "bytes">): Promise<JournalMeta> {
    const full: JournalMeta = { ...meta, chunks: 0, bytes: 0 };
    await this.store.put(META(meta.id), JSON.stringify(full));
    return full;
  }

  /** Appends the next piece. Written before the counter moves, so a crash between the two loses nothing. */
  async append(id: string, bytes: Uint8Array): Promise<JournalMeta> {
    const meta = decodeMeta(await this.store.get(META(id)));
    if (!meta) throw new Error(`No recording ${id} in the journal.`);
    if (meta.stoppedAtMs) throw new Error(`Recording ${id} is already stopped.`);
    await this.store.put(CHUNK(id, meta.chunks), bytes);
    const next = { ...meta, chunks: meta.chunks + 1, bytes: meta.bytes + bytes.length };
    await this.store.put(META(id), JSON.stringify(next));
    return next;
  }

  /** Adds metadata (the GPS fix at the start, say) without ending the recording. */
  async annotate(id: string, extra: Record<string, unknown>): Promise<JournalMeta> {
    const meta = decodeMeta(await this.store.get(META(id)));
    if (!meta) throw new Error(`No recording ${id} in the journal.`);
    const next = { ...meta, extra: { ...(meta.extra ?? {}), ...extra } };
    await this.store.put(META(id), JSON.stringify(next));
    return next;
  }

  async stop(id: string, extra?: Record<string, unknown>): Promise<JournalMeta> {
    const meta = decodeMeta(await this.store.get(META(id)));
    if (!meta) throw new Error(`No recording ${id} in the journal.`);
    const next = { ...meta, stoppedAtMs: Date.now(), extra: { ...(meta.extra ?? {}), ...(extra ?? {}) } };
    await this.store.put(META(id), JSON.stringify(next));
    return next;
  }

  /** Every recording still in the journal, interrupted or not, oldest first. */
  async list(): Promise<JournalMeta[]> {
    const keys = (await this.store.keys("rec:")).filter((k) => k.endsWith(":meta"));
    const metas = await Promise.all(keys.map(async (k) => decodeMeta(await this.store.get(k))));
    return metas.filter((m): m is JournalMeta => m !== null).sort((a, b) => a.startedAtMs - b.startedAtMs);
  }

  /** Recordings that never stopped cleanly: what a crash leaves behind. */
  async interrupted(): Promise<JournalMeta[]> {
    return (await this.list()).filter((m) => !m.stoppedAtMs);
  }

  /** The pieces in order, one at a time, so recovering a long recording never holds it all twice. */
  async *pieces(id: string): AsyncGenerator<Uint8Array> {
    const meta = decodeMeta(await this.store.get(META(id)));
    if (!meta) throw new Error(`No recording ${id} in the journal.`);
    for (let i = 0; i < meta.chunks; i++) {
      const piece = await this.store.get(CHUNK(id, i));
      if (piece === null || typeof piece === "string") throw new Error(`Piece ${i} of recording ${id} is missing from the journal.`);
      yield piece;
    }
  }

  /** SHA-256 of the recording as journalled, computed piece by piece. */
  async digest(id: string): Promise<string> {
    const hasher = new Sha256();
    for await (const piece of this.pieces(id)) hasher.update(piece);
    return toHex32(hasher.digest());
  }

  async discard(id: string): Promise<void> {
    for (const key of await this.store.keys(`rec:${id}:`)) await this.store.delete(key);
  }
}

/** A Map-backed store, for tests and for environments with nothing better. */
export class MemoryJournalStore implements JournalStore {
  readonly data = new Map<string, Uint8Array | string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async put(key: string, value: Uint8Array | string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async keys(prefix: string) {
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
