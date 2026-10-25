import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";

/**
 * The Bharatiya Nyaya Sanhita, 2023, as reference data the API can check an FIR
 * against.
 *
 * WHY THIS EXISTS
 *   A case's `sections` field used to accept any string up to forty characters.
 *   "BNS 303", "303", "s.303", "BSN 303" and "" were all equally acceptable, which
 *   means the field recorded what somebody typed rather than what they charged.
 *   Every later question — how serious is this offence, which chapter of the code
 *   does it fall under, is this even a real section — was unanswerable.
 *
 * WHAT IT DOES NOT DO: REJECT
 *   A real FIR cites the Sanhita and special legislation together — the NDPS Act,
 *   POCSO, the IT Act, the Arms Act, none of which are in the BNS. An API that
 *   refused anything it did not recognise would refuse most genuine charge sheets.
 *   So references are ENRICHED, not validated: a BNS section gains its title, its
 *   chapter and its punishment, and everything else passes through untouched and
 *   marked unrecognised.
 *
 * SEVERITY IS A LOWER BOUND
 *   Where a section states a punishment, the severity derived from it is correct.
 *   Where it does not, the reason is either that the section only defines the
 *   offence — 303 defines theft, 305 punishes a species of it — or that the source
 *   transcription kept only the defining sub-section. Those two are
 *   indistinguishable from the data, so an absent severity is reported as unknown
 *   and never substituted with a default. A model that received "mild" here when
 *   the truth was "ten years" would be worse than one that received nothing.
 */

interface BnsSection {
  section: number;
  title: string;
  chapter: string;
  severity: number | null;
  maxPunishment: string | null;
  termYears: number | null;
  statesPunishment: boolean;
}

interface BnsReference {
  act: string;
  actTitle: string;
  caveat: string;
  sectionCount: number;
  sectionsWithStatedPunishment: number;
  sections: BnsSection[];
}

/**
 * Read from disk rather than imported.
 *
 * The build emits CommonJS, so a JSON import assertion is not available, and
 * resolveJsonModule would inline 96KB of statute into the bundle on every import.
 * Reading the file once, lazily, keeps it out of the module graph — and means a
 * missing artefact degrades to "lookup unavailable" instead of failing the build.
 */
// Relative to this module, or to the service root when bundled as a Vercel function.
const REFERENCE_PATH =
  [
    path.resolve(__dirname, "..", "reference", "bns-sections.json"),
    path.resolve(process.cwd(), "src", "reference", "bns-sections.json"),
    path.resolve(process.cwd(), "dist", "reference", "bns-sections.json"),
  ].find((file) => fs.existsSync(file)) ?? path.resolve(__dirname, "..", "reference", "bns-sections.json");

let reference: BnsReference | null = null;
let attempted = false;
let byNumber: Map<number, BnsSection> = new Map();

function load(): BnsReference | null {
  if (reference || attempted) return reference;
  attempted = true;
  try {
    reference = JSON.parse(fs.readFileSync(REFERENCE_PATH, "utf8")) as BnsReference;
    byNumber = new Map(reference.sections.map((s) => [s.section, s]));
    logger.info("Loaded the BNS reference", {
      sections: reference.sectionCount,
      withStatedPunishment: reference.sectionsWithStatedPunishment,
    });
  } catch (error) {
    // Not fatal. Section references fall back to being opaque strings, which is
    // how the system behaved before this existed.
    logger.warn("Could not load the BNS reference; section lookup is unavailable", {
      path: REFERENCE_PATH,
      error: error instanceof Error ? error.message : error,
    });
    reference = null;
  }
  return reference;
}

export function statuteReady(): boolean {
  return load() !== null;
}

export function statuteMeta(): { act: string; actTitle: string; sections: number; caveat: string } | null {
  const ref = load();
  return ref
    ? { act: ref.act, actTitle: ref.actTitle, sections: ref.sectionCount, caveat: ref.caveat }
    : null;
}

export interface ParsedReference {
  /** Exactly what was typed, preserved so nothing is lost. */
  raw: string;
  /** Canonical form when recognised, e.g. "BNS 303(2)". Otherwise the input, tidied. */
  canonical: string;
  act: string | null;
  section: number | null;
  subsection: string | null;
  title: string | null;
  chapter: string | null;
  severity: number | null;
  maxPunishment: string | null;
  recognised: boolean;
}

/**
 * Reads one citation as written on an FIR.
 *
 * Deliberately permissive about form and strict about identity: "BNS 303(2)",
 * "bns303(2)", "S. 303(2) BNS" and "303(2)" all resolve to the same section,
 * because a station writes it differently every time and the section number is
 * the fact. An act name that is not the Sanhita is kept and left alone.
 */
