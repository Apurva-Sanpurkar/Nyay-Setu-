import PDFDocument from "pdfkit";
import { pdfAsset } from "./format";

/**
 * The typographic engine behind every document this system issues.
 *
 * WHY PDFKIT AND NOT HTML-TO-PDF
 *   A headless browser would let the same CSS produce the page, and would also put
 *   a 300MB Chromium on the critical path of filing a charge sheet. pdfkit is pure
 *   JavaScript, starts instantly and runs on a free container, which matters
 *   because a document that cannot be produced when the court asks for it is not a
 *   document. The cost is that tables have to be measured by hand; see row().
 *
 * WHY TIMES
 *   Not preference. Indian court filings are set in Times, and a report that looks
 *   unlike every other paper in the file invites the question of whether it belongs
 *   there. Times-Roman is also one of the fourteen fonts every PDF reader is
 *   required to have, so no font is embedded and nothing can substitute badly.
 *
 * WHY THE MEASUREMENTS ARE IN POINTS
 *   PDF's own unit. 72 to the inch, so A4 is 595 x 842 and a 56pt margin is very
 *   nearly the 2cm a registry expects.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = { top: 54, bottom: 62, left: 56, right: 56 };
const CONTENT_WIDTH = A4.width - MARGIN.left - MARGIN.right;

const FONT = {
  body: "Times-Roman",
  bold: "Times-Bold",
  italic: "Times-Italic",
  boldItalic: "Times-BoldItalic",
  /** Hashes and transaction ids only. A digest in a serif face is unreadable. */
  mono: "Courier",
  monoBold: "Courier-Bold",
} as const;

const SIZE = { title: 15, subtitle: 10.5, heading: 11.5, body: 10, small: 8.5, tiny: 7.5 } as const;

const INK = {
  text: "#000000",
  muted: "#444444",
  faint: "#6b6b6b",
  rule: "#000000",
  hairline: "#9a9a9a",
  /** Used only for the integrity banner, never for body text. */
  seal: "#00622f",
} as const;

function asset(name: string): string | null {
  return pdfAsset(name);
}

export interface DocumentMeta {
  /** "FINAL REPORT / CHARGE SHEET". Appears once, large, on the first page. */
  title: string;
  /** The provision it is issued under, set below the title in italics. */
  authority: string;
  /** Short form for the running header on later pages, e.g. "Final Report". */
  shortTitle: string;
  /** Right side of the running header, e.g. "C.R. No. 280/2014". */
  fileReference: string;
  /** Sits under the crests: the issuing court or station. */
  issuedBy: string;
  district?: string;
}

export interface Column {
  header: string;
  width: number;
  align?: "left" | "center" | "right";
  /** Courier for digests, so 0 and O are distinguishable. */
  mono?: boolean;
}

/**
 * One document being written.
 *
 * Wraps pdfkit rather than extending it so the page furniture — the rule under
 * the letterhead, the running header, the footer with its page count — is applied
 * in exactly one place and cannot be forgotten by a caller adding a section.
 */
export class CourtDocument {
  readonly doc: PDFKit.PDFDocument;
  private readonly meta: DocumentMeta;
  private finished = false;

  constructor(meta: DocumentMeta) {
    this.meta = meta;
    this.doc = new PDFDocument({
      size: [A4.width, A4.height],
      margins: MARGIN,
      // Required to write "Page 2 of 7": the total is only known at the end, so
      // every page is held until then and the footers are stamped in one pass.
      bufferPages: true,
      info: {
        Title: `${meta.title} — ${meta.fileReference}`,
        Author: meta.issuedBy,
        Subject: meta.authority,
        Creator: "NyaySetu",
        Producer: "NyaySetu",
      },
    });

    this.doc.font(FONT.body).fontSize(SIZE.body).fillColor(INK.text);
    this.letterhead();
  }

  /* ------------------------------------------------------------- furniture */

