import { CourtDocument } from "./document";
import { istDate, istDateTime, istYear } from "./format";
import type { CaseDossier } from "../../services/report.service";
import { gatewayFor } from "../../services/report.service";
import { explorerUrl } from "../chain";

/**
 * The Final Report, in the form a Sessions Court expects to receive it.
 *
 * WHAT THIS IS
 *   The numbered items 1 to 18 are the standard Indian final report — the same
 *   form that was filed under section 173 of the Code of Criminal Procedure and is
 *   now filed under section 193 of the Bharatiya Nagarik Suraksha Sanhita, 2023.
 *   The order and the numbering are not a design choice; a registry reads them
 *   against a printed template and a rearranged form looks like a draft.
 *
 * WHAT IS ADDED, AND WHY IT BELONGS
 *   Three annexures, because a paper form has nowhere to put the one thing this
 *   platform actually provides:
 *
 *     A  The sections charged, with what the Sanhita says each one is and what it
 *        provides for. A reader should not have to know the code by heart.
 *     B  The schedule of electronic evidence: every digest, where it was anchored,
 *        and the whole chain of custody with the transaction that recorded each
 *        transfer. This is the annexure that makes the rest checkable.
 *     C  A certificate in the form required for electronic records. Without it the
 *        material in Annexure B is inadmissible however well anchored it is, and
 *        the certificate is the reason the digests were computed on the collecting
 *        device in the first place.
 *
 * WHAT IT DOES NOT DO
 *   It does not sign anything. The endorsement blocks are ruled and left empty,
 *   because a document produced by software and a document signed by an officer are
 *   different things and the page must not blur them.
 */

const NOT_RECORDED = "Not recorded in the system";

