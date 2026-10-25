import PDFDocument from "pdfkit";
import { POLICE_SEAL, istDateTimeSeconds, pdfAsset } from "./format";
import QRCode from "qrcode";
import type { PublicPassport } from "../../services/passport/passport.service";

/**
 * The Evidence Integrity Passport as a printable PDF.
 *
 * One page in the ordinary case. Helvetica rather than the Times used for court
 * filings: this is a certificate meant to be read by anyone, often on a phone
 * after scanning its QR code, and a sans face survives being shrunk.
 *
 * No coordinates appear in any version of this document. The authorised edition
 * adds capture quality — source, GPS status and accuracy, device time and clock
 * skew — but where an item was captured is shown only inside the portal.
 */

const A4 = { width: 595.28, height: 841.89 };
const M = 48;
const W = A4.width - 2 * M;

const INK = {
  text: "#13201a",
  muted: "#55655c",
  faint: "#8a978f",
  rule: "#d9e2dc",
  brand: "#0b7a45",
  saffron: "#c4600f",
  danger: "#b3261e",
  panel: "#f3f7f4",
};

export interface CaptureDetail {
  source: string;
  purpose: string;
  deviceTime: string | null;
  serverReceivedAt: string | null;
  clockSkewSeconds: number | null;
  clockSkewFlagged: boolean;
  gpsStatus: string | null;
  accuracyMetres: number | null;
  mocked: boolean | null;
  signatureStatus: string;
  durationMs: number | null;
  fileSha256: string;
  manifestHash: string | null;
}

const FLAG_TEXT: Record<string, string> = {
  NOT_ANCHORED: "Not yet anchored on the blockchain.",
  CHAIN_UNREADABLE: "The blockchain could not be read when this was generated; values are the database's copy.",
  RECORD_DISAGREES_WITH_CHAIN: "The database record differs from the blockchain. The blockchain value is shown.",
  MISMATCH_RECORDED_ON_CHAIN: "At least one failed integrity check is recorded on the blockchain for this item.",
};

function when(value: string | null | undefined): string {
  if (!value) return "—";
  return istDateTimeSeconds(value);
}

