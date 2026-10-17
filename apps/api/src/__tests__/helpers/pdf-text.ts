import { inflateSync } from "node:zlib";

/**
 * Texte approximatif d'un PDF produit par @react-pdf (polices standard) : flux FlateDecode
 * décompressés, chaînes hexadécimales des opérateurs TJ/Tj décodées en latin1. Pour les tests.
 */
export function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  const chunks: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const data = pdf.subarray(start, end);
    try {
      chunks.push(inflateSync(data).toString("latin1"));
    } catch {
      /* flux non compressé ou image */
    }
    re.lastIndex = end + "endstream".length;
  }
  const text: string[] = [];
  for (const content of chunks) {
    for (const hex of content.matchAll(/<([0-9a-fA-F]+)>/g)) {
      text.push(Buffer.from(hex[1]!, "hex").toString("latin1"));
    }
    for (const lit of content.matchAll(/\(((?:\.|[^\)])*)\)\s*Tj/g)) text.push(lit[1]!);
  }
  return text.join("");
}
