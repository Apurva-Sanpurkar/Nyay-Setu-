import PDFDocument from "pdfkit";
import { POLICE_SEAL, istDateTime, pdfAsset } from "./format";

/**
 * A formal, court-style document from an editable template: letterhead, title,
 * reference block, numbered sections, ruled tables, digests, signature blocks
 * and a footer on every page. Used for the Section 63 certificate (F11), the
 * seizure memo and the chain-of-custody form (F13).
 *
 * Content streams are left uncompressed. These are short text documents, and an
 * uncompressed stream means the digests printed in them can be found by anyone
 * with a text tool — which is how the tests check them, and how a sceptic could.
 */

const A4 = { width: 595.28, height: 841.89 };
const M = 56;
const W = A4.width - 2 * M;
const FOOTER_SPACE = 48;
const INK = "#111111";
const MUTED = "#4a4a4a";
const RULE = "#9a9a9a";
const SHADE = "#efefef";
const BRAND = "#04694c";

export interface TemplateDocument {
  title: string;
  reference?: string | null;
  subtitle?: string | null;
  /** Issuing office printed in the letterhead, e.g. "Shivajinagar Police Station". */
  issuer?: string | null;
  sections: { heading: string; body: string }[];
  tables?: { heading: string; columns: string[]; widths: number[]; rows: string[][]; emptyText?: string }[];
  digestLines?: [string, string][];
  signatures?: { role: string; name: string | null; designation: string | null }[];
  footer: string;
  /** When the document was produced; defaults to now. */
  generatedAt?: string | Date;
}

/** Long unbroken tokens (digests, references) make justified text gape. */
function hasLongToken(text: string): boolean {
  return /\S{28,}/.test(text);
}

/** Digest-like cells are set in a smaller monospace face so they fit. */
function isDigest(text: string): boolean {
  return /^0x[0-9a-f]{12,}/i.test(text.trim()) || /^NSE-[0-9A-Z]{10,}$/.test(text.trim());
}

