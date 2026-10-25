import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { MemoryJournalStore, RecordingJournal } from "../src";

test("a recording interrupted mid-way is recovered piece for piece, with the right digest", async () => {
  const store = new MemoryJournalStore();
  const recorder = new RecordingJournal(store);
  await recorder.begin({ id: "r1", caseId: "c1", mimeType: "video/webm", startedAtMs: 1, extra: { gpsStart: { lat: 18.5 } } });

  const pieces = Array.from({ length: 7 }, () => randomBytes(1000 + Math.floor(Math.random() * 5000)));
  await recorder.append("r1", pieces[0]);
  // The GPS fix arrives after recording has started; noting it must not end the recording.
  await recorder.annotate("r1", { fixAt: 42 });
  for (const piece of pieces.slice(1, 5)) await recorder.append("r1", piece);
  // The tab crashes here. A new journal over the same storage is what the reloaded page sees.
  const reloaded = new RecordingJournal(store);
  const interrupted = await reloaded.interrupted();
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].chunks, 5);
  assert.deepEqual(interrupted[0].extra, { gpsStart: { lat: 18.5 }, fixAt: 42 });

  const expected = "0x" + createHash("sha256").update(Buffer.concat(pieces.slice(0, 5))).digest("hex");
  assert.equal(await reloaded.digest("r1"), expected);

  // The recovered recording can be stopped and kept, or discarded.
  await reloaded.stop("r1");
  assert.equal((await reloaded.interrupted()).length, 0);
  await reloaded.discard("r1");
  assert.equal(store.data.size, 0);
});

test("a stopped recording takes no more pieces, and a missing piece is reported, not skipped", async () => {
  const store = new MemoryJournalStore();
  const journal = new RecordingJournal(store);
  await journal.begin({ id: "r2", caseId: "c1", mimeType: "video/webm", startedAtMs: 2 });
  await journal.append("r2", new Uint8Array([1, 2, 3]));
  await journal.append("r2", new Uint8Array([4, 5]));
  await journal.stop("r2");
  await assert.rejects(journal.append("r2", new Uint8Array([6])), /already stopped/);

  store.data.delete("rec:r2:chunk:000001");
  await assert.rejects(journal.digest("r2"), /Piece 1 of recording r2 is missing/);
});
