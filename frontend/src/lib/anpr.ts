import { api, ApiError } from "./api";
import { plateCanvas } from "./imageTools";

/**
 * Number plate reading (ANPR) for Vehicle Trace.
 *
 * Tries the API first, which uses a dedicated plate-recognition service when the
 * deployment has one. Otherwise the plate is read on this device with Tesseract
 * (loaded only when first needed, so nobody else downloads it), then the raw
 * text is fitted to the Indian registration formats with position-aware
 * corrections: a "0" where a letter must be is read as "O", an "8" as "B".
 *
 * Whatever comes back is a suggestion. The officer confirms or corrects it, and
 * the report records whether the number was typed, read, or read and corrected.
 */

export interface PlateCandidate {
  plate: string;
  confidence: number;
  valid: boolean;
  corrections: number;
}

export const STATE_CODES = new Set([
  "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ", "HP", "HR", "JH", "JK", "KA", "KL",
  "LA", "LD", "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK",
  "UP", "WB",
]);

const STANDARD = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/;
const BHARAT = /^(\d{2})BH(\d{4})([A-Z]{1,2})$/;

export function normalisePlate(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidPlate(plate: string): boolean {
  const m = STANDARD.exec(plate);
  if (m) return STATE_CODES.has(m[1]);
  return BHARAT.test(plate);
}

/** "MH12AB1234" -> "MH 12 AB 1234", for reading aloud over a radio. */
export function formatPlate(plate: string | null | undefined): string {
  if (!plate) return "—";
  const m = STANDARD.exec(plate);
  if (m) return [m[1], m[2], m[3], m[4]].filter(Boolean).join(" ");
  const b = BHARAT.exec(plate);
  if (b) return `${b[1]} BH ${b[2]} ${b[3]}`;
  return plate;
}

const TO_DIGIT: Record<string, string> = { O: "0", D: "0", Q: "0", U: "0", I: "1", L: "1", J: "1", Z: "2", S: "5", B: "8", G: "6", T: "7", A: "4" };
const TO_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "6": "G", "7": "T", "4": "A" };

/** L = letter, D = digit. The common shapes of Indian plates. */
const TEMPLATES = ["LLDDLLDDDD", "LLDDLDDDD", "LLDDLLLDDDD", "LLDLLDDDD", "LLDLLLDDDD", "LLDDDDDD", "LLDDDDDDD", "DDLLDDDDLL", "DDLLDDDDL"];

function coerce(window: string, template: string): { text: string; corrections: number } | null {
  let text = "";
  let corrections = 0;
  for (let i = 0; i < template.length; i++) {
    const c = window[i];
    const wantDigit = template[i] === "D";
    const isDigit = c >= "0" && c <= "9";
    if (wantDigit === isDigit) text += c;
    else {
      const swapped = wantDigit ? TO_DIGIT[c] : TO_LETTER[c];
      if (!swapped) return null;
      text += swapped;
      corrections++;
    }
  }
  return { text, corrections };
}

/** Fits raw OCR text to plate formats, best first. */
export function plateCandidatesFromText(raw: string, ocrConfidence = 0.7): PlateCandidate[] {
  const clean = normalisePlate(raw.replace(/IND/g, " "));
  const found = new Map<string, PlateCandidate>();
  for (const template of TEMPLATES) {
    for (let start = 0; start + template.length <= clean.length; start++) {
      const fitted = coerce(clean.slice(start, start + template.length), template);
      if (!fitted || !isValidPlate(fitted.text)) continue;
      const confidence = Math.max(0, Math.min(1, ocrConfidence - fitted.corrections * 0.08));
      const prior = found.get(fitted.text);
      if (!prior || prior.confidence < confidence) found.set(fitted.text, { plate: fitted.text, confidence, valid: true, corrections: fitted.corrections });
    }
  }
  const out = [...found.values()].sort((a, b) => b.confidence - a.confidence || a.corrections - b.corrections);
  if (out.length === 0 && clean.length >= 4) out.push({ plate: clean.slice(0, 12), confidence: ocrConfidence * 0.4, valid: false, corrections: 0 });
  return out.slice(0, 5);
}

async function readOnDevice(image: Blob, onProgress?: (p: number) => void): Promise<PlateCandidate[]> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng", 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") onProgress?.(m.progress);
    },
  });
  try {
    await worker.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 " });
    const canvas = await plateCanvas(image);
    const { data } = await worker.recognize(canvas);
    return plateCandidatesFromText(data.text, (data.confidence ?? 60) / 100);
  } finally {
    await worker.terminate();
  }
}

export async function readPlate(image: Blob, onProgress?: (p: number) => void): Promise<{ source: "server" | "device"; candidates: PlateCandidate[] }> {
  try {
    const form = new FormData();
    form.append("image", image, "plate.jpg");
    const result = await api.upload<{ candidates: { plate: string; score: number; shape: { valid: boolean } }[] }>("/api/vehicles/anpr", form);
    return {
      source: "server",
      candidates: result.candidates.map((c) => ({ plate: c.plate, confidence: c.score, valid: c.shape.valid, corrections: 0 })),
    };
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 501) {
      // The service is configured but failed: still read it here rather than leave the officer stuck.
      console.warn("Server ANPR failed; reading on this device", error);
    }
  }
  return { source: "device", candidates: await readOnDevice(image, onProgress) };
}