  /**
   * The crests and the caption, on the first page only.
   *
   * Two seals, because the document has two authorities behind it: the police
   * force that issues it, and the system that anchored the evidence it relies on.
   * Claiming only one would misrepresent it either way.
   */
  private letterhead(): void {
    const top = this.doc.y;
    const sealSize = 52;

    const police = asset("seal-maharashtra-police.png");
    const nyaysetu = asset("seal-nyaysetu.png");

    // NyaySetu's mark at the top left; the issuing force's seal at the top right.
    if (nyaysetu) this.doc.image(nyaysetu, MARGIN.left, top, { fit: [sealSize, sealSize], align: "center", valign: "center" });
    if (police) {
      this.doc.image(police, A4.width - MARGIN.right - sealSize, top, { fit: [sealSize, sealSize], align: "center", valign: "center" });
    }

    const innerLeft = MARGIN.left + sealSize + 14;
    const innerWidth = CONTENT_WIDTH - 2 * (sealSize + 14);

    this.doc
      .font(FONT.bold)
      .fontSize(12)
      .fillColor(INK.text)
      .text("MAHARASHTRA POLICE", innerLeft, top + 2, { width: innerWidth, align: "center" });

    this.doc
      .font(FONT.body)
      .fontSize(SIZE.small)
      .fillColor(INK.muted)
      .text(this.meta.issuedBy, innerLeft, this.doc.y + 1, { width: innerWidth, align: "center" });

    if (this.meta.district) {
      this.doc
        .fontSize(SIZE.tiny)
        .text(`District ${this.meta.district}`, innerLeft, this.doc.y + 1, {
          width: innerWidth,
          align: "center",
        });
    }

    // A double rule: the convention on Indian official letterheads, and it marks
    // where the form proper begins.
    const ruleY = Math.max(this.doc.y, top + sealSize) + 8;
    this.rule(ruleY, 1.1);
    this.rule(ruleY + 2.6, 0.4);

    this.doc.y = ruleY + 12;

    this.doc
      .font(FONT.bold)
      .fontSize(SIZE.title)
      .fillColor(INK.text)
      .text(this.meta.title.toUpperCase(), MARGIN.left, this.doc.y, {
        width: CONTENT_WIDTH,
        align: "center",
        characterSpacing: 0.6,
      });

    this.doc
      .font(FONT.italic)
      .fontSize(SIZE.subtitle)
      .fillColor(INK.muted)
      .text(this.meta.authority, MARGIN.left, this.doc.y + 2, {
        width: CONTENT_WIDTH,
        align: "center",
      });

    this.doc.y += 14;
    this.doc.font(FONT.body).fontSize(SIZE.body).fillColor(INK.text);
  }

  private rule(y: number, thickness = 0.6, colour: string = INK.rule): void {
    this.doc
      .save()
      .lineWidth(thickness)
      .strokeColor(colour)
      .moveTo(MARGIN.left, y)
      .lineTo(A4.width - MARGIN.right, y)
      .stroke()
      .restore();
  }

  /** Space left on the page. Callers use it to decide whether to break first. */
  private get remaining(): number {
    return A4.height - MARGIN.bottom - this.doc.y;
  }

  /**
   * Starts a page, with the running header.
   *
   * Every break goes through here. pdfkit will also break implicitly when text
   * overflows, which is why the header is stamped in the footer pass instead of
   * being written here — see finalise().
   */
  newPage(): void {
    this.doc.addPage({ size: [A4.width, A4.height], margins: MARGIN });
  }

  /** Breaks only if what is coming will not fit, so pages do not end in a stub. */
  ensure(space: number): void {
    if (this.remaining < space) this.newPage();
  }

  /* --------------------------------------------------------------- content */

  /** A numbered form item: "4. Provision". The spine of an Indian court form. */
  item(number: string, label: string): void {
    this.ensure(34);
    this.doc.moveDown(0.45);
    this.doc
      .font(FONT.bold)
      .fontSize(SIZE.body)
      .fillColor(INK.text)
      .text(`${number}. ${label}`, MARGIN.left, this.doc.y, { width: CONTENT_WIDTH });
    this.doc.font(FONT.body);
  }