export async function buildPassportPdf(
  passport: PublicPassport,
  options: { verifyUrl: string; capture?: CaptureDetail | null; generatedFor?: string }
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    bufferPages: true,
    margins: { top: M, bottom: M, left: M, right: M },
    info: {
      Title: `Evidence Integrity Passport ${passport.reference}`,
      Author: "NyaySetu",
      Subject: "Evidence integrity passport",
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const qr = await QRCode.toBuffer(options.verifyUrl, { errorCorrectionLevel: "M", margin: 1, width: 240, color: { dark: "#13201a", light: "#ffffff" } });

  // ------------------------------------------------------------ header band
  doc.rect(0, 0, A4.width, 6).fill(INK.brand);
  doc.rect(A4.width * 0.62, 0, A4.width * 0.38, 6).fill(INK.saffron);

  doc.fillColor(INK.brand).font("Helvetica-Bold").fontSize(9).text("NYAYSETU", M, M - 8, { characterSpacing: 2 });
  doc.fillColor(INK.text).font("Helvetica-Bold").fontSize(20).text("Evidence Integrity Passport", M, M + 6, { width: W - 190 });
  doc.fillColor(INK.muted).font("Helvetica").fontSize(9.5).text(
    options.capture ? "Authorised edition — includes capture quality. No location data." : "Public edition — no personal or case data.",
    M,
    doc.y + 2,
    { width: W - 190 }
  );
  doc.image(qr, A4.width - M - 108, M - 6, { width: 108 });
  const seal = pdfAsset(POLICE_SEAL);
  if (seal) doc.image(seal, A4.width - M - 108 - 62, M - 2, { fit: [54, 54], align: "center", valign: "center" });
  doc.fillColor(INK.faint).fontSize(7).text("Scan to verify online", A4.width - M - 108, M + 104, { width: 108, align: "center" });

  let y = Math.max(doc.y, M + 118) + 8;

  const label = (text: string, x: number, at: number, width = W) =>
    doc.fillColor(INK.faint).font("Helvetica-Bold").fontSize(7.5).text(text.toUpperCase(), x, at, { width, characterSpacing: 0.8 });
  const value = (text: string, x: number, at: number, width = W, mono = false) =>
    doc.fillColor(INK.text).font(mono ? "Courier" : "Helvetica").fontSize(mono ? 9 : 10.5).text(text, x, at, { width });

  // ------------------------------------------------------------ status panel
  const tone = passport.verified ? INK.brand : passport.state === "INTEGRITY_MISMATCH" || passport.agreement === "DISAGREES" ? INK.danger : INK.saffron;
  const status = passport.verified ? "VERIFIED ON CHAIN" : passport.state.replace(/_/g, " ");
  doc.roundedRect(M, y, W, 64, 6).fill(INK.panel);
  doc.rect(M, y, 4, 64).fill(tone);
  doc.fillColor(tone).font("Helvetica-Bold").fontSize(12).text(status, M + 16, y + 10, { width: W - 32 });
  doc.fillColor(INK.text).font("Helvetica-Bold").fontSize(9.5).text(passport.explanation.heading, M + 16, y + 28, { width: W - 32 });
  doc.fillColor(INK.muted).font("Helvetica").fontSize(8.5).text(passport.explanation.text, M + 16, y + 41, { width: W - 32, height: 22, ellipsis: true });
  y += 76;

  // ------------------------------------------------------------ identity
  label("Reference", M, y);
  value(passport.reference, M, y + 11, W / 2 - 10, true);
  label("Registered (block time)", M + W / 2, y);
  value(when(passport.registeredAt), M + W / 2, y + 11, W / 2);
  y += 36;

  label(passport.anchorMode === "manifest" ? "Anchored digest (capture manifest SHA-256)" : "Anchored digest (file SHA-256)", M, y);
  value(passport.digest ?? "—", M, y + 11, W, true);
  doc.fillColor(INK.faint).font("Helvetica").fontSize(7.5).text(
    passport.digestSource === "chain" ? "Read from the blockchain when this passport was generated." : "Database copy — the blockchain could not be read.",
    M,
    y + 24,
    { width: W }
  );
  y += 40;

  label("Transaction", M, y);
  value(passport.transaction.hash ?? "Not yet submitted", M, y + 11, W, true);
  y += 26;
  label("Network", M, y);
  value(passport.network ? `${passport.network.name} (chain ${passport.network.chainId})` : "—", M, y + 11, W / 2 - 10);
  label("Source", M + W / 2, y);
  value(
    passport.source === "capture"
      ? `Live capture through the app${passport.locationCommitted ? "; location committed in anchor" : ""}`
      : "Uploaded existing file",
    M + W / 2,
    y + 11,
    W / 2
  );
  y += 36;

  if (passport.flags.length) {
    for (const flag of passport.flags) {
      doc.fillColor(INK.danger).font("Helvetica-Bold").fontSize(8.5).text("!", M, y, { continued: true });
      doc.fillColor(INK.text).font("Helvetica").text("  " + (FLAG_TEXT[flag] ?? flag), { width: W });
      y = doc.y + 3;
    }
    y += 6;
  }

  // ------------------------------------------------------------ custody
  doc.moveTo(M, y).lineTo(M + W, y).strokeColor(INK.rule).lineWidth(0.8).stroke();
  y += 10;
  doc.fillColor(INK.text).font("Helvetica-Bold").fontSize(11).text("Chain of custody", M, y);
  y = doc.y + 6;
  const cols = [M, M + 105, M + 235, M + 360];
  ["Event", "From", "To", "Time (IST)"].forEach((h, i) => label(h, cols[i], y, i === 3 ? W - 360 : 120));
  y += 13;
  for (const event of passport.custody) {
    doc.fillColor(INK.text).font("Helvetica").fontSize(9);
    doc.text(event.type === "REGISTERED" ? "Registered" : "Custody transfer", cols[0], y, { width: 100 });
    doc.text(event.from ?? "—", cols[1], y, { width: 125 });
    doc.text(event.to, cols[2], y, { width: 120 });
    doc.text(when(event.at), cols[3], y, { width: W - 360 });
    y += 15;
  }
  if (passport.custody.length === 0) {
    doc.fillColor(INK.muted).font("Helvetica").fontSize(9).text("No custody events recorded.", M, y);
    y += 15;
  }
  y += 6;

  // ------------------------------------------------------------ capture (authorised)
  if (options.capture) {
    const c = options.capture;
    doc.moveTo(M, y).lineTo(M + W, y).strokeColor(INK.rule).stroke();
    y += 10;
    doc.fillColor(INK.text).font("Helvetica-Bold").fontSize(11).text("Capture quality", M, y);
    y = doc.y + 6;
    const rows: [string, string][] = [
      ["Purpose", c.purpose.replace(/_/g, " ")],
      ["Device time", when(c.deviceTime)],
      ["Server received", when(c.serverReceivedAt)],
      ["Clock skew", c.clockSkewSeconds === null ? "not measured" : `${c.clockSkewSeconds} s${c.clockSkewFlagged ? " — FLAGGED" : ""}`],
      ["GPS", c.gpsStatus ? `${c.gpsStatus}${c.accuracyMetres !== null ? `, ±${Math.round(c.accuracyMetres)} m` : ""}${c.mocked ? ", device reported a mock location" : ""}` : "—"],
      ["Device signature", c.signatureStatus],
      ["Duration", c.durationMs ? `${Math.round(c.durationMs / 1000)} s` : "—"],
      ["File SHA-256", c.fileSha256],
    ];
    if (c.manifestHash) rows.push(["Manifest SHA-256", c.manifestHash]);
    for (const [k, v] of rows) {
      label(k, M, y + 1, 120);
      value(v, M + 125, y, W - 125, k.includes("SHA"));
      y = doc.y + 4;
    }
    y += 4;
  }

  // ------------------------------------------------------------ how to verify
  if (y > A4.height - 230) {
    doc.addPage();
    y = M;
  }
  doc.moveTo(M, y).lineTo(M + W, y).strokeColor(INK.rule).stroke();
  y += 10;
  doc.fillColor(INK.text).font("Helvetica-Bold").fontSize(11).text("Verify it yourself", M, y);
  y = doc.y + 4;
  const steps =
    passport.anchorMode === "manifest"
      ? [
          `Open ${options.verifyUrl} (or scan the QR code) and drop the photograph or recording into the check box. It is hashed in your browser; the file is not uploaded.`,
          "For a live capture the blockchain holds the digest of the capture manifest, which contains the file's digest. The check substitutes your file's digest into the recorded manifest and compares the result with the blockchain.",
          "Independently: look up the transaction on a block explorer and compare the fileHash in the EvidenceRegistered event with the digest above.",
        ]
      : [
          `Open ${options.verifyUrl} (or scan the QR code) and drop the file into the check box. It is hashed in your browser; the file is not uploaded.`,
          "Independently: compute the file's SHA-256 with any tool (for example `sha256sum` or `Get-FileHash`) and compare it with the digest above.",
          "Then look up the transaction on a block explorer and confirm the fileHash in the EvidenceRegistered event is the same digest.",
        ];
  steps.forEach((step, i) => {
    doc.fillColor(INK.brand).font("Helvetica-Bold").fontSize(9).text(`${i + 1}.`, M, y, { width: 14 });
    doc.fillColor(INK.text).font("Helvetica").fontSize(9).text(step, M + 16, y, { width: W - 16 });
    y = doc.y + 4;
  });
  y += 6;

  // ------------------------------------------------------------ limits
  const limitsHeight = doc.heightOfString(passport.limits, { width: W - 28 }) + 30;
  doc.roundedRect(M, y, W, limitsHeight, 6).lineWidth(1).strokeColor(INK.saffron).stroke();
  doc.fillColor(INK.saffron).font("Helvetica-Bold").fontSize(8.5).text("LIMITS OF WHAT THIS PROVES", M + 14, y + 10, { characterSpacing: 0.6 });
  doc.fillColor(INK.text).font("Helvetica").fontSize(9).text(passport.limits, M + 14, y + 23, { width: W - 28 });

  // ------------------------------------------------------------ footer
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // The footer sits inside the bottom margin; without lifting it, pdfkit would
    // decide the text overflows and start a blank page.
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fillColor(INK.faint).font("Helvetica").fontSize(7).text(
      `Generated ${when(passport.checkedAt)}${options.generatedFor ? ` for ${options.generatedFor}` : ""}. This passport reflects the record at that moment; the live page is authoritative.   Page ${i + 1} of ${range.count}`,
      M,
      A4.height - M + 14,
      { width: W, align: "center", lineBreak: false }
    );
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}