export async function buildTemplatePdf(input: TemplateDocument): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    compress: false,
    bufferPages: true,
    margins: { top: M, bottom: M + FOOTER_SPACE - 20, left: M, right: M },
    info: { Title: input.title, Author: "NyaySetu", Subject: input.reference ?? input.title },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));
  const bottomLimit = () => A4.height - M - FOOTER_SPACE;
  const ensureSpace = (needed: number) => {
    if (doc.y + needed > bottomLimit()) doc.addPage();
  };

  /* -------------------------------------------------------- letterhead */
  doc.rect(0, 0, A4.width, 6).fill(BRAND);
  doc
    .font("Helvetica-Bold")
    .fontSize(8.5)
    .fillColor(BRAND)
    .text("NYAYSETU", M, M - 18, { characterSpacing: 2, continued: false });
  const seal = pdfAsset(POLICE_SEAL);
  const sealSize = 40;
  if (seal) doc.image(seal, M + W - sealSize, M - 32, { fit: [sealSize, sealSize], align: "right", valign: "center" });
  if (input.issuer) {
    doc
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(input.issuer, M, M - 18, { width: W - (seal ? sealSize + 10 : 0), align: "right" });
  }
  doc.moveTo(M, M + 12).lineTo(M + W, M + 12).strokeColor(INK).lineWidth(0.8).stroke();
  doc.y = M + 24;
  doc.x = M;

  /* ------------------------------------------------------------- title */
  doc.font("Times-Bold").fontSize(15).fillColor(INK).text(input.title, M, doc.y, { width: W, align: "center" });
  if (input.subtitle) doc.moveDown(0.25).font("Times-Italic").fontSize(10.5).fillColor(MUTED).text(input.subtitle, { width: W, align: "center" });
  doc.moveDown(0.8);

  // Reference block: what this document is, and when it was produced.
  const blockTop = doc.y;
  const rows: [string, string][] = [];
  if (input.reference) rows.push(["Reference", input.reference]);
  rows.push(["Generated", istDateTime(input.generatedAt ?? new Date())]);
  const blockHeight = rows.length * 14 + 10;
  doc.rect(M, blockTop, W, blockHeight).fillAndStroke("#f7f7f7", "#d0d0d0");
  rows.forEach(([label, value], i) => {
    const y = blockTop + 6 + i * 14;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED).text(label.toUpperCase(), M + 10, y + 1, { width: 90, characterSpacing: 0.6 });
    doc.font(isDigest(value) || label === "Reference" ? "Courier" : "Times-Roman").fontSize(9.5).fillColor(INK).text(value, M + 100, y, { width: W - 110 });
  });
  doc.y = blockTop + blockHeight + 16;
  doc.x = M;

  /* ---------------------------------------------------------- sections */
  for (const section of input.sections) {
    ensureSpace(48);
    doc.font("Times-Bold").fontSize(11.5).fillColor(INK).text(section.heading, M, doc.y, { width: W });
    doc.moveDown(0.25);
    doc
      .font("Times-Roman")
      .fontSize(10.5)
      .fillColor(INK)
      .text(section.body, M, doc.y, { width: W, align: hasLongToken(section.body) ? "left" : "justify", lineGap: 2.2 });
    doc.moveDown(0.85);
  }

  /* ------------------------------------------------------------ tables */
  for (const table of input.tables ?? []) {
    ensureSpace(60);
    doc.font("Times-Bold").fontSize(11.5).fillColor(INK).text(table.heading, M, doc.y, { width: W });
    doc.moveDown(0.35);
    const scale = W / table.widths.reduce((a, b) => a + b, 0);
    const widths = table.widths.map((w) => w * scale);

    const cellFont = (text: string, header: boolean) =>
      header ? ["Helvetica-Bold", 7.8] as const : isDigest(text) ? ["Courier", 7.4] as const : ["Times-Roman", 9.3] as const;

    const measure = (cells: string[], header: boolean) =>
      Math.max(
        ...cells.map((cell, i) => {
          const [font, size] = cellFont(cell, header);
          doc.font(font).fontSize(size);
          return doc.heightOfString(header ? cell.toUpperCase() : cell, { width: widths[i] - 10 });
        })
      ) + 9;

    const drawRow = (cells: string[], header: boolean) => {
      const height = measure(cells, header);
      if (doc.y + height > bottomLimit()) {
        doc.addPage();
        if (!header) drawRow(table.columns, true);
      }
      const top = doc.y;
      if (header) doc.rect(M, top, W, height).fill(SHADE);
      let x = M;
      cells.forEach((cell, i) => {
        const [font, size] = cellFont(cell, header);
        doc
          .font(font)
          .fontSize(size)
          .fillColor(header ? MUTED : INK)
          .text(header ? cell.toUpperCase() : cell, x + 5, top + 4.5, { width: widths[i] - 10, characterSpacing: header ? 0.4 : 0 });
        x += widths[i];
      });
      doc.moveTo(M, top + height).lineTo(M + W, top + height).strokeColor(header ? RULE : "#d4d4d4").lineWidth(header ? 0.8 : 0.5).stroke();
      doc.y = top + height;
    };

    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).strokeColor(RULE).lineWidth(0.8).stroke();
    drawRow(table.columns, true);
    if (table.rows.length === 0) {
      drawRow([table.emptyText ?? "None recorded", ...table.columns.slice(1).map(() => "")], false);
    } else {
      for (const row of table.rows) drawRow(row, false);
    }
    doc.x = M;
    doc.moveDown(1);
  }

  /* ----------------------------------------------------------- digests */
  if (input.digestLines?.length) {
    ensureSpace(40 + input.digestLines.length * 26);
    doc.font("Times-Bold").fontSize(11.5).fillColor(INK).text("Digests", M, doc.y, { width: W });
    doc.moveDown(0.3);
    for (const [label, value] of input.digestLines) {
      doc.font("Times-Roman").fontSize(9.5).fillColor(MUTED).text(label, M, doc.y, { width: W });
      doc.font("Courier").fontSize(8.6).fillColor(INK).text(value, M, doc.y, { width: W });
      doc.moveDown(0.35);
    }
    doc.moveDown(0.6);
  }

  /* -------------------------------------------------------- signatures */
  if (input.signatures?.length) {
    const perRow = input.signatures.length === 3 ? 3 : 2;
    const gap = perRow === 3 ? 18 : 28;
    const columnWidth = (W - gap * (perRow - 1)) / perRow;
    const blockHeight = 104;
    // Blank lines sized to the column, so nothing wraps.
    const blank = "_".repeat(perRow === 3 ? 15 : 26);
    for (let start = 0; start < input.signatures.length; start += perRow) {
      ensureSpace(blockHeight + 10);
      doc.moveDown(start === 0 ? 0.8 : 0.3);
      const top = doc.y;
      input.signatures.slice(start, start + perRow).forEach((signature, index) => {
        const x = M + index * (columnWidth + gap);
        doc.moveTo(x, top + 30).lineTo(x + columnWidth, top + 30).strokeColor(INK).lineWidth(0.6).stroke();
        doc.font("Helvetica").fontSize(7.5).fillColor(MUTED).text("SIGNATURE", x, top + 34, { width: columnWidth, characterSpacing: 0.6 });
        doc.font("Times-Bold").fontSize(10).fillColor(INK).text(signature.role, x, top + 46, { width: columnWidth });
        const line = (label: string, value: string | null) =>
          doc.font("Times-Roman").fontSize(9.5).fillColor(INK).text(`${label}: ${value ?? blank}`, x, doc.y + 1.2, { width: columnWidth });
        line("Name", signature.name);
        line("Designation", signature.designation);
        line("Date", null);
        line("Place", null);
      });
      doc.y = top + blockHeight;
      doc.x = M;
    }
  }

  /* ------------------------------------------------------------ footer */
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = A4.height - M + 2;
    doc.moveTo(M, y - 6).lineTo(M + W, y - 6).strokeColor("#c8c8c8").lineWidth(0.5).stroke();
    doc.font("Times-Italic").fontSize(7.8).fillColor(MUTED).text(input.footer, M, y, { width: W - 70, align: "left" });
    doc.font("Times-Roman").fontSize(8).fillColor(MUTED).text(`Page ${i + 1} of ${range.count}`, M + W - 70, y, { width: 70, align: "right" });
    doc.page.margins.bottom = bottom;
  }

  doc.end();
  return done;
}