/** under_investigation -> Under investigation. A court form is not a database. */
function humanise(value: string | null | undefined): string {
  if (!value) return "—";
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function date(value: string | null | undefined): string {
  return istDate(value);
}

function dateTime(value: string | null | undefined): string {
  return istDateTime(value);
}

function bytes(value: number | null): string {
  if (value === null || value === undefined) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}

function coords(lat: number | null, lng: number | null): string {
  if (lat === null || lng === null) return "—";
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

const STAGE_LABEL: Record<string, string> = {
  SCENE: "Scene of offence",
  FORENSIC_LAB: "Forensic laboratory",
  PROSECUTOR: "Public prosecutor",
  COURT: "Court",
};

const ROLE_LABEL: Record<string, string> = {
  police: "Police officer",
  forensic_lab: "Forensic laboratory",
  prosecutor: "Public prosecutor",
  judge: "Judge",
  defence_lawyer: "Defence counsel",
  accused: "Accused",
  court_admin: "Court registry",
};

export function buildFinalReport(dossier: CaseDossier): CourtDocument {
  const { case: c, statute } = dossier;
  const year = istYear(c.registered_at) ?? "—";

  const document = new CourtDocument({
    title: "Final Report / Charge Sheet",
    authority:
      "Under Section 193 of the Bharatiya Nagarik Suraksha Sanhita, 2023 " +
      "(formerly Section 173, Code of Criminal Procedure, 1973)",
    shortTitle: "Final Report",
    fileReference: c.case_reference,
    issuedBy: c.police_station,
    district: "Pune",
  });

  /* ------------------------------------------------------------- items 1-9 */

  document.item("1", "Particulars of the case");
  document.field("Police Station", c.police_station);
  document.field("Year", year);
  document.field("Case reference", c.case_reference);
  document.field(
    "C.R. / F.I.R. No.",
    c.fir_number ?? (c.fir_linked ? "Linked; withheld from this copy" : "No FIR linked")
  );
  document.field("Date of registration", date(c.registered_at));
  document.field("Court", c.court_name ?? "Not yet assigned");

  document.item("2", "Nature of the final report");
  document.field("Report", "Charge sheet filed");
  document.field("Whether original or supplementary", "Original");
  document.field("Present status of the case", humanise(c.status));

  document.item("3", "Date of this report");
  document.field("Prepared on", dateTime(dossier.generatedAt));

  document.item("4", "Provisions of law under which the offence is charged");
  if (statute.references.length === 0) {
    document.field("Sections", "None recorded");
  } else {
    statute.references.forEach((ref, index) => {
      document.field(
        `${index + 1}. ${ref.act ?? "Act not identified"}`,
        ref.recognised
          ? `Section ${ref.section}${ref.subsection ? `(${ref.subsection})` : ""} — ${ref.title}`
          : `${ref.canonical} (not in the Bharatiya Nyaya Sanhita; see Annexure A)`
      );
    });
    document.field("Offence type recorded", c.offence_type);
  }

  document.item("5", "Investigating officer");
  document.field("Name", dossier.registeredBy?.full_name ?? NOT_RECORDED);
  document.field("Designation", dossier.registeredBy?.designation ?? "—");
  document.field("Posted at", dossier.registeredBy?.station_or_court ?? c.police_station);

  document.item("6", "Complainant / informant");
  document.field(
    "Particulars",
    // Said plainly rather than left blank: an empty field on a court form reads as
    // an omission by the officer, when in fact this platform records the case and
    // its evidence and never held the complainant's details.
    "Not held by this system. To be completed from the station records before filing."
  );

  document.item("7", "Accused persons");
  if (dossier.bail) {
    document.field("Name", dossier.bail.accused_name);
    document.field("Status", dossier.bail.active ? "Released on bail" : "Bail order not active");
    document.field("Date of order", date(dossier.bail.created_at));
    document.field("Surety", dossier.bail.surety_name ?? "—");
    document.field("Conditions imposed", dossier.bail.conditions.join("; ") || "—");
  } else {
    const accused = dossier.participants.filter((p) => p.role === "accused");
    if (accused.length === 0) {
      document.field("Particulars", "No accused person is recorded against this case.");
    } else {
      accused.forEach((person, index) => {
        document.field(`${index + 1}. Name`, person.full_name);
        document.field("Address on record", person.station_or_court ?? "—");
      });
    }
  }
  document.paragraph(
    "Personal particulars required by items 11 of the prescribed form — parentage, age, " +
      "religion, occupation, permanent address, previous convictions and dates of arrest and " +
      "remand — are maintained in the station records and are to be appended to this report. " +
      "This system records identity only as a one-way token derived from an Aadhaar number, " +
      "and by design holds no Aadhaar number from which those particulars could be restated.",
    { italic: true, size: 8.5 }
  );

  document.item("8", "Persons having access to the case record");
  document.table(
    [
      { header: "Name", width: 150 },
      { header: "Capacity", width: 110 },
      { header: "Designation / posting", width: 150 },
      { header: "Access", width: 60, align: "center" },
    ],
    dossier.participants.map((p) => [
      p.full_name,
      ROLE_LABEL[p.role] ?? p.role,
      p.designation ?? p.station_or_court ?? "—",
      p.access === "write" ? "Read & write" : "Read only",
    ])
  );

  document.item("9", "Property and articles relied upon");
  document.paragraph(
    "Physical property, its estimated value, the station diary serial number, the person and " +
      "place of recovery and its disposal are to be entered from the station records. The " +
      "electronic records relied upon are scheduled at Annexure B, each with the digest " +
      "recorded at the time of seizure.",
    { italic: true, size: 8.5 }
  );

  /* ---------------------------------------------------------- items 10-14 */

  document.item("10", "Findings of laboratory examination");
  if (dossier.forensics.length === 0) {
    document.field("Reports received", "None");
  } else {
    document.table(
      [
        { header: "Exhibit", width: 120 },
        { header: "Conclusion", width: 210 },
        { header: "Report digest", width: 140, mono: true },
        { header: "Dated", width: 70 },
      ],
      dossier.forensics.map((f) => {
        const item = dossier.evidence.find((e) => e.id === f.evidence_id);
        return [
          item ? `Ex. ${exhibitNumber(dossier, item.id)} — ${item.file_name}` : "—",
          f.conclusion,
          short(f.report_hash),
          date(f.created_at),
        ];
      })
    );
    document.paragraph(
      "Each conclusion above is anchored by the digest shown. A report produced later and " +
        "differing in any respect would not reproduce that digest.",
      { italic: true, size: 8.5 }
    );
  }

  document.item("11", "Process issued and service");
  if (dossier.summons.length === 0) {
    document.field("Summons issued", "None");
  } else {
    document.table(
      [
        { header: "Recipient", width: 130 },
        { header: "Issued", width: 78 },
        { header: "Window expires", width: 78 },
        { header: "Status", width: 74, align: "center" },
        { header: "Acknowledged at", width: 120 },
      ],
      dossier.summons.map((s) => [
        s.recipient_name,
        date(s.issued_at),
        date(s.expiry_at),
        s.status,
        s.delivered_at
          ? `${dateTime(s.delivered_at)}\n${coords(s.ack_gps_lat, s.ack_gps_lng)}`
          : "Not acknowledged",
      ])
    );
    document.paragraph(
      "An acknowledgement recorded above was authenticated by a one-time code sent to the " +
        "recipient and recorded with the time, the coordinates and a device fingerprint as a " +
        "blockchain transaction. It cannot be produced without the recipient and cannot be " +
        "back-dated after the fact.",
      { italic: true, size: 8.5 }
    );
  }

  document.item("12", "Order as to bail and compliance");
  if (!dossier.bail) {
    document.field("Bail order", "None recorded");
  } else {
    const b = dossier.bail;
    document.field("Accused", b.accused_name);
    document.field("Conditions", b.conditions.join("; ") || "—");
    document.field("Conditions encoded on chain", b.condition_tags.join(", ") || "—");
    document.field(
      "Geographical restriction",
      b.radius_metres > 0 && b.centre_lat !== null
        ? `${b.radius_metres} m of ${coords(b.centre_lat, b.centre_lng)}`
        : "None imposed"
    );
    document.field(
      "Reporting interval",
      b.checkin_interval_seconds ? `Every ${Math.round(b.checkin_interval_seconds / 3600)} hour(s)` : "—"
    );
    document.field("Order expires", date(b.expiry_at));
    document.field("Compliance score", b.compliance_score === null ? "—" : `${b.compliance_score} / 100`);
    if (b.risk_band) {
      document.field(
        "Risk assessment at the time of grant",
        `${b.risk_band}${b.risk_score === null ? "" : ` (${b.risk_score})`} — advisory only, ` +
          "produced by a statistical model and not a finding of this report"
      );
    }
  }

  document.item("13", "Breaches of bail conditions detected");
  if (dossier.violations.length === 0) {
    document.field("Breaches", "None detected");
  } else {
    document.table(
      [
        { header: "Detected", width: 104 },
        { header: "Nature", width: 116 },
        { header: "Particulars", width: 190 },
        { header: "Acknowledged", width: 90 },
      ],
      dossier.violations.map((v) => [
        dateTime(v.detected_at),
        v.kind,
        v.reason,
        v.acknowledged_at ? date(v.acknowledged_at) : "Outstanding",
      ])
    );
  }

  document.item("14", "Brief facts of the case");
  document.paragraph(
    c.summary?.trim() ||
      "The narrative of the offence is to be appended. This system records the evidence and " +
        "its provenance, and does not compose the account of the incident."
  );

  /* ---------------------------------------------------------- items 15-18 */

  document.item("15", "Action under Section 217 of the Bharatiya Nyaya Sanhita, 2023");
  document.field("Whether the first information is false", "No such finding recorded");

  document.item("16", "Notice to the complainant / informant");
  document.field("Notice issued", "To be recorded at the time of filing");

  document.item("17", "Integrity of the record relied upon");
  document.field("Exhibits scheduled", String(dossier.evidence.length));
  document.field(
    "Exhibits flagged on automated screening",
    String(dossier.evidence.filter((e) => e.anomaly_flagged).length)
  );
  const refusals = Object.values(dossier.integrity)
    .flat()
    .filter((i) => !i.matched).length;
  document.field("Verification attempts refused for digest mismatch", String(refusals));
  if (refusals > 0) {
    document.paragraph(
      `${refusals} attempt(s) to submit material whose digest did not match the record were ` +
        "refused, and each refusal was itself recorded on the blockchain. Particulars are at " +
        "Annexure B. A refused attempt is not a defect in the record; it is the record working.",
      { italic: true, size: 8.5 }
    );
  }

  document.item("18", "Officer submitting this report");
  document.field("Name", dossier.registeredBy?.full_name ?? NOT_RECORDED);
  document.field("Designation", dossier.registeredBy?.designation ?? "—");

  document.endorsement([
    {
      role: "Endorsed by the Station House Officer / Senior Officer",
      name: null,
      designation: null,
    },
    {
      role: "Officer presenting the Final Report",
      name: dossier.registeredBy?.full_name ?? null,
      designation: dossier.registeredBy?.designation ?? null,
    },
  ]);

  /* --------------------------------------------------------------- annexures */

  annexureA(document, dossier);
  annexureB(document, dossier);
  annexureC(document, dossier);

  return document;
}

/* ============================================================== annexures */

function annexureA(document: CourtDocument, dossier: CaseDossier): void {
  document.newPage();
  document.heading("Annexure A — Sections charged");
  document.paragraph(
    "Each section cited in item 4, with its heading in the Bharatiya Nyaya Sanhita, 2023 and " +
      "the punishment that section itself provides for.",
    { italic: true, size: 9 }
  );

  const rows = dossier.statute.references.map((ref) => [
    ref.canonical,
    ref.recognised ? ref.title : "Not a section of the Sanhita",
    ref.recognised ? ref.chapter : "—",
    ref.maxPunishment ?? "Not stated in this section",
  ]);

  document.table(
    [
      { header: "Section", width: 74 },
      { header: "Heading", width: 190 },
      { header: "Chapter", width: 150 },
      { header: "Punishment provided", width: 110 },
    ],
    rows
  );

  document.paragraph(
    "Where a punishment is shown as not stated, the section defines the offence and the " +
      "punishment is provided by another section — the Sanhita separates the two. Section 303 " +
      "defines theft; section 305 provides the punishment for theft in a dwelling house. Nothing " +
      "in this annexure should be read as indicating that an offence carries no penalty.",
    { italic: true, size: 8.5 }
  );

  if (dossier.statute.unrecognised.length > 0) {
    document.paragraph(
      `The following citations are not sections of the Bharatiya Nyaya Sanhita and have been ` +
        `recorded exactly as furnished: ${dossier.statute.unrecognised.join(", ")}. They are ` +
        "presumed to be provisions of special legislation and must be verified against the " +
        "relevant Act.",
      { italic: true, size: 8.5 }
    );
  }
}

function exhibitNumber(dossier: CaseDossier, evidenceId: string): string {
  const index = dossier.evidence.findIndex((e) => e.id === evidenceId);
  return index < 0 ? "?" : String(index + 1);
}

function short(hash: string | null | undefined): string {
  if (!hash) return "—";
  return hash.length > 22 ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : hash;
}

function annexureB(document: CourtDocument, dossier: CaseDossier): void {
  document.newPage();
  document.heading("Annexure B — Schedule of electronic records");
  document.paragraph(
    "Each record relied upon, the digest computed on the collecting device before it left that " +
      "device, and the chain of custody. Every transfer is a blockchain transaction; the " +
      "transaction identifier is given so that a reader may confirm it without applying to the " +
      "prosecution for anything.",
    { italic: true, size: 9 }
  );

  if (dossier.evidence.length === 0) {
    document.paragraph("No electronic records are relied upon in this case.");
    return;
  }

  dossier.evidence.forEach((item, index) => {
    document.ensure(230);
    document.heading(`Exhibit ${index + 1} — ${item.file_name}`, { rule: false });

    document.field("Nature of the record", item.kind);
    document.field("Format", item.mime_type ?? "—");
    document.field("Size", bytes(item.size_bytes));
    document.field("Collected at", dateTime(item.collected_at));
    document.field("Place of collection", coords(item.gps_lat, item.gps_lng));
    document.field("Collected by", item.users?.full_name ?? NOT_RECORDED);
    document.field("Present custody", STAGE_LABEL[item.current_stage] ?? item.current_stage);

    document.digest("SHA-256 digest", item.file_hash);
    document.digest("Registration transaction", item.registration_tx_hash);
    if (item.chain_evidence_id !== null) {
      document.field("On-chain record number", String(item.chain_evidence_id));
    }
    const gateway = gatewayFor(item.ipfs_cid);
    document.field(
      "Encrypted copy",
      item.ipfs_cid
        ? gateway
          ? `${item.ipfs_cid} (retrievable at the gateway)`
          : `${item.ipfs_cid} — held in local storage, not distributed`
        : "Not stored"
    );

    if (item.anomaly_flagged) {
      document.paragraph(
        `Automated screening flagged this record${
          item.anomaly_score === null ? "" : ` (score ${item.anomaly_score})`
        }: ${(item.anomaly_reasons ?? []).join(" ")} A flag is an indication for examination and ` +
          "is not a finding that the record has been altered. The digest above is the test of that.",
        { italic: true, size: 8.5 }
      );
    }

    const custody = dossier.custody[item.id] ?? [];
    if (custody.length > 0) {
      document.table(
        [
          { header: "From", width: 96 },
          { header: "To", width: 96 },
          { header: "By", width: 92 },
          { header: "Date and time", width: 108 },
          { header: "Transaction", width: 104, mono: true },
          { header: "Block", width: 48, align: "right" },
        ],
        custody.map((t) => [
          t.from_stage ? (STAGE_LABEL[t.from_stage] ?? t.from_stage) : "Registration",
          STAGE_LABEL[t.to_stage] ?? t.to_stage,
          t.actor_role ? (ROLE_LABEL[t.actor_role] ?? t.actor_role) : "—",
          dateTime(t.occurred_at),
          short(t.tx_hash),
          t.block_number === null ? "—" : String(t.block_number),
        ]),
        { fontSize: 7.6 }
      );
    }

    const checks = dossier.integrity[item.id] ?? [];
    const failed = checks.filter((ch) => !ch.matched);
    if (failed.length > 0) {
      document.paragraph(
        `${failed.length} verification attempt(s) on this exhibit were refused because the ` +
          "digest submitted did not match the digest of record:",
        { size: 8.8 }
      );
      document.table(
        [
          { header: "Attempted", width: 104 },
          { header: "By", width: 92 },
          { header: "Digest submitted", width: 150, mono: true },
          { header: "Refusal recorded at", width: 150, mono: true },
        ],
        failed.map((ch) => [
          dateTime(ch.created_at),
          ch.checked_by_role ? (ROLE_LABEL[ch.checked_by_role] ?? ch.checked_by_role) : "—",
          short(ch.submitted_hash),
          short(ch.tx_hash),
        ]),
        { fontSize: 7.6 }
      );
    }
  });
}

function annexureC(document: CourtDocument, dossier: CaseDossier): void {
  document.newPage();
  document.heading("Annexure C — Certificate in respect of electronic records");
  document.paragraph(
    "Under Section 63 of the Bharatiya Sakshya Adhiniyam, 2023 " +
      "(formerly Section 65B of the Indian Evidence Act, 1872)",
    { italic: true, size: 9.5 }
  );

  document.paragraph(
    "I, the officer subscribing below, having lawful control over the computer system by which " +
      "the electronic records scheduled at Annexure B were produced, certify as follows."
  );

  const clauses: string[] = [
    "1. Each record was produced by a device in regular use for the recording of information " +
      "in the course of the lawful activities of the police station named above.",

    "2. The digest of each record, stated in Annexure B, was computed by the collecting device " +
      "over the bytes of the record before the record was transmitted from that device. The " +
      "digest was recomputed on receipt and the two were found to agree; the record was not " +
      "accepted otherwise.",

    "3. Each digest was thereafter recorded in a transaction on " +
      (dossier.network
        ? `the ${dossier.network.name} blockchain network (chain identifier ${dossier.network.chainId})`
        : "a blockchain network") +
      ". The transaction identifier for each is stated in Annexure B. Neither this office nor " +
      "any other party can alter a record so entered.",

    "4. Every transfer of custody was effected by the receiving party computing the digest of " +
      "the record as it was received and submitting it for comparison. Where the digests agreed, " +
      "the transfer was recorded. Where they did not, the transfer was refused and the refusal " +
      "was itself recorded, as scheduled at Annexure B.",

    "5. The contents of each record have not been altered at any time after collection. Any " +
      "alteration, of a single byte, would produce a different digest from the one recorded, and " +
      "the record as held may be tested against the digest by any person at any time.",

    "6. Where a record is shown as held in encrypted form, it was encrypted after the digest was " +
      "computed and before storage, and the digest certified above is the digest of the record " +
      "itself and not of the encrypted copy.",
  ];

  for (const clause of clauses) {
    document.paragraph(clause, { size: 9.3 });
  }

  document.heading("Particulars of the anchoring system", { rule: false });
  document.field("Network", dossier.network ? `${dossier.network.name} (chain ${dossier.network.chainId})` : "Not recorded");
  if (dossier.contracts) {
    document.digest("Evidence register contract", dossier.contracts.EvidenceChain ?? null);
    document.digest("Summons register contract", dossier.contracts.SummonsChain ?? null);
    document.digest("Bail register contract", dossier.contracts.BailChain ?? null);
  }
  document.digest("Case identifier on chain", dossier.case.case_id_hash);
  document.field("Digest algorithm", "SHA-256 (FIPS 180-4)");
  document.field("Encryption of stored copies", "AES-256-GCM");

  document.endorsement([
    {
      role: "Certified by the officer having control of the system",
      name: dossier.registeredBy?.full_name ?? null,
      designation: dossier.registeredBy?.designation ?? null,
    },
  ]);

  const explorer = dossier.evidence.find((e) => e.registration_tx_hash)?.registration_tx_hash;
  document.integrityNote([
    "HOW A RECIPIENT CHECKS THIS WITHOUT ASKING ANYONE",
    "1. Compute the SHA-256 digest of the record as you hold it.",
    "2. Compare it with the digest scheduled for that exhibit at Annexure B. They must be identical.",
    "3. Look up the transaction identifier for that exhibit on the network named above. The digest " +
      "recorded in it must be the same digest, and its timestamp must precede every later step.",
    explorer && explorerUrl(explorer)
      ? `A transaction from this case may be inspected at ${explorerUrl(explorer)}`
      : "On a private or local network, the transactions are inspected through the node operated by the court.",
    "If step 1 and step 2 disagree, the record you hold is not the record that was collected. " +
      "Nothing in this document, and no assurance from the prosecution, should persuade you otherwise.",
  ]);
}
