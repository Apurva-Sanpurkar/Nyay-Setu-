import { badRequest } from "./errors";

/**
 * FIR numbers, as police stations actually write them.
 *
 * Forms seen in practice: "0042/2026", "I-42/2026", "CR No. 42 of 2026", plain
 * "42". The serial is what identifies an FIR within a station and a year, so it
 * is normalised (spaces dropped, case folded, leading zeros on numeric groups
 * removed) and uniqueness is enforced on (station, year, normalised number).
 */

const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,39}$/;

export interface FirInput {
  number: string;
  year: number;
  date?: string | null;
  policeStation: string;
  district?: string | null;
}

export interface NormalisedFir {
  fir_number: string;
  fir_number_norm: string;
  fir_year: number;
  fir_date: string | null;
  police_station: string;
  police_station_norm: string;
  district: string | null;
}

export function normaliseStation(station: string): string {
  return station
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normaliseFirNumber(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^(CR|FIR)(NO\.?|NUMBER)?/, "")
    .replace(/\d+/g, (digits) => String(Number(digits)));
}

export function validateFir(input: FirInput, now: Date = new Date()): NormalisedFir {
  const number = String(input.number ?? "").trim();
  if (!ALLOWED.test(number)) {
    throw badRequest("The FIR number may contain letters, digits, spaces, dot, slash, dash and underscore, up to 40 characters.");
  }
  const year = Number(input.year);
  if (!Number.isInteger(year) || year < 1950 || year > now.getUTCFullYear()) {
    throw badRequest(`The FIR year must be between 1950 and ${now.getUTCFullYear()}.`);
  }

  let date: string | null = null;
  if (input.date) {
    const parsed = new Date(`${input.date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      throw badRequest("The FIR date must be a date in YYYY-MM-DD form.");
    }
    if (parsed.getTime() > now.getTime()) throw badRequest("The FIR date cannot be in the future.");
    if (parsed.getUTCFullYear() !== year) throw badRequest("The FIR date must fall in the FIR year.");
    date = input.date;
  }

  const station = String(input.policeStation ?? "").trim();
  if (station.length < 2) throw badRequest("The police station that registered the FIR is required.");

  const norm = normaliseFirNumber(number);
  if (!norm) throw badRequest("The FIR number has no serial in it.");

  return {
    fir_number: number,
    fir_number_norm: norm,
    fir_year: year,
    fir_date: date,
    police_station: station,
    police_station_norm: normaliseStation(station),
    district: input.district?.trim() || null,
  };
}
