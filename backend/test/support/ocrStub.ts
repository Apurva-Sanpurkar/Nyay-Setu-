/**
 * A stand-in for ai-service's /ocr routes, for tests. Imported BEFORE the
 * harness so AI_SERVICE_URL is set when config/env.ts is first read.
 *
 * It builds its proof exactly as src/ocr.py does (canonical JSON over integers
 * and strings, SHA-256), so the API's proof check is exercised for real; `mode`
 * makes it misbehave in the ways the API must refuse.
 */
import { createServer, type Server } from "http";
import { createHash } from "crypto";

const port = 47_000 + (process.pid % 1500);
process.env.TEST_AI_SERVICE_URL = `http://127.0.0.1:${port}`;

const sha = (data: Buffer | string) => "0x" + createHash("sha256").update(data).digest("hex");

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

export type StubMode = "ok" | "tampered_text" | "other_bytes" | "down" | "plate";

export const stub = {
  mode: "ok" as StubMode,
  text: "SEIZURE MEMO 14/2026\nITEM 1 MOBILE PHONE SEALED",
  calls: [] as { path: string; expected: string | null; bytes: number }[],
};

let server: Server | null = null;

export function startOcrStub(): Promise<void> {
  if (server) return Promise.resolve();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const expected = (req.headers["x-expected-sha256"] as string | undefined) ?? null;
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      // Only OCR is stubbed. Evidence screening finds no model here and is skipped.
      if (!(req.url ?? "").startsWith("/ocr/")) return send(404, { error: "not stubbed" });
      stub.calls.push({ path: req.url ?? "", expected, bytes: body.length });
      if (stub.mode === "down") return send(503, { error: "OCR_ENGINE_MISSING", message: "The Tesseract binary was not found." });
      if (expected && expected !== sha(body)) return send(409, { error: "DIGEST_MISMATCH", message: "not the registered bytes" });

      const plate = (req.url ?? "").startsWith("/ocr/plate");
      const text = plate ? "MH12AB1234" : stub.text;
      const core = {
        confidencePct: 91,
        engine: { name: "tesseract", version: "5.4.0" },
        inputSha256: stub.mode === "other_bytes" ? sha("some other file") : sha(body),
        pipeline: { mode: plate ? "plate" : "document", psm: 3, steps: [{ name: "deskew", angleDeciDegrees: -20 }], variant: "otsu", version: "nyaysetu-ocr-1.0" },
        preprocessedSha256: sha("prepared"),
        textSha256: sha(text),
      };
      const proof = { ...core, resultDigest: sha(canonical(core)) };
      send(200, {
        mode: plate ? "plate" : "document",
        text: stub.mode === "tampered_text" ? text + " (edited)" : text,
        confidence: 0.91,
        variant: "otsu",
        psm: 3,
        improvement: { rawConfidence: 0.52, rawChars: 20, bestConfidence: 0.91, bestChars: 44 },
        candidates: plate ? [{ plate: "MH12AB1234", confidence: 0.91, valid: true, corrections: 0 }] : undefined,
        durationMs: 840,
        proof,
      });
    });
  });
  return new Promise((resolve) => server!.listen(port, "127.0.0.1", () => resolve()));
}

export function stopOcrStub(): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
