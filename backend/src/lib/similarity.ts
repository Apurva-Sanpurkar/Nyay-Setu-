/**
 * Deterministic matching primitives for Vehicle Trace and Third Eye.
 *
 * Everything here is explainable: each function returns a number a person can
 * reproduce by hand, and the services attach the reasons alongside the score.
 * None of it decides anything; a match or a lead is a reason for an officer to
 * look, and a person records the decision.
 */

/* ------------------------------------------------------------ stations */

/** "  Shivajinagar   PS " -> "shivajinagar ps". Station names are free text. */
export function stationNorm(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/* ------------------------------------------------------- number plates */

/** Upper case, letters and digits only: "mh-12 ab 1234" -> "MH12AB1234". */
export function normalisePlate(value: string | null | undefined): string | null {
  const out = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return out.length >= 4 && out.length <= 12 ? out : null;
}

/** State and union-territory codes used on Indian registration plates. */
const STATE_CODES = new Set([
  "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ", "HP", "HR", "JH", "JK", "KA", "KL",
  "LA", "LD", "MH", "ML", "MN", "MP", "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK",
  "UP", "WB",
]);

/** MH12AB1234, DL3CAB1234, KA01A1234 and the Bharat series 22BH1234AA. */
const STANDARD = /^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{4})$/;
const BHARAT = /^(\d{2})BH(\d{4})([A-Z]{1,2})$/;

export interface PlateShape {
  valid: boolean;
  format: "standard" | "bharat" | "unknown";
  state: string | null;
  /** The last four digits, which survive most partial reads. */
  serial: string | null;
}

export function plateShape(plate: string | null): PlateShape {
  if (!plate) return { valid: false, format: "unknown", state: null, serial: null };
  const standard = STANDARD.exec(plate);
  if (standard && STATE_CODES.has(standard[1])) {
    return { valid: true, format: "standard", state: standard[1], serial: standard[4] };
  }
  const bharat = BHARAT.exec(plate);
  if (bharat) return { valid: true, format: "bharat", state: null, serial: bharat[2] };
  const digits = /(\d{4})(?!.*\d)/.exec(plate);
  return { valid: false, format: "unknown", state: /^[A-Z]{2}/.test(plate) ? plate.slice(0, 2) : null, serial: digits?.[1] ?? null };
}

/**
 * Characters OCR and tired eyes confuse. Folding both sides through this map
 * before comparing means "MH12AB1234" and "MH12A81234" are recognised as the
 * same plate read twice, not two different vehicles.
 */
const CONFUSABLE: Record<string, string> = { O: "0", Q: "0", I: "1", L: "1", Z: "2", S: "5", B: "8" };

export function foldConfusables(plate: string): string {
  return plate.replace(/[OQILZSB]/g, (c) => CONFUSABLE[c] ?? c);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

export interface PlateComparison {
  kind: "exact" | "partial" | "none";
  score: number;
  reasons: string[];
}

/** How alike two normalised plates are, and why. */
export function comparePlates(a: string | null, b: string | null): PlateComparison {
  if (!a || !b) return { kind: "none", score: 0, reasons: [] };
  if (a === b) return { kind: "exact", score: 1, reasons: [`Registration number ${a} matches exactly`] };

  const fa = foldConfusables(a);
  const fb = foldConfusables(b);
  if (fa === fb) {
    return { kind: "partial", score: 0.9, reasons: [`${a} and ${b} differ only in characters that are easily misread (O/0, B/8, S/5…)`] };
  }
  const distance = levenshtein(fa, fb);
  if (distance === 1) {
    return { kind: "partial", score: 0.8, reasons: [`${a} and ${b} differ by a single character`] };
  }
  const sa = plateShape(a);
  const sb = plateShape(b);
  if (sa.serial && sa.serial === sb.serial && sa.state && sa.state === sb.state) {
    return { kind: "partial", score: 0.6, reasons: [`Same state code (${sa.state}) and the same last four digits (${sa.serial})`] };
  }
  if (sa.serial && sa.serial === sb.serial) {
    return { kind: "partial", score: 0.45, reasons: [`Same last four digits (${sa.serial})`] };
  }
  // One plate fully contained in the other: a partial read of a longer number.
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) {
    return { kind: "partial", score: 0.55, reasons: [`${a.length < b.length ? a : b} is a partial read of ${a.length < b.length ? b : a}`] };
  }
  return { kind: "none", score: 0, reasons: [] };
}

/* ---------------------------------------------------------------- text */

/** Lower case, Latin letters and digits, single spaces. */
export function textNorm(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Words that carry no signal in a modus operandi description. */
const STOP = new Set(
  "a an and are as at be by for from had has have he her his in into is it its of on or she that the their them they this to was were with who while near after before".split(" ")
);

export function keywords(value: string | null | undefined): Set<string> {
  return new Set(
    textNorm(value)
      .split(" ")
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

export function shared<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((x) => b.has(x));
}

/**
 * Name similarity in [0, 1]: token overlap for reordered names ("Patil Ravi"),
 * edit distance for spelling variants ("Ravi Patil" / "Ravee Patil").
 */
export function nameSimilarity(a: string, b: string): number {
  const na = textNorm(a);
  const nb = textNorm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = [...new Set(na.split(" "))];
  const tb = [...new Set(nb.split(" "))];

  // Pair each word with its best unused counterpart: an initial matches the
  // word it abbreviates ("S" / "Shankar"), a spelling variant matches by edit
  // distance ("Ravee" / "Ravi").
  const tokenScore = (x: string, y: string) => {
    if (x === y) return 1;
    if ((x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))) return 0.85;
    // Transliteration variants keep their consonants: Ravi / Ravee,
    // Mohammad / Mohammed, Shaikh / Sheikh.
    const skeleton = (w: string) => w[0] + w.slice(1).replace(/[aeiouy]/g, "").replace(/(.)\1+/g, "$1");
    if (x.length > 2 && y.length > 2 && skeleton(x) === skeleton(y)) return 0.85;
    const ratio = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
    return ratio >= 0.75 ? ratio : 0;
  };
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const used = new Set<number>();
  let matched = 0;
  for (const x of short) {
    let best = 0;
    let bestIndex = -1;
    long.forEach((y, i) => {
      if (used.has(i)) return;
      const s = tokenScore(x, y);
      if (s > best) {
        best = s;
        bestIndex = i;
      }
    });
    if (bestIndex >= 0) used.add(bestIndex);
    matched += best;
  }
  // Half for covering the shorter name, half for covering the longer one, so a
  // missing middle name costs something but not everything.
  return round3(0.5 * (matched / short.length) + 0.5 * (matched / long.length));
}

/* --------------------------------------------------------------- images */

/** Hamming distance between two 64-bit perceptual hashes written as 16 hex digits. */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return 64;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}

/** Great-circle distance in metres. */
export function distanceMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

export const round3 = (n: number) => Math.round(n * 1000) / 1000;