  /** A section heading for an annexure. Ruled, because it starts a new document. */
  heading(text: string, options: { rule?: boolean } = {}): void {
    this.ensure(56);
    this.doc.moveDown(0.7);
    this.doc
      .font(FONT.bold)
      .fontSize(SIZE.heading)
      .fillColor(INK.text)
      .text(text.toUpperCase(), MARGIN.left, this.doc.y, {
        width: CONTENT_WIDTH,
        characterSpacing: 0.4,
      });
    if (options.rule !== false) this.rule(this.doc.y + 3, 0.7);
    this.doc.y += 9;
    this.doc.font(FONT.body).fontSize(SIZE.body);
  }

  /**
   * A label and its value on one line, with the colons aligned.
   *
   * Aligned because the form is read by eye against a printed template, and a
   * ragged column of colons makes a filled form look like a draft.
   */
  field(label: string, value: string | null | undefined, options: { indent?: number; mono?: boolean } = {}): void {
    const indent = options.indent ?? 14;
    const labelWidth = 186;
    const text = value === null || value === undefined || value === "" ? "—" : String(value);

    const valueWidth = CONTENT_WIDTH - indent - labelWidth - 10;
    // Both sides may wrap; the taller one sets the row, so a long label can never
    // run into the next item.
    const labelHeight = this.doc.font(FONT.body).fontSize(SIZE.body).heightOfString(label, { width: labelWidth - 6 });
    const height = Math.max(
      labelHeight,
      this.doc
        .font(options.mono ? FONT.mono : FONT.body)
        .fontSize(options.mono ? SIZE.small : SIZE.body)
        .heightOfString(text, { width: valueWidth })
    );

    this.ensure(height + 8);
    const y = this.doc.y;

    this.doc
      .font(FONT.body)
      .fontSize(SIZE.body)
      .fillColor(INK.muted)
      .text(label, MARGIN.left + indent, y, { width: labelWidth - 6 });

    this.doc
      .fillColor(INK.text)
      .text(":", MARGIN.left + indent + labelWidth, y, { width: 8, lineBreak: false });

    this.doc
      .font(options.mono ? FONT.mono : FONT.body)
      .fontSize(options.mono ? SIZE.small : SIZE.body)
      .text(text, MARGIN.left + indent + labelWidth + 10, y, { width: valueWidth });

    this.doc.y = Math.max(this.doc.y, y + height) + 1.5;
    this.doc.font(FONT.body).fontSize(SIZE.body).fillColor(INK.text);
  }

  /** A paragraph of prose. Justified, as a narrative section of a report is. */
  paragraph(text: string, options: { indent?: number; italic?: boolean; size?: number } = {}): void {
    const indent = options.indent ?? 14;
    const width = CONTENT_WIDTH - indent;
    const size = options.size ?? SIZE.body;

    this.doc.font(options.italic ? FONT.italic : FONT.body).fontSize(size).fillColor(INK.text);
    const height = this.doc.heightOfString(text, { width, align: "justify" });
    this.ensure(Math.min(height, 120) + 6);

    this.doc.text(text, MARGIN.left + indent, this.doc.y, { width, align: "justify" });
    this.doc.moveDown(0.35);
    this.doc.font(FONT.body).fontSize(SIZE.body);
  }

  /** A hash, CID or transaction id, on its own line and selectable as one run. */
  digest(label: string, value: string | null | undefined): void {
    this.field(label, value ?? "not recorded", { mono: true });
  }

  /* ---------------------------------------------------------------- tables */

