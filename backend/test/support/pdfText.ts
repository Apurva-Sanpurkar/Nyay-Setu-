/**
 * Extracts the text of an uncompressed pdfkit document. pdfkit writes each run
 * of text as hex strings inside TJ arrays; decoding them gives the text in order.
 * Enough to assert what a document says, not a general PDF parser.
 */
export function pdfText(pdf: Buffer | ArrayBuffer): string {
  const raw = Buffer.from(pdf as ArrayBuffer).toString("latin1");
  const out: string[] = [];
  for (const block of raw.match(/BT[\s\S]*?ET/g) ?? []) {
    const runs = [...block.matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1], "hex").toString("latin1"));
    out.push(runs.join(""));
  }
  return out.join("\n");
}
