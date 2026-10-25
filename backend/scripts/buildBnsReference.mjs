/**
 * Builds the committed BNS reference from the published text of the Sanhita.
 *
 *   node scripts/buildBnsReference.mjs <path-to-bns_all_section.json>
 *
 * The source is the Bharatiya Nyaya Sanhita, 2023 — the criminal code that
 * replaced the Indian Penal Code in July 2024 — as a section-per-record JSON. The
 * copy used here came from Kaggle (tanujsaxena/the-bharatiya-nyaya-sanhita-2023);
 * any faithful transcription of the Act will do, because what is being read is the
 * statute, which is a public document.
 *
 * WHY THE OUTPUT IS COMMITTED RATHER THAN FETCHED
 *   The API validates FIR section references against it on every case
 *   registration. A deployment that had to download a dataset at boot would fail
 *   to start without network access and credentials, for data that changes when
 *   Parliament amends the Act — which is to say, rarely and deliberately. So the
 *   derived file is checked in, and this script exists to regenerate it when the
 *   Act changes.
 *
 * WHAT IS DERIVED, AND WHAT IS DELIBERATELY NOT
 *   Punishment is parsed out of each section's own text and turned into an
 *   ordinal severity, because two of the models take offence severity as an input
 *   and a number derived from the statute is defensible in a way a hand-assigned
 *   one is not.
 *
 *   A hundred of the 358 sections state no punishment in this source, and there
 *   are two different reasons for that, which is why severity is published as a
 *   LOWER BOUND rather than as the statutory maximum:
 *
 *     - the Sanhita separates defining an offence from punishing it. 303 defines
 *       theft; 303(2) and 305 punish it. A defining section genuinely carries no
 *       term, and null is the right answer.
 *     - this source transcribes one record per section number, and for offences
 *       whose punishment sits in a later sub-section it kept only the defining
 *       text. BNS 309 is the clear case: robbery is defined here, and sub-section
 *       (4), which carries not less than ten years, is absent from the record.
 *
 *   The two are indistinguishable from the data, so absence is never read as
 *   leniency. Where a punishment IS stated it is correct and comes from the text;
 *   where it is not, severity is null and every consumer treats that as unknown
 *   rather than as low. A case usually cites the punishing section alongside the
 *   defining one, so in practice the maximum across a case's sections is available.
 *
 *   An IPC-to-BNS cross-reference is NOT built. The source mentions an IPC section
 *   in 61 of 358 records, and a mapping that covers 17% of the code would be worse
 *   than none: it would answer confidently for a sixth of lookups and silently
 *   wrongly for the rest.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "..", "src", "reference", "bns-sections.json");

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/**
 * The maximum term a section provides for, in years.
 *
 * Only phrases that actually introduce a term are matched — "extend to", "not be
 * less than", "for a term of". A bare "seven years" elsewhere in a sentence, as in
 * a limitation period or an age, is not a sentence length, and matching it would
 * quietly inflate the severity of unrelated sections.
 */
function maxTermYears(text) {
  const found = [];
  const pattern =
    /(?:extend to|extending to|not be less than|for a term of|term which shall not be less than)\s+([a-z]+|\d+)\s+years?/gi;

  for (const match of text.matchAll(pattern)) {
    const token = match[1].toLowerCase();
    const value = /^\d+$/.test(token) ? Number(token) : NUMBER_WORDS[token];
    if (value) found.push(value);
  }
  return found.length ? Math.max(...found) : null;
}

/**
 * Severity on a 1-10 ordinal scale, from what the section provides for.
 *
 * Ordinal, not cardinal: 10 is not "twice as bad as" 5. The boundaries follow the
 * distinctions the criminal process itself draws — capital, life, the seven-year
 * line that separates cognisable-and-non-bailable in practice, and fine-only.
 */