  /**
   * A table, measured by hand.
   *
   * pdfkit has no table primitive, so every row is measured before it is drawn:
   * the tallest wrapped cell sets the row height, and a row that will not fit
   * moves whole to the next page with the header repeated. Splitting a row across
   * a page break in an evidentiary schedule would be worse than a short page,
   * because a reader would see a hash with no exhibit beside it.
   */
  table(columns: Column[], rows: (string | null | undefined)[][], options: { fontSize?: number } = {}): void {
    const size = options.fontSize ?? SIZE.small;
    const padding = 4;
    const total = columns.reduce((sum, c) => sum + c.width, 0);
    const scale = CONTENT_WIDTH / total;
    const widths = columns.map((c) => c.width * scale);

    const drawHeader = () => {
      const y = this.doc.y;
      const heights = columns.map((c, i) =>
        this.doc.font(FONT.bold).fontSize(size).heightOfString(c.header, { width: widths[i] - 2 * padding })
      );
      const height = Math.max(...heights) + 2 * padding;

      this.doc.save().rect(MARGIN.left, y, CONTENT_WIDTH, height).fillColor("#eeeeee").fill().restore();

      let x = MARGIN.left;
      columns.forEach((c, i) => {
        this.doc
          .font(FONT.bold)
          .fontSize(size)
          .fillColor(INK.text)
          .text(c.header, x + padding, y + padding, {
            width: widths[i] - 2 * padding,
            align: c.align ?? "left",
          });
        x += widths[i];
      });

      this.doc.y = y + height;
      this.gridLine(y, height, widths);
    };

    this.ensure(64);
    drawHeader();
    if (rows.length === 0) rows = [["None recorded", ...columns.slice(1).map(() => "")]];

    for (const row of rows) {
      const cells = columns.map((_, i) => {
        const raw = row[i];
        return raw === null || raw === undefined || raw === "" ? "—" : String(raw);
      });

      const heights = cells.map((cell, i) =>
        this.doc
          .font(columns[i].mono ? FONT.mono : FONT.body)
          .fontSize(columns[i].mono ? size - 0.7 : size)
          .heightOfString(cell, { width: widths[i] - 2 * padding })
      );
      const height = Math.max(...heights) + 2 * padding;

      if (this.remaining < height + 12) {
        this.newPage();
        drawHeader();
      }

      const y = this.doc.y;
      let x = MARGIN.left;
      cells.forEach((cell, i) => {
        this.doc
          .font(columns[i].mono ? FONT.mono : FONT.body)
          .fontSize(columns[i].mono ? size - 0.7 : size)
          .fillColor(INK.text)
          .text(cell, x + padding, y + padding, {
            width: widths[i] - 2 * padding,
            align: columns[i].align ?? "left",
          });
        x += widths[i];
      });

      this.doc.y = y + height;
      this.gridLine(y, height, widths);
    }

    this.doc.moveDown(0.4);
    this.doc.font(FONT.body).fontSize(SIZE.body);
  }

  /** The box and the verticals for one table row. */
  private gridLine(y: number, height: number, widths: number[]): void {
    this.doc.save().lineWidth(0.4).strokeColor(INK.hairline);
    this.doc.rect(MARGIN.left, y, CONTENT_WIDTH, height).stroke();

    let x = MARGIN.left;
    for (const width of widths.slice(0, -1)) {
      x += width;
      this.doc.moveTo(x, y).lineTo(x, y + height).stroke();
    }
    this.doc.restore();
  }

  /* ------------------------------------------------------------ endorsement */

  /**
   * The signature blocks an Indian final report ends with.
   *
   * Left blank on purpose. Printing a name where a signature belongs, or worse
   * rendering an image of one, would be a forged endorsement — the document is
   * produced by software and signed by a person, and the page has to make which is
   * which unambiguous.
   */
  endorsement(blocks: { role: string; name?: string | null; designation?: string | null }[]): void {
    this.ensure(120);
    this.doc.moveDown(1.6);

    const width = CONTENT_WIDTH / blocks.length;
    const top = this.doc.y;
    let deepest = top;

    blocks.forEach((block, index) => {
      const x = MARGIN.left + index * width;
      let y = top;

      this.doc
        .font(FONT.body)
        .fontSize(SIZE.small)
        .fillColor(INK.muted)
        .text(block.role, x, y, { width: width - 16 });
      y = this.doc.y + 34;

      this.doc
        .save()
        .lineWidth(0.5)
        .strokeColor(INK.text)
        .moveTo(x, y)
        .lineTo(x + width - 26, y)
        .stroke()
        .restore();

      this.doc
        .font(FONT.body)
        .fontSize(SIZE.small)
        .fillColor(INK.text)
        .text(`Name: ${block.name ?? ""}`, x, y + 4, { width: width - 16 });
      this.doc.text(`Designation: ${block.designation ?? ""}`, x, this.doc.y + 1, {
        width: width - 16,
      });
      this.doc.font(FONT.italic).fontSize(SIZE.tiny).fillColor(INK.faint);
      this.doc.text("Signature and seal", x, this.doc.y + 2, { width: width - 16 });

      deepest = Math.max(deepest, this.doc.y);
    });

    this.doc.y = deepest + 6;
    this.doc.font(FONT.body).fontSize(SIZE.body).fillColor(INK.text);
  }

