import { sha256Hex } from "@nyaysetu/integrity";
import { ApiError, api, apiOrigin, csrfHeaderValue } from "./api";

/**
 * Sends a large recording in pieces (2.0 · F12), resuming from whatever the
 * server already has, with a per-piece digest so damage in transit is caught at
 * once. A dropped connection costs one piece, not the recording.
 */

export const PIECE_SIZE = 2 * 1024 * 1024;

interface Status {
  uploadId: string;
  received: number[];
  totalChunks: number;
  complete: boolean;
}

async function putPiece(uploadId: string, index: number, bytes: Uint8Array, csrf: string | null): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "x-chunk-sha256": sha256Hex(bytes),
  };
  if (csrf) headers["x-csrf-token"] = csrf;
  const response = await fetch(`${apiOrigin}/api/uploads/${uploadId}/chunks/${index}`, {
    method: "PUT",
    credentials: "include",
    headers,
    body: new Blob([bytes as BlobPart]),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body?.error?.code ?? "UPLOAD_FAILED", body?.error?.message ?? `Piece ${index} failed.`);
  }
}

export async function uploadInPieces(args: {
  blob: Blob;
  caseId: string;
  fileName: string;
  sha256: string;
  existingUploadId?: string | null;
  onProgress?: (done: number, total: number) => void;
  onResume?: (fromPiece: number) => void;
}): Promise<string> {
  const { blob } = args;
  let status: Status;
  if (args.existingUploadId) {
    status = await api.get<Status>(`/api/uploads/${args.existingUploadId}`);
  } else {
    status = await api.post<Status>("/api/uploads", {
      caseId: args.caseId,
      fileName: args.fileName,
      mimeType: blob.type || "video/webm",
      totalBytes: blob.size,
      chunkSize: PIECE_SIZE,
      sha256: args.sha256,
    });
  }

  const csrf = csrfHeaderValue();
  const have = new Set(status.received);
  let done = have.size;
  args.onProgress?.(done, status.totalChunks);

  for (let index = 0; index < status.totalChunks; index++) {
    if (have.has(index)) continue;
    const bytes = new Uint8Array(await blob.slice(index * PIECE_SIZE, (index + 1) * PIECE_SIZE).arrayBuffer());

    // Back off and retry a piece a few times before giving up; a field
    // connection drops for seconds at a time, not for ever.
    for (let attempt = 0; ; attempt++) {
      try {
        await putPiece(status.uploadId, index, bytes, csrf);
        if (attempt > 0) args.onResume?.(index);
        break;
      } catch (error) {
        const retriable = !(error instanceof ApiError) || error.status >= 500 || error.status === 0 || error.status === 429;
        if (!retriable || attempt >= 5) throw error;
        await new Promise((r) => setTimeout(r, Math.min(15_000, 800 * 2 ** attempt)));
      }
    }
    done++;
    args.onProgress?.(done, status.totalChunks);
  }

  return status.uploadId;
}