function classify(body) {
  const text = body ?? "";
  const death = /\bpunished with death\b|\bwith death or\b|\bdeath or imprisonment for life\b/i.test(text);
  const life = /imprisonment for life/i.test(text);
  const years = maxTermYears(text);
  const fineOnly = /\bfine\b/i.test(text);

  if (death) return { severity: 10, maxPunishment: "death", termYears: null };
  if (life) return { severity: 9, maxPunishment: "imprisonment for life", termYears: null };

  if (years !== null) {
    // 10 years and above is where the process treats an offence as grave.
    const severity = years >= 10 ? 8 : years >= 7 ? 7 : years >= 5 ? 6 : years >= 3 ? 5 : years >= 2 ? 4 : 3;
    return { severity, maxPunishment: `up to ${years} year${years === 1 ? "" : "s"}`, termYears: years };
  }

  if (fineOnly) return { severity: 2, maxPunishment: "fine", termYears: 0 };

  // A defining section, with no penalty of its own.
  return { severity: null, maxPunishment: null, termYears: null };
}

/** "Section 303 – Theft. Whoever…" -> "Theft." Keeps the heading, drops the echo. */
function cleanTitle(raw, sectionNo) {
  let title = String(raw ?? "").trim();
  title = title.replace(new RegExp(`^Section\\s*${sectionNo}\\s*[-–—]\\s*`, "i"), "");

  // Some records run the whole body into the title. Keep the first sentence,
  // which is the marginal heading, and let the body carry the rest.
  const firstStop = title.indexOf(". ");
  if (firstStop > 0 && firstStop < 90) title = title.slice(0, firstStop + 1);

  return title.replace(/\s+/g, " ").trim();
}

/** The chapter names in the source run two headings together. Take the first. */
function cleanChapter(raw) {
  const chapter = String(raw ?? "").replace(/\s+/g, " ").trim();
  const split = chapter.match(/^(.*?)\s+Of\s+[A-Z]/);
  return split ? split[1].trim() : chapter;
}

function main() {
  const source = process.argv[2];
  if (!source) {
    console.error(
      [
        "",
        "  Usage: node scripts/buildBnsReference.mjs <path-to-bns_all_section.json>",
        "",
        "  The source is a section-per-record transcription of the Bharatiya Nyaya",
        "  Sanhita, 2023. One is published on Kaggle as",
        "  tanujsaxena/the-bharatiya-nyaya-sanhita-2023.",
        "",
        "  The generated file is committed, so this only needs running when the Act",
        "  itself is amended.",
        "",
      ].join("\n")
    );
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(source, "utf8"));
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array of sections.");

  const sections = raw
    .filter((row) => Number.isInteger(row.section_no))
    .map((row) => {
      const { severity, maxPunishment, termYears } = classify(row.body);
      return {
        section: row.section_no,
        title: cleanTitle(row.title, row.section_no),
        chapter: cleanChapter(row.chapter),
        // null means "this source states no punishment for this section", which
        // is either a defining section or a truncated record. Never "mild".
        severity,
        maxPunishment,
        termYears,
        statesPunishment: severity !== null,
      };
    })
    .sort((a, b) => a.section - b.section);

  const withSeverity = sections.filter((s) => s.severity !== null).length;

  const output = {
    act: "BNS",
    actTitle: "Bharatiya Nyaya Sanhita, 2023",
    // Stated in the artefact itself so nobody has to trust a commit message.
    generatedBy: "backend/scripts/buildBnsReference.mjs",
    note:
      "Severity is an ordinal 1-10 derived from the punishment each section states. Where it is " +
      "null, this source states no punishment for that section.",
    caveat:
      "Severity is a LOWER BOUND, not the statutory maximum. A null arises either because the " +
      "section only defines an offence (303 defines theft; 305 punishes it) or because the source " +
      "transcribed only the defining sub-section of a longer section (309 defines robbery; its " +
      "sub-section (4) carrying ten years is absent). The two cannot be told apart from the data, " +
      "so null must be read as unknown and never as lenient.",
    sectionCount: sections.length,
    sectionsWithStatedPunishment: withSeverity,
    sections,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(output, null, 1) + "\n", "utf8");

  console.log(`\n  Wrote ${sections.length} sections to src/reference/bns-sections.json`);
  console.log(`  ${withSeverity} state a punishment; ${sections.length - withSeverity} are defining sections.`);

  const bands = {};
  for (const s of sections) {
    const key = s.severity === null ? "none" : String(s.severity);
    bands[key] = (bands[key] ?? 0) + 1;
  }
  console.log("  severity distribution:", bands, "\n");
}

main();
