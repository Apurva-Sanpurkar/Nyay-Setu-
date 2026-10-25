import * as FileSystem from "expo-file-system";
import * as Crypto from "expo-crypto";
import { api, ApiError } from "./api";
import { EvidenceQueue, type QueueItem, type QueueStore, type SendOutcome } from "./queueCore";

/**
 * The offline queue on the phone: items are kept as JSON in the app's private
 * document directory, and each captured file is copied there too, so neither is
 * lost if the system clears the camera cache or the app is killed mid-send.
 */

const DIR = `${FileSystem.documentDirectory}evidence-queue/`;
const INDEX = `${DIR}queue.json`;

async function ensureDir() {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
}

const fileStore: QueueStore = {
  async load() {
    await ensureDir();
    const info = await FileSystem.getInfoAsync(INDEX);
    if (!info.exists) return [];
    try {
      return JSON.parse(await FileSystem.readAsStringAsync(INDEX)) as QueueItem[];
    } catch {
      // A corrupt index is kept aside rather than overwritten, so nothing is lost.
      await FileSystem.moveAsync({ from: INDEX, to: `${DIR}queue.corrupt-${Date.now()}.json` });
      return [];
    }
  },
  async save(items) {
    await ensureDir();
    // Write then move: a crash mid-write leaves the previous index intact.
    const temp = `${INDEX}.tmp`;
    await FileSystem.writeAsStringAsync(temp, JSON.stringify(items));
    await FileSystem.moveAsync({ from: temp, to: INDEX });
  },
};

/** Copies a captured file into the queue directory and returns its new URI. */
export async function keepFile(uri: string, name: string): Promise<string> {
  await ensureDir();
  const target = `${DIR}${Crypto.randomUUID()}-${name.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  await FileSystem.copyAsync({ from: uri, to: target });
  return target;
}

const send = async (item: QueueItem): Promise<SendOutcome> => {
  const info = await FileSystem.getInfoAsync(item.file.uri);
  if (!info.exists) return { kind: "http", status: 410, message: "The file for this item is no longer on the phone." };

  const form = new FormData();
  form.append("file", { uri: item.file.uri, name: item.file.name, type: item.file.mimeType } as unknown as Blob);
  form.append("caseId", item.caseId);
  form.append("clientHash", item.file.sha256);
  form.append("kind", item.kind);
  form.append("source", "capture");
  form.append("collectedAt", item.collectedAtIso);
  form.append("manifest", item.manifestJson);
  form.append("deviceClockAtSendMs", String(Date.now()));
  if (item.notes) form.append("notes", item.notes);

  try {
    const result = await api.upload<{ evidence: { id: string; public_ref?: string | null }; verification?: { state?: string } }>(
      "/api/evidence",
      form,
      { "idempotency-key": item.idempotencyKey }
    );
    return {
      kind: "accepted",
      evidenceId: result.evidence.id,
      publicRef: result.evidence.public_ref ?? null,
      verificationState: result.verification?.state ?? null,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return error.status === 0 ? { kind: "network", message: error.message } : { kind: "http", status: error.status, message: error.message };
    }
    return { kind: "network", message: error instanceof Error ? error.message : String(error) };
  }
};

export const evidenceQueue = new EvidenceQueue(fileStore, send);

/** Deletes the private copy of a file once its item has left the queue. */
export async function forgetFile(item: QueueItem | null) {
  if (item?.file.uri.startsWith(DIR)) await FileSystem.deleteAsync(item.file.uri, { idempotent: true });
}
