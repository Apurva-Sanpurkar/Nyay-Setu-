import { api, apiOrigin, csrfHeaderValue, ApiError } from "./api";

/**
 * Fetches a document the API renders (PDF, ZIP) with the session cookie, then
 * either opens it (PDF) or saves it (anything else). Returns the SHA-256 the API
 * reported for it, so the screen can show what was produced.
 */
export async function fetchDocument(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown; fileName: string; open?: boolean }
): Promise<{ sha256: string | null }> {
  let response: Response;
  if (options.method === "POST") {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const csrf = csrfHeaderValue();
    if (csrf) headers["x-csrf-token"] = csrf;
    response = await fetch(`${apiOrigin}${path}`, { method: "POST", credentials: "include", headers, body: JSON.stringify(options.body ?? {}) });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new ApiError(response.status, payload?.error?.code ?? "UNKNOWN", payload?.error?.message ?? "Request failed.", payload?.error?.details);
    }
  } else {
    response = await api.download(path);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  if (options.open && blob.type === "application/pdf") {
    window.open(url, "_blank", "noopener");
  } else {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = options.fileName;
    anchor.click();
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { sha256: response.headers.get("x-nyaysetu-sha256") };
}
