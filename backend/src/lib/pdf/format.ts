/**
 * Formatting shared by every generated document.
 *
 * Times are always shown in Indian Standard Time, computed with an explicit
 * Asia/Kolkata zone. Using the server's local clock would print UTC on most
 * hosts while still labelling it IST.
 */

import fs from "fs";
import path from "path";

const IST = "Asia/Kolkata";

/** A bundled image (backend/src/assets, copied to dist/assets on build), or null if absent. */
export function pdfAsset(name: string): string | null {
  // Relative to this module, then to the working directory (a Vercel function
  // runs from the service root with src/assets included via includeFiles).
  for (const dir of [path.resolve(__dirname, "..", "..", "assets"), path.resolve(process.cwd(), "src", "assets"), path.resolve(process.cwd(), "dist", "assets")]) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** The Maharashtra Police seal, printed at the top right of every document. */
export const POLICE_SEAL = "seal-maharashtra-police.png";

function parts(value: string | number | Date): Record<string, string> | null {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", {
    timeZone: IST,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d)) {
    out[p.type] = p.value;
  }
  return out;
}

/** 22.10.2026 */
export function istDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const p = parts(value);
  return p ? `${p.day}.${p.month}.${p.year}` : "—";
}

/** 22.10.2026, 23:28 IST */
export function istDateTime(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const p = parts(value);
  return p ? `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute} IST` : "—";
}

/** 22.10.2026, 23:28:14 IST — for records where seconds matter. */
export function istDateTimeSeconds(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  const p = parts(value);
  return p ? `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}:${p.second} IST` : "—";
}

/** The year in IST, or null. */
export function istYear(value: string | number | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return parts(value)?.year ?? null;
}

export const STAGE_LABEL: Record<string, string> = {
  SCENE: "Scene of offence",
  FORENSIC_LAB: "Forensic laboratory",
  PROSECUTOR: "Prosecution",
  COURT: "Court",
};

export const ROLE_LABEL: Record<string, string> = {
  police: "Police officer",
  forensic_lab: "Forensic laboratory",
  prosecutor: "Public prosecutor",
  judge: "Judge",
  defence_lawyer: "Defence counsel",
  accused: "Accused",
  court_admin: "Court registry",
};

export const MOVEMENT_LABEL: Record<string, string> = {
  IN: "Deposited",
  OUT: "Taken out",
  RETURN: "Returned",
  TRANSFER: "Transferred",
};

export const VERIFICATION_LABEL: Record<string, string> = {
  LOCAL_ONLY: "Recorded; not yet submitted to the ledger",
  SUBMITTED: "Submitted to the ledger; awaiting confirmation",
  CONFIRMED: "Confirmed on the ledger",
  SYNC_ERROR: "Submission failed; retry pending",
  REVIEW_REQUIRED: "Under review",
  INTEGRITY_MISMATCH: "Integrity mismatch recorded",
};

/** "0x1e952ad9a6de…d7eac73e" */
export function shortDigest(value: string | null | undefined, lead = 12, tail = 8): string {
  if (!value) return "—";
  return value.length > lead + tail + 1 ? `${value.slice(0, lead)}…${value.slice(-tail)}` : value;
}