  /**
   * The integrity note.
   *
   * Every document this system issues carries one, because a printed page is the
   * one form in which the evidence chain is invisible. It says where the digests
   * came from and how a recipient checks them without asking the prosecution
   * anything — which is the whole claim the platform makes.
   */
  integrityNote(lines: string[]): void {
    this.ensure(92);
    this.doc.moveDown(0.8);

    const y = this.doc.y;
    const padding = 9;

    this.doc.font(FONT.italic).fontSize(SIZE.tiny).fillColor(INK.text);
    const height =
      lines.reduce(
        (sum, line) => sum + this.doc.heightOfString(line, { width: CONTENT_WIDTH - 2 * padding }) + 2,
        0
      ) + 2 * padding;

    this.doc.save().lineWidth(0.5).strokeColor(INK.seal);
    this.doc.rect(MARGIN.left, y, CONTENT_WIDTH, height).stroke().restore();

    let cursor = y + padding;
    for (const line of lines) {
      this.doc.text(line, MARGIN.left + padding, cursor, { width: CONTENT_WIDTH - 2 * padding });
      cursor = this.doc.y + 2;
    }

    this.doc.y = y + height + 4;
    this.doc.font(FONT.body).fontSize(SIZE.body).fillColor(INK.text);
  }

  /* --------------------------------------------------------------- closing */

  /**
   * Stamps the running header and footer on every page, then closes the stream.
   *
   * Done at the end because "Page 2 of 7" cannot be written before the seventh
   * page exists, and because pdfkit breaks pages implicitly when text overflows —
   * so a header written on the way through would be missing from exactly the pages
   * the author did not create deliberately.
   */
  finalise(): void {
    if (this.finished) return;
    this.finished = true;

    const range = this.doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      this.doc.switchToPage(range.start + i);

      // The header and the footer sit OUTSIDE the margin box by design, and pdfkit
      // adds a page whenever text is placed past the bottom margin. Writing a
      // footer would therefore create a page, whose own footer would create
      // another: the first version of this produced eighteen pages for a six page
      // report. Collapsing the margins for the duration is what stops that.
      const margins = { ...this.doc.page.margins };
      this.doc.page.margins = { top: 0, bottom: 0, left: margins.left, right: margins.right };

      if (i > 0) {
        this.doc
          .font(FONT.body)
          .fontSize(SIZE.tiny)
          .fillColor(INK.faint)
          .text(this.meta.shortTitle, MARGIN.left, 30, {
            width: CONTENT_WIDTH / 2,
            lineBreak: false,
          });
        this.doc.text(this.meta.fileReference, MARGIN.left + CONTENT_WIDTH / 2, 30, {
          width: CONTENT_WIDTH / 2,
          align: "right",
          lineBreak: false,
        });
        this.rule(42, 0.4, INK.hairline);
      }

      const footerY = A4.height - MARGIN.bottom + 16;
      this.rule(footerY - 8, 0.4, INK.hairline);

      this.doc
        .font(FONT.body)
        .fontSize(SIZE.tiny)
        .fillColor(INK.faint)
        .text("Generated by NyaySetu. Not valid without the endorsement above.", MARGIN.left, footerY, {
          width: CONTENT_WIDTH * 0.7,
          lineBreak: false,
        });

      this.doc.text(`Page ${i + 1} of ${range.count}`, MARGIN.left + CONTENT_WIDTH * 0.7, footerY, {
        width: CONTENT_WIDTH * 0.3,
        align: "right",
        lineBreak: false,
      });

      this.doc.page.margins = margins;
    }

    this.doc.end();
  }

  /**
   * The finished bytes.
   *
   * Buffered rather than streamed straight to the response, because the digest of
   * the document is recorded in the audit trail and that cannot be computed until
   * the last byte exists.
   */
  toBuffer(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      this.doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      this.doc.on("end", () => resolve(Buffer.concat(chunks)));
      this.doc.on("error", reject);
      this.finalise();
    });
  }
}

export { FONT, SIZE, INK, CONTENT_WIDTH, MARGIN };