export function parseReference(raw: string): ParsedReference {
  const input = String(raw ?? "").trim();
  const tidy = input.replace(/\s+/g, " ");

  const empty: ParsedReference = {
    raw: input,
    canonical: tidy,
    act: null,
    section: null,
    subsection: null,
    title: null,
    chapter: null,
    severity: null,
    maxPunishment: null,
    recognised: false,
  };
  if (!tidy) return empty;

  // An explicit act other than the Sanhita: pass through, do not guess.
  const otherAct = /\b(IPC|CrPC|BNSS|BSA|NDPS|POCSO|IT ACT|ARMS|MV ACT|PMLA|UAPA)\b/i.exec(tidy);
  if (otherAct && !/\bBNS\b/i.test(tidy)) {
    return { ...empty, act: otherAct[1].toUpperCase() };
  }

  // Strip the section-marker noise, then take the leading number and any
  // bracketed or dotted sub-section after it.
  //
  // No trailing \b on the marker: "bns303(2)" has no boundary between the s and
  // the 3, and a station types it that way. Longest alternative first, or SEC
  // would eat the start of SECTION.
  const stripped = tidy.replace(/\b(SECTION|SEC|BNS|S)\.?\s*/gi, " ").replace(/\s+/g, " ").trim();

  // (?!\d) so a four digit number is not silently read as its first three:
  // "BNS 9999" is not section 999.
  const match = /^(\d{1,3})(?!\d)\s*(?:\(([^)]{1,8})\)|\.(\d{1,3}))?/.exec(stripped);
  if (!match) return empty;

  const section = Number(match[1]);
  const subsection = match[2] ?? match[3] ?? null;

  const found = load() ? byNumber.get(section) : undefined;
  if (!found) {
    // A number we cannot place. Still normalised, still not claimed as BNS.
    return { ...empty, section, subsection };
  }

  return {
    raw: input,
    canonical: `BNS ${section}${subsection ? `(${subsection})` : ""}`,
    act: "BNS",
    section,
    subsection,
    title: found.title,
    chapter: found.chapter,
    severity: found.severity,
    maxPunishment: found.maxPunishment,
    recognised: true,
  };
}

export interface StatuteSummary {
  references: ParsedReference[];
  recognised: number;
  unrecognised: string[];
  /**
   * The gravest punishment any cited section states, 1-10, or null when none of
   * them state one. Null means unknown, not mild.
   */
  severity: number | null;
  /** Which citation the severity came from, so the number can be traced. */
  severityFrom: string | null;
  caveat: string | null;
}

/** Reads every citation on a case and summarises what the code says about them. */
export function describeSections(sections: readonly string[]): StatuteSummary {
  const references = sections.map(parseReference).filter((r) => r.canonical !== "");

  let severity: number | null = null;
  let severityFrom: string | null = null;
  for (const ref of references) {
    if (ref.severity !== null && (severity === null || ref.severity > severity)) {
      severity = ref.severity;
      severityFrom = ref.canonical;
    }
  }

  return {
    references,
    recognised: references.filter((r) => r.recognised).length,
    unrecognised: references.filter((r) => !r.recognised).map((r) => r.canonical),
    severity,
    severityFrom,
    caveat: severity === null ? null : (statuteMeta()?.caveat ?? null),
  };
}

/**
 * Free-text search over the code, for the field an officer types a charge into.
 *
 * A number match wins over a title match, because somebody typing "303" wants
 * section 303 and not every section whose text mentions it.
 */
export function searchSections(query: string, limit = 12): BnsSection[] {
  const ref = load();
  if (!ref) return [];

  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return ref.sections.filter((s) => s.statesPunishment).slice(0, limit);

  const digits = /^\d{1,3}$/.exec(q.replace(/[^\d]/g, ""));
  const exact = digits ? byNumber.get(Number(digits[0])) : undefined;

  const byTitle = ref.sections.filter(
    (s) =>
      s.section !== exact?.section &&
      (s.title.toLowerCase().includes(q) || s.chapter.toLowerCase().includes(q))
  );

  const prefixed = digits
    ? ref.sections.filter(
        (s) => s.section !== exact?.section && String(s.section).startsWith(digits[0])
      )
    : [];

  return [...(exact ? [exact] : []), ...prefixed, ...byTitle].slice(0, limit);
}

export function getSection(section: number): BnsSection | null {
  load();
  return byNumber.get(section) ?? null;
}
